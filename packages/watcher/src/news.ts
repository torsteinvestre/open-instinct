/**
 * [sunshine:watcher] Headlines from Google News RSS, one search per interest. Free, no key, and
 * per-country editions (Norwegian, Swedish, British, American). Dates and repeats are handled here
 * in code; the models only judge relevance and importance.
 */
import { fetchPublic, type Lookup } from "@open-instinct/core";
import type { WatchSearch } from "./store.js";

export const DEFAULT_EDITION = "en-US";
const BODY_CAP_CHARS = 2_000_000;
const FETCH_TIMEOUT_MS = 20_000;

const KNOWN_EDITIONS: Record<string, { hl: string; gl: string; ceid: string }> = {
  "en-US": { hl: "en-US", gl: "US", ceid: "US:en" },
  "en-GB": { hl: "en-GB", gl: "GB", ceid: "GB:en" },
  "no-NO": { hl: "no", gl: "NO", ceid: "NO:no" },
  "sv-SE": { hl: "sv", gl: "SE", ceid: "SE:sv" },
};

export interface Headline {
  title: string;
  source?: string;
  link: string;
  publishedAt?: string;
  topic: string;
  edition: string;
}

/** Google News parameters for an edition like "no-NO"; undefined when it is not one. */
export function editionParams(edition: string): { hl: string; gl: string; ceid: string } | undefined {
  const known = KNOWN_EDITIONS[edition];
  if (known) return known;
  const m = /^([a-z]{2})-([A-Z]{2})$/.exec(edition);
  if (!m) return undefined;
  const [, lang, country] = m as unknown as [string, string, string];
  return { hl: lang, gl: country, ceid: `${country}:${lang}` };
}

export function googleNewsUrl(query: string, edition: string): string {
  const p = editionParams(edition) ?? KNOWN_EDITIONS[DEFAULT_EDITION]!;
  const q = encodeURIComponent(`${query} when:1d`);
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(p.hl)}&gl=${p.gl}&ceid=${encodeURIComponent(p.ceid)}`;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

function tag(item: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(item);
  if (!m) return undefined;
  const inner = (m[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).replace(/\s+/g, " ").trim();
}

/** Items of an RSS feed. Titles lose the " - Source" suffix Google News appends. */
export function parseRss(xml: string): Array<{ title: string; link: string; source?: string; publishedAt?: string }> {
  const out: Array<{ title: string; link: string; source?: string; publishedAt?: string }> = [];
  for (const item of xml.split(/<item\b[^>]*>/i).slice(1)) {
    const body = item.split(/<\/item>/i)[0] ?? "";
    let title = tag(body, "title");
    const link = tag(body, "link");
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    let source = tag(body, "source");
    const suffix = / - ([^-]{1,60})$/.exec(title);
    if (suffix && (!source || suffix[1]!.trim() === source)) {
      source ??= suffix[1]!.trim();
      title = title.slice(0, suffix.index).trim();
    }
    const pub = tag(body, "pubDate");
    const at = pub ? Date.parse(pub) : NaN;
    out.push({ title, link, ...(source ? { source } : {}), ...(Number.isFinite(at) ? { publishedAt: new Date(at).toISOString() } : {}) });
  }
  return out;
}

export interface FetchNewsOptions {
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  signal?: AbortSignal;
}

/** One search's headlines. Throws with a plain reason when the feed cannot be read. */
export async function fetchHeadlines(search: WatchSearch, opts: FetchNewsOptions = {}): Promise<Headline[]> {
  const url = googleNewsUrl(search.query, search.edition);
  const signal = opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const fetched = await fetchPublic(opts.fetchImpl ?? fetch, url, {
    signal,
    ...(opts.lookup ? { lookup: opts.lookup } : {}),
    headers: { "user-agent": "open-instinct/0.1 (+https://github.com/mariagorskikh/open-instinct)", accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
  });
  if (!fetched.ok) throw new Error(`news feed for "${search.query}": ${fetched.reason}`);
  if (!fetched.res.ok) throw new Error(`news feed for "${search.query}": HTTP ${fetched.res.status}`);
  const xml = (await fetched.res.text()).slice(0, BODY_CAP_CHARS);
  return parseRss(xml).map((h) => ({ ...h, topic: search.topic, edition: search.edition }));
}
