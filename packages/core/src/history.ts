/**
 * [sunshine:history] The owner's conversations, kept so they can be searched after the live history
 * is trimmed. Upstream folds older messages into a short summary and deletes them; seen live
 * (2026-10-16), the owner's agent could see whole messages back to the day before and 200-character
 * highlights for one more day, and nothing older. OpenClaw keeps transcripts searchable
 * (memory_search) for the same reason.
 *
 * Only the conversation is kept: the owner's texts, the agent's replies and the runtime's notes (a
 * reminder or news text copied into the thread), from the owner's own threads. Tool calls and results
 * are not kept (they can be fetched again). Entries older than HISTORY_KEEP_DAYS are dropped, and
 * what the owner asks to forget is removed and never written again. It is plain text on the agent's
 * own disk; nothing rides along with a message unless a search brings it in.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StateDir } from "./state.js";

export const HISTORY_FILE = "history/owner.jsonl";
const FORGOTTEN_FILE = "history/forgotten.json";
export const HISTORY_KEEP_DAYS = 365;
/** Longest text kept per message; a note (the runtime's) is kept shorter. */
export const HISTORY_TEXT_MAX = 4000;
const NOTE_MAX = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HistoryWho = "owner" | "agent" | "note";

export interface HistoryEntry {
  /** When the message was sent (ms). */
  ts: number;
  /** The runtime key of the thread it belongs to. */
  key: string;
  who: HistoryWho;
  text: string;
}

export interface HistoryMatch {
  entry: HistoryEntry;
  /** The next message in the same thread, when it is the other side answering within half an hour. */
  next?: HistoryEntry;
}

export interface HistoryRange {
  since?: number;
  until?: number;
}

function digest(who: HistoryWho, ts: number, text: string): string {
  return createHash("sha1").update(`${who}|${ts}|${text.slice(0, 200)}`).digest("hex").slice(0, 16);
}

function messageText(m: AgentMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The words of a query, lowercased; letters and digits in any script count, so "lån" and "XRP" both work. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
}

export class HistoryArchive {
  private known: Set<string> | undefined;
  private forgotten: Set<string> | undefined;

  constructor(
    private readonly state: StateDir,
    private readonly opts: { keepDays?: number; now?: () => Date } = {},
  ) {}

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** Every kept entry, oldest first. Entries past the age limit are dropped from the file on first read. */
  all(): HistoryEntry[] {
    const cutoff = this.now() - (this.opts.keepDays ?? HISTORY_KEEP_DAYS) * DAY_MS;
    const entries: HistoryEntry[] = [];
    let expired = 0;
    for (const line of this.state.readLines(HISTORY_FILE)) {
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (typeof e.ts !== "number" || typeof e.text !== "string") continue;
        if (e.ts < cutoff) expired++;
        else entries.push(e);
      } catch {
        // A torn last line from a crash mid-write; skipping it is the right recovery.
      }
    }
    if (expired > 0) this.rewrite(entries);
    return entries;
  }

  private rewrite(entries: HistoryEntry[]): void {
    this.state.writeText(HISTORY_FILE, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
    this.known = new Set(entries.map((e) => digest(e.who, e.ts, e.text)));
  }

  private knownSet(): Set<string> {
    this.known ??= new Set(this.all().map((e) => digest(e.who, e.ts, e.text)));
    return this.known;
  }

  private forgottenSet(): Set<string> {
    this.forgotten ??= new Set(this.state.readJson<string[]>(FORGOTTEN_FILE, []));
    return this.forgotten;
  }

  /**
   * Keep the conversation part of a thread's messages: called with the whole live history each time
   * it is saved, so a message is written once, the first time it is seen. A trim summary is skipped
   * (its messages were kept when they were live). Returns how many were added.
   */
  record(key: string, messages: AgentMessage[]): number {
    const known = this.knownSet();
    const forgotten = this.forgottenSet();
    let added = 0;
    for (const m of messages) {
      let who: HistoryWho;
      let text = messageText(m).trim();
      if (m.role === "user") {
        if (text.startsWith("[Conversation summary]")) continue;
        // The time stamp line in front of each message; the entry carries the time.
        text = text.replace(/^\[[^\]\n]*\]\n/, "").trim();
        who = text.startsWith("[Not a message from") ? "note" : "owner";
      } else if (m.role === "assistant") {
        who = "agent";
      } else {
        continue;
      }
      if (!text) continue;
      text = text.slice(0, who === "note" ? NOTE_MAX : HISTORY_TEXT_MAX);
      const ts = typeof m.timestamp === "number" ? m.timestamp : this.now();
      const id = digest(who, ts, text);
      if (known.has(id) || forgotten.has(id)) continue;
      this.state.appendLine(HISTORY_FILE, JSON.stringify({ ts, key, who, text } satisfies HistoryEntry));
      known.add(id);
      added++;
    }
    return added;
  }

  /** Entries within a time range (ms), oldest first. */
  between(range: HistoryRange = {}): HistoryEntry[] {
    return this.all().filter((e) => (range.since === undefined || e.ts > range.since) && (range.until === undefined || e.ts <= range.until));
  }

  /**
   * Entries containing every word of the query, newest first, each with the answer that followed it.
   * When no entry has them all, the ones with the most of them, marked `partial`.
   */
  search(query: string, range: HistoryRange = {}, limit = 6): { matches: HistoryMatch[]; partial: boolean } {
    const words = queryWords(query);
    if (words.length === 0) return { matches: [], partial: false };
    const entries = this.between(range);
    const scored = entries.map((e, i) => {
      const lower = e.text.toLowerCase();
      return { i, hits: words.filter((w) => lower.includes(w)).length };
    });
    const best = Math.max(0, ...scored.map((s) => s.hits));
    if (best === 0) return { matches: [], partial: false };
    const withNext = scored
      .filter((s) => s.hits === best)
      .map(({ i }) => {
        const entry = entries[i]!;
        const next = entries.slice(i + 1).find((e) => e.key === entry.key);
        const answers = next && next.who !== entry.who && next.ts - entry.ts <= 30 * 60 * 1000;
        return answers ? { entry, next } : { entry };
      });
    // A reply that matched too is already shown under the message it answered.
    const shownAsNext = new Set(withNext.map((m) => m.next).filter(Boolean));
    const matches = withNext
      .filter((m) => !shownAsNext.has(m.entry))
      .sort((a, b) => b.entry.ts - a.entry.ts)
      .slice(0, limit);
    return { matches, partial: best < words.length };
  }

  /**
   * Remove the entries containing every word of the query (within the range), and remember them so
   * the live history cannot write them back. Without `apply`, only says what would go.
   */
  forget(query: string, range: HistoryRange = {}, apply = false): HistoryEntry[] {
    const words = queryWords(query);
    if (words.length === 0) return [];
    const inRange = (e: HistoryEntry) => (range.since === undefined || e.ts > range.since) && (range.until === undefined || e.ts <= range.until);
    const all = this.all();
    const gone = all.filter((e) => inRange(e) && words.every((w) => e.text.toLowerCase().includes(w)));
    if (!apply || gone.length === 0) return gone;
    const forgotten = this.forgottenSet();
    for (const e of gone) forgotten.add(digest(e.who, e.ts, e.text));
    this.state.writeJson(FORGOTTEN_FILE, [...forgotten]);
    const goneSet = new Set(gone);
    this.rewrite(all.filter((e) => !goneSet.has(e)));
    return gone;
  }
}
