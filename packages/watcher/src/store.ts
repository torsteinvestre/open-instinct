/**
 * [sunshine:watcher] Everything the news watch keeps, in one file under the agent's data dir
 * (`watcher.json`): the written picture of the owner, the searches, settings, and its memory of
 * what was seen, told (story cards), kept for later, decided (notes) and spent. Old entries are
 * pruned on every read, so the file stays small.
 */
import { randomBytes } from "node:crypto";
import type { StateDir } from "@open-instinct/core";
import { DEFAULT_QUIET, MIN_CHECK_MINUTES, type QuietHours } from "./clock.js";

export const WATCH_FILE = "watcher.json";
export const PROFILE_MAX_CHARS = 2000;
export const SEARCH_MAX = 12;
export const QUERY_MAX_CHARS = 120;
export const TOPIC_MAX_CHARS = 80;
/**
 * Every two hours by default (2026-10-15): about $5.50 a month per owner instead of about $8 hourly,
 * and news still arrives within two hours. Faster or slower is the owner's choice (watch_settings).
 */
export const DEFAULT_EVERY_MINUTES = 120;

const DAY = 24 * 60 * 60 * 1000;
/** How long each kind of memory lasts. Story cards cover long stories; notes only recent checks. */
export const KEEP_DAYS = { seen: 14, stories: 14, sent: 14, later: 7, notes: 2, calls: 31 } as const;
export const LATER_MAX = 30;
export const NOTES_MAX = 40;

export interface WatchSearch {
  /** What the owner follows, unambiguous: "Brann, the Bergen football club (SK Brann)". */
  topic: string;
  /** The Google News search: "SK Brann". */
  query: string;
  /** Google News edition: en-US, en-GB, no-NO, sv-SE, or any xx-YY. */
  edition: string;
}

/** One story the owner has been told about, and how it developed. Compared against new headlines. */
export interface StoryCard {
  id: string;
  /** Who or what it concerns: "SK Brann". */
  subject: string;
  /** What happened: "signing striker Ola Nordmann from Molde". */
  event: string;
  /** What is known now: "official, three-year contract". */
  status: string;
  titles: string[];
  links: string[];
  firstTold: string;
  lastTold: string;
  updates: number;
}

export interface SentRecord {
  at: string;
  text: string;
  links: string[];
  kind: "news" | "question";
}

export interface LaterItem {
  at: string;
  title: string;
  link: string;
  topic?: string;
  why?: string;
}

export interface DecisionNote {
  at: string;
  text: string;
}

export interface ModelCallRecord {
  at: string;
  step: "screen" | "decide" | "write";
  costUsd: number;
}

export interface CheckSummary {
  at: string;
  searches: number;
  /** Headlines the feeds returned. */
  fetched: number;
  /** Of those, from the last day and not seen before. */
  fresh: number;
  /** Of those, passed the relevance sieve (or went through unsieved). */
  passed: number;
  sieve: "jev" | "none" | "partial";
  jevInputTokens: number;
  errors: string[];
}

export interface WatchState {
  version: 1;
  /** Whether the owner's checks are scheduled. */
  on: boolean;
  /** When the watch was first set up for this owner. */
  startedAt: string;
  /** The written picture of the owner's interests. */
  profile: string;
  searches: WatchSearch[];
  quiet: QuietHours;
  everyMinutes: number;
  scheduleIds: string[];
  /** The "anything you'd like me to keep an eye on?" question went out once. */
  askedInterests: boolean;
  /** Headline keys already looked at, with when. */
  seen: Record<string, string>;
  stories: StoryCard[];
  sent: SentRecord[];
  later: LaterItem[];
  notes: DecisionNote[];
  calls: ModelCallRecord[];
  lastCheck?: CheckSummary;
}

/**
 * The decision journal: one line per check, every headline it looked at and what happened to it,
 * so missed stories can be found afterwards ("what did you skip today?"). Kept for a week, in its
 * own file so watcher.json stays small.
 */
export const JOURNAL_FILE = "watcher-journal.jsonl";
export const JOURNAL_DAYS = 7;
/** Sieve-dropped headlines kept per check, most on-topic first: enough to spot a wrong drop. */
export const JOURNAL_SIEVE_MAX = 40;

export interface JournalItem {
  title: string;
  source?: string;
  topic: string;
  link: string;
  /** Where its path ended: the Jev sieve, the screen (step 1) or the decision (step 2). */
  /** "write": chosen, then held back while writing (old news, or a bad moment). */
  stage: "sieve" | "screen" | "decide" | "write";
  /** "undecided": step 2 never ran (it failed, or its answer was refused). */
  result: "dropped" | "told" | "kept" | "nothing" | "undecided";
  /** The sieve's probability that it is on topic. */
  p?: number;
  /** For "told": the story card it opened or updated. */
  card?: string;
}

