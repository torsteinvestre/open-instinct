/**
 * [sunshine:watcher] Everything the news watch keeps, in one file under the agent's data dir:
 * the written picture of the owner, the searches, quiet hours and check times, and the memory of
 * what was seen, sent and kept for later. Old entries are pruned on every read.
 */
import type { StateDir } from "@open-instinct/core";
import { DEFAULT_QUIET, type QuietHours } from "./clock.js";

export const WATCH_FILE = "watcher.json";
export const PROFILE_MAX_CHARS = 2000;
export const SEARCH_MAX = 12;
export const QUERY_MAX_CHARS = 120;
export const TOPIC_MAX_CHARS = 80;
export const DEFAULT_TIMES = ["09:00", "18:00"];

const DAY = 24 * 60 * 60 * 1000;
const SEEN_DAYS = 14;
const SENT_DAYS = 14;
const LATER_DAYS = 7;
export const LATER_MAX = 30;

export interface WatchSearch {
  /** What the owner follows, in words Jev can match: "Brann, the Bergen football club". */
  topic: string;
  /** The Google News search: "SK Brann". */
  query: string;
  /** Google News edition: en-US, en-GB, no-NO, sv-SE, or any xx-YY. */
  edition: string;
}

export interface SentRecord {
  at: string;
  text: string;
  links: string[];
}

export interface LaterItem {
  at: string;
  title: string;
  link: string;
  topic?: string;
  why?: string;
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
  /** The written picture of the owner's interests. */
  profile: string;
  searches: WatchSearch[];
  quiet: QuietHours;
  times: string[];
  scheduleIds: string[];
  /** The "anything you'd like me to keep an eye on?" question went out once. */
  askedInterests: boolean;
  /** Headline keys already looked at, with when. */
  seen: Record<string, string>;
  sent: SentRecord[];
  later: LaterItem[];
  lastCheck?: CheckSummary;
}

export function defaultState(): WatchState {
  return {
    version: 1,
    on: false,
    profile: "",
    searches: [],
    quiet: { ...DEFAULT_QUIET },
    times: [...DEFAULT_TIMES],
    scheduleIds: [],
    askedInterests: false,
    seen: {},
    sent: [],
    later: [],
  };
}

export class WatchStore {
  private readonly state: StateDir;
  private readonly now: () => Date;

  constructor(state: StateDir, now: () => Date = () => new Date()) {
    this.state = state;
    this.now = now;
  }

  read(): WatchState {
    const raw = this.state.readJson<Partial<WatchState>>(WATCH_FILE, {});
    const s: WatchState = { ...defaultState(), ...(raw && typeof raw === "object" ? raw : {}), version: 1 };
    // A hand-edited or older file must not crash a check: fall back field by field.
    if (!Array.isArray(s.searches)) s.searches = [];
    if (!Array.isArray(s.times) || s.times.length === 0) s.times = [...DEFAULT_TIMES];
    if (!Array.isArray(s.scheduleIds)) s.scheduleIds = [];
    if (!s.seen || typeof s.seen !== "object") s.seen = {};
    if (!Array.isArray(s.sent)) s.sent = [];
    if (!Array.isArray(s.later)) s.later = [];
    if (!s.quiet || typeof s.quiet.start !== "string" || typeof s.quiet.end !== "string") s.quiet = { ...DEFAULT_QUIET };
    if (typeof s.profile !== "string") s.profile = "";
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

  private prune(s: WatchState): void {
    const t = this.now().getTime();
    const fresh = (iso: string, days: number) => {
      const at = Date.parse(iso);
      return Number.isFinite(at) && t - at < days * DAY;
    };
    for (const [key, at] of Object.entries(s.seen)) if (!fresh(at, SEEN_DAYS)) delete s.seen[key];
    s.sent = s.sent.filter((r) => fresh(r.at, SENT_DAYS));
    s.later = s.later.filter((r) => fresh(r.at, LATER_DAYS)).slice(-LATER_MAX);
  }
}
