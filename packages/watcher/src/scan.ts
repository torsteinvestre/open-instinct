/**
 * [sunshine:watcher] One news check: fetch every search, keep headlines from the last day that
 * were not looked at before, ask the sieve which are about their topic, and return the short list.
 * Every step here is code; nothing decides importance. When the sieve is missing or failing, a
 * small number of the newest headlines per search go through unsieved, so the agent still decides.
 */
import type { Lookup } from "@open-instinct/core";
import type { RelevanceSieve } from "./jev.js";
import { fetchHeadlines, type Headline } from "./news.js";
import type { CheckSummary, WatchStore } from "./store.js";

export interface Candidate extends Headline {
  /** Sieve probability; undefined when the headline went through unsieved. */
  p?: number;
}

export interface ScanOptions {
  store: WatchStore;
  sieve?: RelevanceSieve;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => Date;
  /** Sieve probability a headline needs to pass. Low on purpose: doubtful ones go to the agent. */
  threshold?: number;
  /** Headlines per search the sieve looks at, newest first. */
  perSearchMax?: number;
  /** Headlines per search that go through when the sieve cannot run. */
  unsievedPerSearch?: number;
  /** Size of the short list. */
  totalMax?: number;
  /** Max age of a headline. A little over a day, so a check twice a day misses nothing. */
  maxAgeHours?: number;
  concurrency?: number;
}

export interface ScanResult {
  summary: CheckSummary;
  candidates: Candidate[];
}

export const DEFAULTS = { threshold: 0.3, perSearchMax: 30, unsievedPerSearch: 6, totalMax: 30, maxAgeHours: 26, concurrency: 4 };

/** The keys a headline is remembered by: its link and its wording, so a re-post is a repeat too. */
export function headlineKeys(h: { link: string; title: string }): string[] {
  const words = h.title.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 140);
  return [`l:${h.link}`, `t:${words}`];
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

export async function runScan(opts: ScanOptions, signal?: AbortSignal): Promise<ScanResult> {
  const cfg = { ...DEFAULTS, ...definedOnly(opts) };
  const now = (opts.now ?? (() => new Date()))();
  const state = opts.store.read();
  const summary: CheckSummary = {
    at: now.toISOString(),
    searches: state.searches.length,
    fetched: 0,
    fresh: 0,
    passed: 0,
    sieve: opts.sieve ? "jev" : "none",
    jevInputTokens: 0,
    errors: [],
  };
  const known = new Set(Object.keys(state.seen));
  const minTime = now.getTime() - cfg.maxAgeHours * 3600_000;
  const looked: string[] = [];
  const candidates: Candidate[] = [];
  let sieveFailures = 0;
  let sieveCalls = 0;

  for (const search of state.searches) {
    let headlines: Headline[];
    try {
      headlines = await fetchHeadlines(search, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.lookup ? { lookup: opts.lookup } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    summary.fetched += headlines.length;
    const fresh = headlines
      .filter((h) => !h.publishedAt || Date.parse(h.publishedAt) >= minTime)
      .filter((h) => {
        const keys = headlineKeys(h);
        if (keys.some((k) => known.has(k))) return false;
        for (const k of keys) known.add(k); // a repeat within this check is skipped too
        return true;
      })
      .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") || 0)
      .slice(0, cfg.perSearchMax);
    summary.fresh += fresh.length;

    if (!opts.sieve) {
      const through = fresh.slice(0, cfg.unsievedPerSearch);
      for (const h of through) looked.push(...headlineKeys(h));
      candidates.push(...through);
      continue;
    }
    const sieve = opts.sieve;
    const results = await pool(fresh, cfg.concurrency, async (h) => {
      try {
        return await sieve.relevance(search.topic, h, signal);
      } catch {
        return undefined;
      }
    });
    sieveCalls += fresh.length;
    const failed = fresh.filter((_, i) => results[i] === undefined);
    sieveFailures += failed.length;
    fresh.forEach((h, i) => {
      const r = results[i];
      if (!r) return;
      summary.jevInputTokens += r.inputTokens;
      looked.push(...headlineKeys(h));
      if (r.p >= cfg.threshold) candidates.push({ ...h, p: r.p });
    });
    // The sieve failed on this search's headlines: the newest few still reach the agent.
    for (const h of failed.slice(0, cfg.unsievedPerSearch)) {
      looked.push(...headlineKeys(h));
      candidates.push(h);
    }
  }

  if (opts.sieve && sieveFailures > 0) summary.sieve = sieveFailures === sieveCalls ? "none" : "partial";
  if (opts.sieve && sieveFailures > 0) summary.errors.push(`relevance filter failed on ${sieveFailures} of ${sieveCalls} headlines`);
  const shortlist = candidates
    .sort((a, b) => (b.p ?? 0.5) - (a.p ?? 0.5) || Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
    .slice(0, cfg.totalMax);
  summary.passed = shortlist.length;
  // Passed but cut from a full short list: not looked at yet, so the next check may still show it.
  const cut = new Set(candidates.slice(cfg.totalMax).flatMap((h) => headlineKeys(h)));

  opts.store.update((s) => {
    for (const k of looked) if (!cut.has(k)) s.seen[k] = summary.at;
    s.lastCheck = summary;
  });
  return { summary, candidates: shortlist };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
