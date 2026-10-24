/**
 * [sunshine:intake] What reached the owner from outside their chats with the agent: a conversation the
 * band heard, later an email thread, a team chat, a work session in another AI tool. One archive for
 * every source, so a search finds what was said wherever it was said (Bee, Plaud and Limitless keep
 * every transcript searchable for the same reason). Each item is kept whole, its lines as the source
 * gave them ("[12:34] Sarah: ..."), with the summary the intake writes once.
 *
 * The same rules as the owner's chat history (`history.ts`): plain text on the agent's own disk, kept
 * HISTORY_KEEP_DAYS, nothing rides along with a message unless a search brings it in, and what the
 * owner asks to forget is removed and never written back when the same item arrives again.
 */
import { createHash } from "node:crypto";
import { HISTORY_KEEP_DAYS, queryWords, type HistoryRange } from "./history.js";
import type { StateDir } from "./state.js";

export const ITEMS_FILE = "history/items.jsonl";
const FORGOTTEN_FILE = "history/items-forgotten.json";
/** Longest text kept per item: about eight hours of talk. */
export const ITEM_TEXT_MAX = 500_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the intake's summary step wrote, from the whole item. */
export interface ItemSummary {
  title?: string;
  /** A few sentences: what it was about and how it ended. */
  summary: string;
  decisions: string[];
  /** What the owner took on, was asked to do or offered. */
  ownerTasks: string[];
  /** "Name: task" for everyone else. */
  othersTasks: string[];
  /** Raised and left unsettled. */
  open: string[];
}

export interface ArchiveItem {
  /** The sender's id; the same id again replaces the item. */
  id: string;
  /** Where it came from: "band", later "email", "slack", "claude-code", ... */
  source: string;
  title?: string;
  /** When it started (ms). */
  startedAt: number;
  endedAt?: number;
  /** The people in it, as the source named them. */
  people?: string[];
  /** One line per turn or message. */
  text: string;
  receivedAt: number;
  summary?: ItemSummary;
}

/** One searchable line of an item: a line of its text, or of its summary. */
export interface ItemLine {
  part: "text" | "summary";
  text: string;
}

/** A line that matched; for a line of the text, what was said right after it. */
export interface ItemHit extends ItemLine {
  following?: ItemLine[];
}

export interface ItemMatch {
  item: ArchiveItem;
  /** The lines that matched, in the item's order. */
  lines: ItemHit[];
}

/**
 * What follows a hit: in a conversation the answer comes after the question, often split over several
 * short turns (run 2, 2026-10-24: Sarah's answer came six fragments and 52 seconds after Maya's
 * question). Lines within this long after a timed line, or the next line when lines carry no time.
 */
export const FOLLOWING_SECONDS = 60;
/** Each following line is shown clipped to this; the clipped lines of one hit add up to at most FOLLOWING_MAX_CHARS. */
export const FOLLOWING_LINE_MAX = 250;
const FOLLOWING_MAX_CHARS = 900;

