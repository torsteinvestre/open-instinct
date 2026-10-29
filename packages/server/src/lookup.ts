/**
 * [sunshine:in-the-flow] What the owner's live sources (email, calendar) show about something new, read by code before
 * the agent decides. The live check of 2026-10-27: told what was still unclear, with the email tools loaded, the agent
 * still asked Torstein what the 3 Nov event was instead of searching his email, and offered to add a concert that was
 * already in his calendar. Looking up was left to the model's diligence; here it is part of the flow, as recall.ts is
 * for what Sunshine keeps. Town works the same way: "pull only what a task needs, at the moment it needs it".
 *
 * The summary step writes the searches (for the points still unclear, in the email's search words) and the days the
 * item is about; code runs them on each source that is plugged in (Composio's Gmail and Google Calendar today; another
 * app is one more plug, not a new build). What comes back is marked as read just now: the state of other systems is
 * read live, never kept as memory.
 */
import type { AuditLog, InstinctConfig } from "@open-instinct/core";
import type { AppActionResult } from "@open-instinct/apps";

export interface EmailHit {
  /** When it was sent (ms), when the source says. */
  at?: number;
  from: string;
  subject: string;
  preview: string;
}

export interface EventHit {
  title: string;
  /** RFC 3339 date-time, or YYYY-MM-DD for an all-day event. */
  start: string;
  end?: string;
  location?: string;
}

/** The plugs. A source left out is not looked at. */
export interface LiveSources {
  /** Email matching `query` (Gmail's search words), newest first, at most `max`. */
  searchEmail?: (query: string, max: number) => Promise<EmailHit[]>;
  /** Events overlapping [from, to) (RFC 3339 with offset), in start order, at most `max`. */
  events?: (from: string, to: string, max: number) => Promise<EventHit[]>;
}

/** What the summary step asked to look up: email searches, and days as YYYY-MM-DD or YYYY-MM-DD/YYYY-MM-DD. */
export interface LookUpAsk {
  searches: string[];
  days: string[];
}

/** Lines for the hand-off; undefined when there was nothing to look up or no source to look in. */
export type LookUp = (ask: LookUpAsk) => Promise<string | undefined>;

/**
 * Emails shown per search. Gmail lists the newest first, not the best match first; on Torstein's inbox (2026-10-29) the
 * answer was the only hit and no search had more than 4. A bound on size, not a target: the agent can search further.
 */
export const EMAILS_PER_SEARCH = 5;
/** Events shown per day or span: a full working week of meetings. */
const EVENTS_PER_SPAN = 25;
/** A span longer than this ("this month") is cut to its first two weeks; the agent reads the rest with its tools. */
export const SPAN_DAYS_MAX = 14;
const PREVIEW_MAX = 300;
const FIELD_MAX = 140;
/** Everything shown, at most: about what recall shows (six pieces of four 300-character lines). */
const SHOWN_MAX = 8_000;
/** A source that has not answered by then is reported as not looked at, and the hand-off goes on. */
const WAIT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A real calendar date as YYYY-MM-DD, or undefined. */
function realDay(s: string | undefined): string | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s ? undefined : s;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "2026-11-03" or "2026-11-02/2026-11-08" as first and last day (the last at most SPAN_DAYS_MAX on); undefined when not a date. */
export function parseSpan(s: string): { first: string; last: string } | undefined {
  const [a, b] = s.trim().split("/");
  const first = realDay(a?.trim());
  if (!first) return undefined;
  const given = b === undefined ? first : realDay(b.trim());
  if (!given || given < first) return undefined;
  const cap = addDays(first, SPAN_DAYS_MAX - 1);
  return { first, last: given > cap ? cap : given };
}

/** "+01:00" for `tz` at the instant `ms`. */
function offsetAt(ms: number, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  return /GMT([+-]\d{2}:\d{2})/.exec(name)?.[1] ?? "+00:00";
}

/**
 * The midnight that starts `day` in `tz`, RFC 3339. The offset is read at 00:00 UTC of that date: before the day's
 * daylight-saving switch in Europe (01:00 UTC) and in the Americas (local early morning, later in UTC).
 */
export function midnightIn(day: string, tz: string): string {
  return `${day}T00:00:00${offsetAt(Date.parse(`${day}T00:00:00Z`), tz)}`;
}

