/**
 * [sunshine:in-the-flow] What Sunshine already knows that may bear on something new, gathered by code before the agent
 * decides anything. Torstein, 2026-10-27: memory is always part of the flow, not something the agent has to think of
 * searching. His first voice note was answered with a question ("what's the event on 3 Nov?") whose answer Sunshine
 * could have seen, and the plan of 2026-10-24 ("the main model sees summaries and searches the rest") left the search
 * to the model's diligence. Town feeds the relevant part of its memory into every session for the same reason.
 *
 * For each thing the new item is about (its title, the owner's tasks, what is unclear, what was left open), the closest
 * pieces of the owner's chats and kept items by meaning and words; the item itself left out; pieces whose meaning is
 * not close enough dropped (RECALL_MIN_NEAR, measured); the best few, kept short, best first.
 */
import type { ArchiveItem, AuditLog, InstinctConfig, MeaningSearch, Piece } from "@open-instinct/core";

/**
 * A piece counts as related when its meaning is at least this close to what it is matched with (cosine of the search
 * model's vectors). Measured 2026-10-27 (scenarios/recall-calibrate.mjs, the memory trial's archive of 20 work
 * sessions): the closest piece for the 25 real questions, whose answers are in it, was 0.41-0.73; for 20 everyday
 * things it holds nothing about, 0.25-0.49. At 0.45, 24 of 25 keep their match and 1 of 20 gets a weak one; at 0.50,
 * 22 and 0. A missing piece of context costs more than an extra line marked "may bear on it". Small sets and one kind
 * of archive: to check again on a real, mixed one.
 */
export const RECALL_MIN_NEAR = 0.45;
/** Pieces put forward per query, and pieces shown in all. */
const PER_QUERY = 3;
const PIECES = 6;
/** At most this many queries are searched (the first ones: title, tasks, what is unclear). */
const QUERIES = 8;
const LINE_MAX = 300;
const LINES_PER_PIECE = 4;
/** The search model may be loading: after this, word search alone answers (it has no closeness, so fewer pieces). */
const WAIT_MS = 30_000;
const WORDS_ONLY_PIECES = 3;

const SOURCE_WORDS: Record<string, string> = { band: "heard by the band", recording: "recorded on their phone" };

export interface RecallDeps {
  meaning: MeaningSearch;
  config: InstinctConfig;
  audit?: AuditLog;
  /** Tests: shorter wait for the search model. */
  waitMs?: number;
  minNear?: number;
}

/**
 * Lines about `queries`, best first, without the item `exclude` and ([sunshine:grounding]) without chat stretches from
 * `chatsBefore` on (they are in the thread already); undefined when nothing related is kept.
 */
export type Recall = (queries: string[], opts?: { exclude?: string; chatsBefore?: number }) => Promise<string | undefined>;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export function createRecall(deps: RecallDeps): Recall {
  const tz = () => deps.config.owner.timezone || "UTC";
  const date = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  const head = (it: ArchiveItem) => {
    const what = it.title ?? it.summary?.title ?? "A conversation";
    const people = it.people?.length ? `, with ${it.people.join(", ")}` : "";
    return `[${date(it.startedAt)}] ${what} (${SOURCE_WORDS[it.source] ?? `from ${it.source}`}${people})`;
  };
  const show = (p: Piece): string => {
    const lines = p.lines.slice(0, LINES_PER_PIECE).map((l) => clip(l.replace(/\s+/g, " "), LINE_MAX));
    if (p.kind === "chat") return lines.join("\n");
    return [head(p.item), ...lines.map((l) => `  ${l}`)].join("\n");
  };
  const minNear = deps.minNear ?? RECALL_MIN_NEAR;

  return async (queries, opts = {}) => {
    const asked = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, QUERIES);
    if (asked.length === 0) return undefined;
    const other = (p: Piece) => !(p.kind === "item" && p.item.id === opts.exclude) && !(p.kind === "chat" && opts.chatsBefore !== undefined && p.ts >= opts.chatsBefore);
    const best = new Map<string, { piece: Piece; score: number }>();
    let wordsOnly = false;
    for (const q of asked) {
      let hits: Array<{ piece: Piece; score: number; near?: number }>;
      try {
        hits = wordsOnly ? await deps.meaning.searchScored(q, {}, "words") : await within(deps.meaning.searchScored(q), deps.waitMs ?? WAIT_MS);
      } catch (error) {
        deps.audit?.append({ kind: "error", detail: { recall: "word search answered instead", message: error instanceof Error ? error.message : String(error) } });
        wordsOnly = true;
        hits = await deps.meaning.searchScored(q, {}, "words");
      }
      const kept = hits.filter((h) => other(h.piece) && (wordsOnly || (h.near ?? 0) >= minNear)).slice(0, PER_QUERY);
      for (const h of kept) {
        // One entry per item (its summary or a stretch of its text), per chat stretch.
        const key = h.piece.kind === "item" ? `item:${h.piece.item.id}` : `chat:${h.piece.hash}`;
        const seen = best.get(key);
        if (!seen || h.score > seen.score) best.set(key, { piece: h.piece, score: h.score });
      }
    }
    const shown = [...best.values()].sort((a, b) => b.score - a.score).slice(0, wordsOnly ? WORDS_ONLY_PIECES : PIECES);
    deps.audit?.append({ kind: "policy", detail: { recall: { queries: asked.length, shown: shown.length, wordsOnly } } });
    return shown.length > 0 ? shown.map((s) => show(s.piece)).join("\n\n") : undefined;
  };
}