/** Seconds into the conversation from a "[12:34]" or "[1:02:03]" line start; undefined without one. */
export function lineSeconds(line: string): number | undefined {
  const m = /^\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/.exec(line);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const SUMMARY_LABELS: Array<[keyof ItemSummary, string]> = [
  ["decisions", "Decided"],
  ["ownerTasks", "Owner's tasks"],
  ["othersTasks", "Others' tasks"],
  ["open", "Open"],
];

/** The summary as lines, each one searchable on its own ("Decided: ..."). */
export function summaryLines(s: ItemSummary): string[] {
  const out = s.summary.trim() ? [s.summary.trim()] : [];
  for (const [key, label] of SUMMARY_LABELS) for (const v of s[key] as string[]) if (v.trim()) out.push(`${label}: ${v.trim()}`);
  return out;
}

function lineId(itemId: string, part: ItemLine["part"], text: string): string {
  return createHash("sha1").update(`${itemId}|${part}|${text.trim()}`).digest("hex").slice(0, 16);
}

/** The summary with only the lines `keep` accepts, each judged as summaryLines() writes it. */
function filterSummary(s: ItemSummary, keep: (line: string) => boolean): ItemSummary {
  const out: ItemSummary = { ...s, summary: s.summary.trim() && !keep(s.summary.trim()) ? "" : s.summary };
  const lists = out as unknown as Record<string, string[]>;
  for (const [key, label] of SUMMARY_LABELS) lists[key] = (s[key] as string[]).filter((v) => !v.trim() || keep(`${label}: ${v.trim()}`));
  return out;
}

/** The text lines after line `i` within FOLLOWING_SECONDS (or the next one, untimed), up to a size; not other hits. */
function following(lines: Array<{ line: ItemLine; hits: number }>, i: number, best: number): ItemLine[] {
  const start = lineSeconds(lines[i]!.line.text);
  const out: ItemLine[] = [];
  let size = 0;
  for (const l of lines.slice(i + 1)) {
    if (l.line.part !== "text") continue;
    const at = lineSeconds(l.line.text);
    if (start === undefined || at === undefined ? out.length >= 1 : at - start > FOLLOWING_SECONDS) break;
    if (l.hits === best) continue;
    const shown = Math.min(l.line.text.length, FOLLOWING_LINE_MAX);
    if (size + shown > FOLLOWING_MAX_CHARS && out.length > 0) break;
    out.push(l.line);
    size += shown;
  }
  return out;
}

export class ItemArchive {
  private forgotten: Set<string> | undefined;

  constructor(
    private readonly state: StateDir,
    private readonly opts: { keepDays?: number; now?: () => Date } = {},
  ) {}

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** Every kept item, oldest first. Items past the age limit are dropped from the file on first read. */
  all(): ArchiveItem[] {
    const cutoff = this.now() - (this.opts.keepDays ?? HISTORY_KEEP_DAYS) * DAY_MS;
    const items: ArchiveItem[] = [];
    let expired = 0;
    for (const line of this.state.readLines(ITEMS_FILE)) {
      try {
        const it = JSON.parse(line) as ArchiveItem;
        if (typeof it.id !== "string" || typeof it.startedAt !== "number" || typeof it.text !== "string") continue;
        if (it.startedAt < cutoff) expired++;
        else items.push(it);
      } catch {
        // A torn last line from a crash mid-write; skipping it is the right recovery.
      }
    }
    if (expired > 0) this.rewrite(items);
    return items.sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): ArchiveItem | undefined {
    return this.all().find((it) => it.id === id);
  }

  private rewrite(items: ArchiveItem[]): void {
    this.state.writeText(ITEMS_FILE, items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : ""));
  }

  private forgottenSet(): Set<string> {
    this.forgotten ??= new Set(this.state.readJson<string[]>(FORGOTTEN_FILE, []));
    return this.forgotten;
  }

  /** Keep an item; the same id again replaces it. Lines the owner asked to forget stay out. */
  add(item: Omit<ArchiveItem, "receivedAt" | "summary"> & { receivedAt?: number }): ArchiveItem {
    const forgotten = this.forgottenSet();
    const text = item.text
      .slice(0, ITEM_TEXT_MAX)
      .split("\n")
      .filter((l) => !forgotten.has(lineId(item.id, "text", l)))
      .join("\n")
      .trim();
    const kept: ArchiveItem = { ...item, text, receivedAt: item.receivedAt ?? this.now() };
    const existing = this.all();
    const others = existing.filter((it) => it.id !== item.id);
    if (others.length === existing.length) this.state.appendLine(ITEMS_FILE, JSON.stringify(kept));
    else this.rewrite([...others, kept]);
    return kept;
  }

  /** Store the summary the intake wrote for an item, without the lines the owner asked to forget. */
  setSummary(id: string, summary: ItemSummary): void {
    const forgotten = this.forgottenSet();
    const clean = filterSummary(summary, (line) => !forgotten.has(lineId(id, "summary", line)));
    this.rewrite(this.all().map((it) => (it.id === id ? { ...it, summary: clean, ...(clean.title && !it.title ? { title: clean.title } : {}) } : it)));
  }

  private linesOf(it: ArchiveItem): ItemLine[] {
    const summary = it.summary ? summaryLines(it.summary).map((text) => ({ part: "summary" as const, text })) : [];
    const text = it.text.split("\n").map((l) => l.trim()).filter(Boolean).map((t) => ({ part: "text" as const, text: t }));
    return [...summary, ...text];
  }

  private inRange(it: ArchiveItem, range: HistoryRange): boolean {
    return (range.since === undefined || it.startedAt > range.since) && (range.until === undefined || it.startedAt <= range.until);
  }

  /**
   * Lines containing every word of the query, grouped by item, newest item first. When no line has
   * them all, the lines with the most of them, marked `partial`. Every matching summary line, and at
   * most `perItem` lines of the text, each with what was said in the minute after it (`following`),
   * leaving out lines that matched themselves.
   */
  search(query: string, range: HistoryRange = {}, limit = 3, perItem = 5): { matches: ItemMatch[]; partial: boolean } {
    const words = queryWords(query);
    if (words.length === 0) return { matches: [], partial: false };
    const scored = this.all()
      .filter((it) => this.inRange(it, range))
      .map((item) => ({ item, lines: this.linesOf(item).map((line) => ({ line, hits: words.filter((w) => line.text.toLowerCase().includes(w)).length })) }));
    const best = Math.max(0, ...scored.flatMap((s) => s.lines.map((l) => l.hits)));
    if (best === 0) return { matches: [], partial: false };
    const matches = scored
      .map(({ item, lines }) => {
        const hits: ItemHit[] = [];
        let textHits = 0;
        for (const [i, l] of lines.entries()) {
          if (l.hits !== best) continue;
          if (l.line.part === "summary") hits.push(l.line);
          else if (textHits++ < perItem) hits.push({ ...l.line, following: following(lines, i, best) });
        }
        return { item, lines: hits };
      })
      .filter((m) => m.lines.length > 0)
      .sort((a, b) => b.item.startedAt - a.item.startedAt)
      .slice(0, limit);
    return { matches, partial: best < words.length };
  }

  /**
   * Remove the lines (of the text and the summary) containing every word of the query, within the
   * range, and remember them so the same item sent again cannot bring them back. Without `apply`, only
   * says what would go.
   */
  forget(query: string, range: HistoryRange = {}, apply = false): Array<{ item: ArchiveItem; line: ItemLine }> {
    const words = queryWords(query);
    if (words.length === 0) return [];
    const all = this.all();
    const gone = all
      .filter((it) => this.inRange(it, range))
      .flatMap((item) => this.linesOf(item).filter((l) => words.every((w) => l.text.toLowerCase().includes(w))).map((line) => ({ item, line })));
    if (!apply || gone.length === 0) return gone;
    const forgotten = this.forgottenSet();
    for (const { item, line } of gone) forgotten.add(lineId(item.id, line.part, line.text));
    this.state.writeJson(FORGOTTEN_FILE, [...forgotten]);
    this.rewrite(
      all.map((it) => {
        const text = it.text.split("\n").filter((l) => !l.trim() || !forgotten.has(lineId(it.id, "text", l))).join("\n");
        if (!it.summary) return { ...it, text };
        return { ...it, text, summary: filterSummary(it.summary, (line) => !forgotten.has(lineId(it.id, "summary", line))) };
      }),
    );
    return gone;
  }
}