export function createLookUp(deps: { sources: LiveSources; config: InstinctConfig; audit?: AuditLog; waitMs?: number }): LookUp {
  const tz = () => deps.config.owner.timezone || "UTC";
  const wait = deps.waitMs ?? WAIT_MS;
  const dayName = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));
  const dateOf = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const clock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const timed = (s: string | undefined) => (s && s.includes("T") && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : undefined);

  const eventLine = (e: EventHit, withDay: boolean): string => {
    const at = timed(e.start);
    const end = timed(e.end);
    const day = at !== undefined ? dateOf(at) : realDay(e.start) ? dayName(e.start) : e.start;
    const when = at !== undefined ? `${clock(at)}${end !== undefined ? `-${clock(end)}` : ""}` : "all day";
    return `- ${withDay ? `${day} ` : ""}${when} ${clip(e.title || "(no title)", FIELD_MAX)}${e.location ? ` (${clip(e.location, FIELD_MAX)})` : ""}`;
  };

  return async (ask) => {
    const searches = deps.sources.searchEmail ? [...new Set(ask.searches.map((s) => s.trim()).filter(Boolean))] : [];
    const spans = deps.sources.events ? [...new Map(ask.days.map(parseSpan).filter((s) => s !== undefined).map((s) => [`${s.first}/${s.last}`, s])).values()] : [];
    if (searches.length === 0 && spans.length === 0) return undefined;
    const counts = { emails: 0, events: 0, failed: 0 };

    const email = async (query: string): Promise<string> => {
      const label = `Email, searched for ${query}`;
      try {
        const hits = (await within(deps.sources.searchEmail!(query, EMAILS_PER_SEARCH), wait)).slice(0, EMAILS_PER_SEARCH);
        counts.emails += hits.length;
        if (hits.length === 0) return `${label}: nothing found.`;
        const lines = hits.map((h) => `- ${h.at !== undefined ? `${dateOf(h.at)}, ` : ""}from ${clip(h.from || "(unknown sender)", FIELD_MAX)}: ${clip(h.subject || "(no subject)", FIELD_MAX)}${h.preview.trim() ? ` | ${clip(h.preview, PREVIEW_MAX)}` : ""}`);
        return [`${label}:`, ...lines].join("\n");
      } catch {
        counts.failed += 1;
        return `${label}: the search did not work just now (not looked at).`;
      }
    };

    const calendar = async (span: { first: string; last: string }): Promise<string> => {
      const one = span.first === span.last;
      const label = `Calendar, ${dayName(span.first)}${one ? "" : ` to ${dayName(span.last)}`}`;
      try {
        const from = midnightIn(span.first, tz());
        const to = midnightIn(addDays(span.last, 1), tz());
        const hits = (await within(deps.sources.events!(from, to, EVENTS_PER_SPAN), wait)).slice(0, EVENTS_PER_SPAN);
        counts.events += hits.length;
        if (hits.length === 0) return `${label}: nothing in the calendar.`;
        // Over a span each event names its day; an event that began the day before still shows on its own day.
        const multi = !one || hits.some((h) => timed(h.start) !== undefined && dayOf(timed(h.start)!) !== span.first);
        return [`${label}:`, ...hits.map((h) => eventLine(h, multi))].join("\n");
      } catch {
        counts.failed += 1;
        return `${label}: the calendar could not be read just now (not looked at).`;
      }
    };

    const started = Date.now();
    const blocks = await Promise.all([...searches.map(email), ...spans.map(calendar)]);
    deps.audit?.append({ kind: "policy", detail: { lookUp: { searches: searches.length, spans: spans.length, ...counts, ms: Date.now() - started } } });
    const text = blocks.join("\n");
    return text.length <= SHOWN_MAX ? text : `${text.slice(0, SHOWN_MAX - 60).replace(/\n[^\n]*$/, "")}\n(more left out; search again for the rest)`;
  };
}

/** The parts of ComposioApps the plugs use. */
export interface AppsRunner {
  execute(slug: string, args: Record<string, unknown>): Promise<AppActionResult>;
  readonly toolkitSlugs: string[];
  readonly allToolkits: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** A message's short text: Composio's preview (a string, or {body}), else its text. */
function previewOf(m: Record<string, unknown>): string {
  const p = m.preview;
  if (typeof p === "string") return p;
  const body = text(asRecord(p).body);
  return body || text(m.messageText);
}

async function run(apps: AppsRunner, slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await apps.execute(slug, args);
  if (r.error) throw new Error(r.error);
  return asRecord(r.data);
}

/**
 * The Composio plugs: Gmail search and Google Calendar events with the owner's connection, each only when its toolkit
 * is in the agent's list.
 */
export function composioSources(apps: AppsRunner, timezone: () => string): LiveSources {
  const has = (toolkit: string) => apps.allToolkits || apps.toolkitSlugs.includes(toolkit);
  return {
    ...(has("gmail")
      ? {
          searchEmail: async (query: string, max: number) => {
            // Promotions are ads ("kinda like getting an ad", Torstein 2026-10-27). Updates stays: his event
            // confirmation and his ticket order were both filed there (2026-10-29).
            const data = await run(apps, "GMAIL_FETCH_EMAILS", { query: `(${query}) -category:promotions`, max_results: max, include_payload: false, verbose: false });
            const messages = Array.isArray(data.messages) ? data.messages.map(asRecord) : [];
            return messages.map((m): EmailHit => {
              const at = Date.parse(text(m.messageTimestamp));
              return { ...(Number.isNaN(at) ? {} : { at }), from: text(m.sender), subject: text(m.subject), preview: previewOf(m) };
            });
          },
        }
      : {}),
    ...(has("googlecalendar")
      ? {
          events: async (from: string, to: string, max: number) => {
            const data = await run(apps, "GOOGLECALENDAR_EVENTS_LIST", { calendarId: "primary", timeMin: from, timeMax: to, timeZone: timezone(), singleEvents: true, orderBy: "startTime", maxResults: max });
            const list = [data.items, data.events, asRecord(data.response_data).items].find(Array.isArray) ?? [];
            return list
              .map(asRecord)
              .filter((e) => e.status !== "cancelled")
              .map((e): EventHit => {
                const start = asRecord(e.start);
                const end = asRecord(e.end);
                const endAt = text(end.dateTime) || text(end.date);
                const location = text(e.location);
                return { title: text(e.summary), start: text(start.dateTime) || text(start.date), ...(endAt ? { end: endAt } : {}), ...(location ? { location } : {}) };
              });
          },
        }
      : {}),
  };
}
