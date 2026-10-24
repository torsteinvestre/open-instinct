/**
 * The gateway relays Inkbox events through Maritime's plain `/chat` endpoint. To
 * tell an event apart from a human typing in the dashboard, the JSON is prefixed
 * with a marker no person would type.
 */
import { EVENT_ENVELOPE_PREFIX } from "./types.js";

export function encodeEvent(event: unknown): string {
  return EVENT_ENVELOPE_PREFIX + JSON.stringify(event);
}

/**
 * A task the operator's front door asks the agent to run as its owner, without
 * anyone having texted: research before the first contact, a one-off reminder.
 * `quiet` keeps the result out of the owner's messages (memory and schedules only).
 */
export const SYSTEM_TASK_EVENT = "system.task";

export interface SystemTaskEvent {
  type: typeof SYSTEM_TASK_EVENT;
  /** Stable id; the conversation key is `system:<id>` so a repeat continues the same thread. */
  id: string;
  name?: string;
  prompt: string;
  quiet?: boolean;
}

export function systemTaskOf(event: unknown): SystemTaskEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== SYSTEM_TASK_EVENT) return undefined;
  if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(e.id)) return undefined;
  if (typeof e.prompt !== "string" || !e.prompt.trim()) return undefined;
  const task: SystemTaskEvent = { type: SYSTEM_TASK_EVENT, id: e.id, prompt: e.prompt };
  if (typeof e.name === "string" && e.name) task.name = e.name;
  if (e.quiet === true) task.quiet = true;
  return task;
}

/**
 * [sunshine:intake] Something that reached the owner outside their chats, sent by Sunshine's own
 * backend: a conversation the band heard (transcribed, with speakers named), later other sources.
 * The agent keeps it, summarizes it once and acts on it (server/src/intake.ts).
 */
export const INTAKE_ITEM_EVENT = "intake.item";

export interface IntakeItemEvent {
  type: typeof INTAKE_ITEM_EVENT;
  /** Stable id; the same id again replaces the item. */
  id: string;
  /** "band", later "email", "slack", "claude-code", ... */
  source: string;
  title?: string;
  /** ISO times. */
  startedAt: string;
  endedAt?: string;
  people?: string[];
  /** One line per turn, e.g. "[12:34] Sarah: ...". */
  text: string;
}

export function intakeItemOf(event: unknown): IntakeItemEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== INTAKE_ITEM_EVENT) return undefined;
  if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(e.id)) return undefined;
  if (typeof e.source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(e.source)) return undefined;
  if (typeof e.startedAt !== "string" || Number.isNaN(Date.parse(e.startedAt))) return undefined;
  if (typeof e.text !== "string" || !e.text.trim()) return undefined;
  const item: IntakeItemEvent = { type: INTAKE_ITEM_EVENT, id: e.id, source: e.source.toLowerCase(), startedAt: e.startedAt, text: e.text };
  if (typeof e.title === "string" && e.title.trim()) item.title = e.title.trim().slice(0, 200);
  if (typeof e.endedAt === "string" && !Number.isNaN(Date.parse(e.endedAt))) item.endedAt = e.endedAt;
  if (Array.isArray(e.people)) {
    const people = e.people.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim().slice(0, 80));
    if (people.length > 0) item.people = people.slice(0, 50);
  }
  return item;
}

/** Returns the event, or undefined when the message is ordinary text or malformed. */
export function decodeEvent(message: string): unknown | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(EVENT_ENVELOPE_PREFIX)) return undefined;
  const body = trimmed.slice(EVENT_ENVELOPE_PREFIX.length).trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export function isEnvelope(message: string): boolean {
  return typeof message === "string" && message.trimStart().startsWith(EVENT_ENVELOPE_PREFIX);
}