export interface JournalEntry {
  at: string;
  mode: string;
  outcome: string;
  note?: string;
  costUsd?: number;
  items: JournalItem[];
}

export function defaultState(now: Date = new Date()): WatchState {
  return {
    version: 1,
    on: false,
    startedAt: now.toISOString(),
    profile: "",
    searches: [],
    quiet: { ...DEFAULT_QUIET },
    everyMinutes: DEFAULT_EVERY_MINUTES,
    scheduleIds: [],
    askedInterests: false,
    seen: {},
    stories: [],
    sent: [],
    later: [],
    notes: [],
    calls: [],
  };
}

export function newCardId(): string {
  return `c_${randomBytes(3).toString("hex")}`;
}

export class WatchStore {
  private readonly state: StateDir;
  private readonly now: () => Date;

  constructor(state: StateDir, now: () => Date = () => new Date()) {
    this.state = state;
    this.now = now;
  }

  exists(): boolean {
    return this.state.exists(WATCH_FILE);
  }

  read(): WatchState {
    const raw = this.state.readJson<Partial<WatchState>>(WATCH_FILE, {});
    const s: WatchState = { ...defaultState(this.now()), ...(raw && typeof raw === "object" ? raw : {}), version: 1 };
    // A hand-edited or older file must not crash a check: fall back field by field.
    for (const key of ["searches", "scheduleIds", "stories", "sent", "later", "notes", "calls"] as const) {
      if (!Array.isArray(s[key])) (s as unknown as Record<string, unknown[]>)[key] = [];
    }
    if (!s.seen || typeof s.seen !== "object") s.seen = {};
    if (!s.quiet || typeof s.quiet.start !== "string" || typeof s.quiet.end !== "string") s.quiet = { ...DEFAULT_QUIET };
    if (typeof s.profile !== "string") s.profile = "";
    if (typeof s.everyMinutes !== "number") s.everyMinutes = DEFAULT_EVERY_MINUTES;
    // [sunshine:watcher] Faster than every two hours is no longer offered; an older setting counts as two hours.
    if (s.everyMinutes < MIN_CHECK_MINUTES) s.everyMinutes = MIN_CHECK_MINUTES;
    this.prune(s);
    return s;
  }

  update(change: (s: WatchState) => void): WatchState {
    const s = this.read();
    change(s);
    this.prune(s);
    this.state.writeJson(WATCH_FILE, s);
    return s;
  }

  appendJournal(entry: JournalEntry): void {
    const lines = this.state.readLines(JOURNAL_FILE);
    const cutoff = this.now().getTime() - JOURNAL_DAYS * DAY;
    const atOf = (line: string): number => {
      try {
        return Date.parse((JSON.parse(line) as JournalEntry).at);
      } catch {
        return -Infinity; // a torn line counts as old, so the next rewrite drops it
      }
    };
    if (lines[0] !== undefined && atOf(lines[0]) < cutoff) {
      // Rewrite without the old days; this happens about once a day.
      const keep = lines.filter((l) => atOf(l) >= cutoff);
      this.state.writeText(JOURNAL_FILE, keep.map((l) => `${l}\n`).join(""));
    }
    this.state.appendLine(JOURNAL_FILE, JSON.stringify(entry));
  }

  readJournal(sinceMs: number): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const line of this.state.readLines(JOURNAL_FILE)) {
      try {
        const e = JSON.parse(line) as JournalEntry;
        if (Date.parse(e.at) >= sinceMs) out.push(e);
      } catch {
        // A torn line from a crash mid-write: skip it.
      }
    }
    return out;
  }

  private prune(s: WatchState): void {
    const t = this.now().getTime();
    const fresh = (iso: string, days: number) => {
      const at = Date.parse(iso);
      return Number.isFinite(at) && t - at < days * DAY;
    };
    for (const [key, at] of Object.entries(s.seen)) if (!fresh(at, KEEP_DAYS.seen)) delete s.seen[key];
    s.stories = s.stories.filter((c) => fresh(c.lastTold, KEEP_DAYS.stories));
    s.sent = s.sent.filter((r) => fresh(r.at, KEEP_DAYS.sent));
    s.later = s.later.filter((r) => fresh(r.at, KEEP_DAYS.later)).slice(-LATER_MAX);
    s.notes = s.notes.filter((n) => fresh(n.at, KEEP_DAYS.notes)).slice(-NOTES_MAX);
    s.calls = s.calls.filter((c) => fresh(c.at, KEEP_DAYS.calls));
  }
}
