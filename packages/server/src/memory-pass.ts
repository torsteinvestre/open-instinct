/**
 * [sunshine:memory] The nightly memory notes. Once a night, if the owner texted since the last
 * time, one model call reads MEMORY.md and the owner's conversation since then and writes MEMORY.md
 * back: what is still true kept, what changed updated, what is going on for them now under "Lately".
 * The code decides when, checks the answer and keeps a backup; the model decides what a friend would
 * remember. It runs as a gated job: plain code, it never wakes the agent and never texts anyone.
 *
 * Why at night and not when the conversation is trimmed: the notes are in every message's prompt,
 * so changing them by day makes the next message pay for the whole prompt again. At 03:30 nobody
 * waits for it and the prompt cache has long gone cold. Saving still depended on the model calling
 * memory_write during the day; it saved 3 things in 3 days (2026-10-15).
 */
import { readdirSync, rmSync } from "node:fs";
import type { AuditLog, HistoryArchive, InstinctConfig, MemoryStore, Scheduler, StateDir } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { historyThreadEntries, ownerThreadEntries, threadLine, type ThreadEntry } from "./watcher-writer.js";
import { applyChanges, describeNotes, notesSystem, notesUser, parseChanges, readNotes, renderNotes, saveLabels } from "./memory-notes.js";

export const MEMORY_GATE = "memory";
export const MEMORY_PASS_FILE = "memory-pass.json";
/** The model for the notes (env MEMORY_PASS_MODEL; "off" switches the notes off). */
export const DEFAULT_MEMORY_MODEL = "anthropic/claude-sonnet-5-5";
/** Room to think about each line's labels: the pass runs at night, so a few seconds and a cent cost nothing. */
export const MEMORY_REASONING = "medium" as const;
/** The prompt digest shows MEMORY.md in full up to 60% of 4,000 characters; the notes stay inside it. */
export const MEMORY_MAX_CHARS = 2400;
/** 03:30 in the owner's timezone. */
export const MEMORY_PASS_CRON = "30 3 * * *";
/** Conversation read per pass, newest kept when there is more (about 5,000 tokens). */
export const CONVERSATION_MAX_CHARS = 20_000;
const LINE_MAX_CHARS = 600;
const BACKUP_DIR = "memory/backups";
const BACKUPS_KEPT = 7;
const RUNS_KEPT = 30;
/** A rewrite that keeps less than this share of a longer file is refused as a loss, not a tidy-up. */
const SHRINK_FLOOR = 0.4;

export type PassOutcome = "off" | "nothing new" | "no change" | "updated" | "too long" | "dropped too much" | "unreadable" | "failed";

interface PassState {
  /** Newest message (ms) the notes have taken in. */
  lastPassAt?: number;
  scheduleId?: string;
  runs: Array<{ at: string; outcome: PassOutcome; costUsd?: number; chars?: number; error?: string; added?: number; updated?: number; removed?: number; dropped?: number }>;
}

// [sunshine:memory] What the model is asked and how its answer is used: see memory-notes.ts (labelled
// lines since 2026-10-17; before, the model rewrote the whole file as prose).

export interface MemoryPassDeps {
  state: StateDir;
  memory: MemoryStore;
  config: InstinctConfig;
  scheduler: Pick<Scheduler, "create" | "delete" | "get">;
  audit: AuditLog;
  /** Undefined: the notes are off (MEMORY_PASS_MODEL=off). */
  call?: ModelCall;
  now?: () => Date;
  /** [sunshine:history] The kept conversations: with them the notes read the whole day, not what the last trim left. */
  history?: HistoryArchive;
}

export interface MemoryPass {
  /** For RuntimeDeps.scheduleGates: runs the pass and never wakes the agent. */
  gate: () => Promise<boolean>;
  /** One nightly job while on; none while off. Call before the scheduler and the Maritime push read the jobs. */
  ensureStarted(): void;
  run(): Promise<PassOutcome>;
}

