/**
 * [sunshine:watcher] Clock helpers in the owner's timezone. Times are "HH:MM" strings; quiet hours
 * may wrap past midnight (22:00-08:00). Arithmetic stays in code: the models are not asked to do it.
 */
import { localParts } from "@open-instinct/core";

export interface QuietHours {
  start: string;
  end: string;
}

export const DEFAULT_QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** "9", "9:30", "09.30" or "21:05" as "HH:MM"; undefined when it is not a time of day. */
export function normalizeTime(raw: string): string | undefined {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minuteOfDay(at: Date, tz: string): number {
  const p = localParts(at, tz);
  return p.hour * 60 + p.minute;
}

/** Whether `at` falls inside quiet hours in `tz`. Equal start and end means no quiet hours. */
export function inQuietHours(at: Date, tz: string, quiet: QuietHours): boolean {
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  const now = minuteOfDay(at, tz);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * How often a check may run, in minutes: every 2 to 24 hours (2026-10-15). Faster cost up to four
 * times as much and news is rarely worse for an hour's wait; slower is the owner's choice.
 */
export const CHECK_INTERVALS = [120, 180, 240, 360, 480, 720, 1440] as const;
/** The shortest gap. A setting below it, saved before the change, counts as this. */
export const MIN_CHECK_MINUTES = CHECK_INTERVALS[0];

/** A gap as words after "every": "2 hours", "hour", "90 minutes". */
export function everyText(everyMinutes: number): string {
  if (everyMinutes % 60 !== 0) return `${everyMinutes} minutes`;
  const h = everyMinutes / 60;
  return h === 1 ? "hour" : `${h} hours`;
}

function inQuietMinute(minuteOfDay: number, quiet: QuietHours): boolean {
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

/**
 * The cron for checks every `everyMinutes` outside quiet hours, in the owner's local time:
 * every 60 with quiet 22:00-08:00 is "0 8,9,...,21 * * *". Checks start on the hour; with gaps of
 * two hours or more they start at the first full hour after quiet hours. Undefined when quiet
 * hours leave no hour at all. The check itself also looks at the clock, so a quiet hour that ends
 * at :30 is still respected exactly.
 */
export function checkCron(everyMinutes: number, quiet: QuietHours): string | undefined {
  const mins = everyMinutes < 60 ? Array.from({ length: Math.floor(60 / everyMinutes) }, (_, i) => i * everyMinutes) : [0];
  const step = everyMinutes < 60 ? 1 : Math.round(everyMinutes / 60);
  // [sunshine:watcher] The first full hour after quiet hours: with quiet until 07:30 the 07:00 check
  // fell inside them, so a daily check had no hour left and the cron fell back to every hour.
  const first = Math.ceil(minutes(quiet.end) / 60) % 24;
  const hours: number[] = [];
  for (let i = 0; i < 24; i++) {
    const h = (first + i) % 24;
    if (i % step !== 0) continue;
    if (mins.some((m) => !inQuietMinute(h * 60 + m, quiet))) hours.push(h);
  }
  hours.sort((a, b) => a - b);
  return hours.length ? `${mins.join(",")} ${hours.join(",")} * * *` : undefined;
}

/** YYYY-MM-DD in `tz`, so "today" means the owner's day. */
export function localDate(at: Date, tz: string): string {
  return localParts(at, tz).date;
}

/** "3 h ago", "45 min ago", "2 days ago". */
export function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "time unknown";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "time unknown";
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
