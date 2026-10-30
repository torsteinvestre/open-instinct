/**
 * [sunshine:action-log] What Sunshine did in the owner's apps, written by code as it happens: one line for each call
 * that changes something (an event added, an email sent), with the ids the app answered with. Append-only, on the
 * agent's own disk, never written by the model.
 *
 * Its first job (2026-10-30): when such a change comes back through a source that flows in (the calendar reports the
 * event Sunshine just added), it is known as Sunshine's own and not acted on again (server flowing-in.ts). Google
 * cannot tell: Sunshine acts through the owner's own account, so its changes look like the owner's. Agreed with
 * Torstein as its own record, connected to memory; why it was done, the read-back and undo come later on these lines.
 */
import { HISTORY_KEEP_DAYS } from "./history.js";
import type { StateDir } from "./state.js";

export const ACTIONS_FILE = "history/actions.jsonl";
/** Ids kept per call: an event or a message and its thread; a batch has a few each. */
const IDS_MAX = 50;
const ID_MIN = 4;
const ID_MAX = 200;
const DEPTH_MAX = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActionEntry {
  at: number;
  conversationKey: string;
  /** The tool the agent called. */
  tool: string;
  /** The app actions in it that change something (Composio slugs). */
  actions: string[];
  ok: boolean;
  /** Ids in the app's answer: the event, message or thread made or changed. */
  ids: string[];
  /** One line, as the audit log describes the call. */
  summary?: string;
}

export class ActionLog {
  constructor(
    private readonly state: StateDir,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  append(entry: Omit<ActionEntry, "at"> & { at?: number }): ActionEntry {
    const e: ActionEntry = { ...entry, at: entry.at ?? this.now(), ids: entry.ids.slice(0, IDS_MAX) };
    this.state.appendLine(ACTIONS_FILE, JSON.stringify(e));
    return e;
  }

  /** Entries from `sinceMs` on, oldest first; nothing older than the history's age limit. */
  since(sinceMs: number): ActionEntry[] {
    const floor = Math.max(sinceMs, this.now() - HISTORY_KEEP_DAYS * DAY_MS);
    const out: ActionEntry[] = [];
    for (const line of this.state.readLines(ACTIONS_FILE)) {
      try {
        const e = JSON.parse(line) as ActionEntry;
        if (typeof e.at === "number" && e.at >= floor && Array.isArray(e.ids)) out.push(e);
      } catch {
        // A torn last line from a crash mid-write; skipping it is the right recovery.
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Sunshine's own successful change that the app answered with `id`, from `sinceMs` on (the latest). */
  did(id: string, sinceMs: number): ActionEntry | undefined {
    if (!id) return undefined;
    return this.since(sinceMs)
      .filter((e) => e.ok && e.ids.includes(id))
      .at(-1);
  }
}

/**
 * Ids anywhere in an app's answer: the string values of keys named `id`, `...Id` or `..._id`, with JSON text parsed
 * (a tool result is text blocks holding JSON). Composio nests each action's answer differently, so the whole answer is
 * walked rather than one path trusted.
 */
export function idsIn(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (out.size >= IDS_MAX || depth > DEPTH_MAX || v == null) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          walk(JSON.parse(t), depth + 1);
        } catch {
          // Plain text that only starts like JSON.
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((typeof x === "string" || typeof x === "number") && /^(id|.+_id|.+Id|.+ID)$/.test(k)) {
        const s = String(x).trim();
        if (s.length >= ID_MIN && s.length <= ID_MAX) out.add(s);
      } else {
        walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  return [...out].slice(0, IDS_MAX);
}