export function createMemoryPass(deps: MemoryPassDeps): MemoryPass {
  const now = deps.now ?? (() => new Date());
  const tz = () => deps.config.owner.timezone || "UTC";
  const read = (): PassState => ({ runs: [], ...deps.state.readJson<Partial<PassState>>(MEMORY_PASS_FILE, {}) });
  const write = (s: PassState): void => deps.state.writeJson(MEMORY_PASS_FILE, s);

  const record = (outcome: PassOutcome, extra: { costUsd?: number; chars?: number; error?: string; lastPassAt?: number; added?: number; updated?: number; removed?: number; dropped?: number } = {}): PassOutcome => {
    const s = read();
    const { lastPassAt, ...detail } = extra;
    s.runs = [...s.runs, { at: now().toISOString(), outcome, ...detail }].slice(-RUNS_KEPT);
    if (lastPassAt !== undefined) s.lastPassAt = lastPassAt;
    write(s);
    deps.audit.append({ kind: "policy", conversationKey: "scheduled:memory", principal: "owner", detail: { memoryPass: outcome, ...detail } });
    return outcome;
  };

  const backup = (text: string): void => {
    if (!text.trim()) return;
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    deps.state.writeText(`${BACKUP_DIR}/MEMORY-${stamp}.md`, text);
    const dir = deps.state.path(BACKUP_DIR);
    const files = readdirSync(dir).filter((f) => f.startsWith("MEMORY-")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) rmSync(`${dir}/${f}`, { force: true });
  };

  async function run(): Promise<PassOutcome> {
    if (!deps.call) return "off";
    const s = read();
    const since = s.lastPassAt ?? 0;
    const { entries, summary } = ownerThreadEntries(deps.state, deps.config);
    // [sunshine:history] The kept history has the whole day, also what a trim took out of the live
    // thread; the live thread adds anything not kept yet. One entry per message (who and when).
    const archived = deps.history ? historyThreadEntries(deps.history, deps.state, deps.config, since) : [];
    const byMessage = new Map<string, ThreadEntry>();
    for (const e of [...archived, ...entries.filter((x) => x.ts > since)]) byMessage.set(`${e.who}|${e.ts}`, byMessage.get(`${e.who}|${e.ts}`) ?? e);
    const fresh = [...byMessage.values()].sort((a, b) => a.ts - b.ts);
    // The trim summary is only needed where the kept history does not reach back as far as the live thread.
    const archiveCovers = archived.length > 0 && archived[0]!.ts <= (entries[0]?.ts ?? Number.POSITIVE_INFINITY);
    // Nothing the owner said since the last pass: no model call.
    if (!fresh.some((e) => e.who === "owner")) return record("nothing new");
    const newest = Math.max(...fresh.map((e) => e.ts));

    // What they said since the last pass, newest kept within the budget; a fold since then left part
    // of it only in the trimmed conversation's summary, so that comes first.
    const lines = fresh.map((e) => threadLine(e, LINE_MAX_CHARS, true)); // [sunshine:memory] replies say what they read
    if (summary && summary.ts > since && !archiveCovers) lines.unshift("Shortened earlier part of the conversation:", summary.text, "", "Then:"); // [sunshine:history] !archiveCovers
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0 && size + lines[i]!.length + 1 <= CONVERSATION_MAX_CHARS; i--) {
      kept.unshift(lines[i]!);
      size += lines[i]!.length + 1;
    }
    const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now());
    const isoToday = new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now());
    const old = deps.memory.readDurable();
    const owner = deps.config.owner.name;
    // [sunshine:memory] The notes as labelled lines; the model proposes changes, code applies them.
    const before = readNotes(old, deps.state);
    const system = notesSystem(deps.config.agent.name, owner);

    let cost = 0;
    let feedback: string | undefined;
    let outcome: PassOutcome = "unreadable";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await deps.call({ system, user: notesUser({ today, isoToday, notes: describeNotes(before, owner, isoToday), conversation: kept.join("\n"), ...(feedback ? { feedback } : {}) }) });
        cost += reply.costUsd;
        const changes = parseChanges(reply.text);
        if (!changes) {
          outcome = "unreadable";
          feedback = 'Answer with JSON between <changes> and </changes>: {"changes": [...]}.';
          continue;
        }
        const applied = applyChanges(before, changes, isoToday);
        // What was wrong (an unknown id, a missing label, an unlabeled note left) goes back once; the
        // second answer is used as it is, its invalid changes left out.
        if (applied.problems.length > 0 && attempt === 0) {
          outcome = "unreadable";
          feedback = applied.problems.join("\n");
          continue;
        }
        const text = renderNotes(applied.notes, owner);
        const counts = { added: applied.added, updated: applied.updated, removed: applied.removed.length, dropped: applied.dropped.length };
        if (text.length > MEMORY_MAX_CHARS) {
          outcome = "too long";
          feedback = `The notes come to ${text.length} characters; they must stay under ${MEMORY_MAX_CHARS}. Merge notes or remove what matters least.`;
          continue;
        }
        // Kept the old notes: losing this many lines in one night is a loss, not a tidy-up.
        if (before.length >= 8 && applied.removed.length + applied.dropped.length > before.length * (1 - SHRINK_FLOOR)) return record("dropped too much", { costUsd: cost, chars: text.length, ...counts });
        if (text.trim() === old.trim()) {
          saveLabels(deps.state, applied.notes);
          return record("no change", { costUsd: cost, lastPassAt: newest });
        }
        backup(old);
        deps.memory.replaceDurable(text);
        saveLabels(deps.state, applied.notes);
        // Every line removed or kept out, with the reason, so "what did you forget?" has an answer in the log.
        const changed = [...applied.removed.map((r) => `removed "${r.text}": ${r.why}`), ...applied.dropped.map((d) => `kept out "${d.text}": ${d.why}`)];
        if (changed.length > 0) deps.audit.append({ kind: "policy", conversationKey: "scheduled:memory", principal: "owner", detail: { memoryChanges: changed.slice(0, 30) } });
        return record("updated", { costUsd: cost, chars: text.length, lastPassAt: newest, ...counts });
      }
      // Twice refused: the old notes stay, and the same conversation is read again next night.
      return record(outcome, { costUsd: cost });
    } catch (err) {
      return record("failed", { costUsd: cost, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
    }
  }

  return {
    gate: async () => {
      await run();
      return false;
    },
    ensureStarted() {
      const s = read();
      const job = s.scheduleId ? deps.scheduler.get(s.scheduleId) : undefined;
      if (!deps.call) {
        if (job) deps.scheduler.delete(job.id);
        if (s.scheduleId) write({ ...s, scheduleId: undefined } as PassState);
        return;
      }
      if (job && job.cron === MEMORY_PASS_CRON && job.tz === tz() && job.gate === MEMORY_GATE) return;
      if (job) deps.scheduler.delete(job.id);
      const entry = deps.scheduler.create({
        name: "memory notes",
        prompt: "Update the memory notes. (Runs in code; the agent is not woken.)",
        cron: MEMORY_PASS_CRON,
        tz: tz(),
        enabled: true,
        gate: MEMORY_GATE,
        toolRepliesOnly: true,
      });
      write({ ...read(), scheduleId: entry.id });
    },
    run,
  };
}
