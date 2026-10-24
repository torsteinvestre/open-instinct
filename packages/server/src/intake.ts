/**
 * [sunshine:intake] Something that reached the owner from outside their chats with the agent (a
 * conversation the band heard; later email threads, team chat, work sessions in other AI tools): kept
 * in the archive, summarized once, noted in today's journal, then handed to the agent to act on.
 *
 * Staged as separate model calls (Anthropic's prompting guide: classify-then-act is two calls, not
 * numbered steps in one). One call reads the whole item and writes the summary and to-dos; the agent
 * then sees only that, decides what to do, and searches the archive for detail. Run 1 of the meeting
 * test (2026-10-24, one agent run on the raw transcript) filed a decided point as still open, set no
 * reminder for the owner's task, wrote a paragraph into the always-on notes, and could not find the
 * meeting again when asked about it.
 *
 * The journal line is how the owner's own conversation learns the item exists: today's and
 * yesterday's journal are in every owner prompt (MemoryStore.digest); older items are found by search.
 */
import { wrapUntrusted, type ArchiveItem, type AuditLog, type InstinctConfig, type ItemArchive, type ItemSummary, type MemoryStore } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";

/** The model for the summary (env INTAKE_MODEL; "off" keeps items without summarizing them). */
export const DEFAULT_INTAKE_MODEL = "anthropic/claude-sonnet-5-5";
/** Telling settled from open in a long conversation is judgment; a few seconds of thought per item. */
export const INTAKE_REASONING = "medium" as const;
const LIST_MAX = 20;
const LINE_MAX = 400;
const SUMMARY_MAX = 1200;
const JOURNAL_GIST_MAX = 240;
/** How each source reads in the journal and the hand-off, and what may be wrong in what it sends. */
const SOURCES: Record<string, { words: string; caveat?: string }> = {
  band: { words: "heard by the band", caveat: "Speaker names come from voice recognition and the words from speech recognition; both can be wrong." },
};

export interface IntakeItem {
  id: string;
  source: string;
  title?: string;
  startedAt: number;
  endedAt?: number;
  people?: string[];
  text: string;
}

export type IntakeOutcome = "handed over" | "kept, not summarized" | "summary unreadable" | "failed";

export interface IntakeResult {
  outcome: IntakeOutcome;
  summary?: ItemSummary;
  costUsd: number;
  /** The agent's final reply to the hand-off (NO_REPLY when it had nothing to say). */
  reply?: string;
}

export interface IntakeDeps {
  items: ItemArchive;
  memory: MemoryStore;
  config: InstinctConfig;
  audit: AuditLog;
  /** Undefined: items are kept and journaled, not summarized or handed over (INTAKE_MODEL=off). */
  call?: ModelCall;
  /** The agent's turn on the summary: runtime.runSystemTask. */
  runTask: (task: { id: string; name?: string; prompt: string }) => Promise<string>;
}

export interface Intake {
  receive(item: IntakeItem): Promise<IntakeResult>;
}

export function intakeSystem(owner: string, source: string): string {
  const caveat = SOURCES[source]?.caveat;
  return [
    `You read a record of something ${owner} took part in, such as a conversation their wearable recorded, and write down what ${owner}'s personal assistant needs from it.`,
    ...(caveat ? [`${caveat} Go by what the conversation as a whole makes clear.`] : []),
    "",
    "Answer with JSON between <summary> and </summary>:",
    `{"title": "a few words naming it", "summary": "two or three sentences: what it was about and where it ended", "decisions": [], "owner_tasks": [], "others_tasks": [], "open": []}`,
    `- decisions: what was agreed or settled, as the conversation left it. A point counts as settled when the group went with it, even if nobody said "decide".`,
    `- owner_tasks: what ${owner} took on, was asked to do, or offered, with any time or deadline that was said.`,
    `- others_tasks: "Name: what they took on".`,
    "- open: raised and left unsettled.",
    "Each line short and complete on its own, in the plain words someone would later search for. Only what the record supports; empty lists are fine.",
  ].join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function parseSummary(text: string): ItemSummary | undefined {
  const m = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[1]!) as Record<string, unknown>;
    if (typeof j.summary !== "string" || !j.summary.trim()) return undefined;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => clip(x.trim(), LINE_MAX)).slice(0, LIST_MAX) : []);
    return {
      ...(typeof j.title === "string" && j.title.trim() ? { title: clip(j.title.trim(), 120) } : {}),
      summary: clip(j.summary.trim(), SUMMARY_MAX),
      decisions: list(j.decisions),
      ownerTasks: list(j.owner_tasks),
      othersTasks: list(j.others_tasks),
      open: list(j.open),
    };
  } catch {
    return undefined;
  }
}

/** The named speakers of "[12:34] Name: ..." lines, in order of first turn, without the owner or unknown voices. */
export function speakersOf(text: string, owner: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\[[\d:]{4,8}\]\s*([^:\n]{1,40}):/gm)) {
    const name = m[1]!.trim();
    if (name && name !== owner && !/^unknown\b/i.test(name)) seen.add(name);
  }
  return [...seen];
}

function bullets(label: string, lines: string[]): string[] {
  return lines.length > 0 ? [`${label}:`, ...lines.map((l) => `- ${l}`)] : [];
}

export function createIntake(deps: IntakeDeps): Intake {
  const owner = deps.config.owner.name;
  const tz = () => deps.config.owner.timezone || "UTC";
  const day = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
  const clock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const when = (it: ArchiveItem) => `${day(it.startedAt)}, ${clock(it.startedAt)}${it.endedAt ? `-${clock(it.endedAt)}` : ""} ${tz()}`;
  const from = (it: ArchiveItem) => SOURCES[it.source]?.words ?? `from ${it.source}`;
  const withWhom = (it: ArchiveItem) => (it.people?.length ? `, with ${it.people.join(", ")}` : "");

  const record = (it: ArchiveItem, outcome: IntakeOutcome, extra: Record<string, unknown> = {}): void => {
    deps.audit.append({ kind: "policy", conversationKey: `system:intake-${it.id}`, principal: "owner", detail: { intake: outcome, id: it.id, source: it.source, chars: it.text.length, ...extra } });
  };

  const journal = (it: ArchiveItem, gist: string | undefined): void => {
    const what = it.title ?? it.summary?.title ?? "A conversation";
    const until = it.endedAt ? `, until ${clock(it.endedAt)}` : "";
    const text = `${what} (${from(it)}${until}${withWhom(it)})${gist ? `: ${clip(gist, JOURNAL_GIST_MAX)}` : ""} (kept in full)`;
    deps.memory.appendJournal(text.replace(/\s+/g, " "), new Date(it.startedAt));
  };

  async function summarize(it: ArchiveItem, call: ModelCall): Promise<{ summary?: ItemSummary; costUsd: number }> {
    const notes = deps.memory.readDurable().trim();
    const user = [
      ...(notes ? [`What you know about ${owner} (their notes):`, "<notes>", notes, "</notes>", ""] : []),
      `The record: ${it.title ? `"${it.title}", ` : ""}${from(it)}, ${when(it)}${withWhom(it)}.`,
      wrapUntrusted(it.text, `a recording of ${owner}'s conversation`),
    ].join("\n");
    let cost = 0;
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await call({ system: intakeSystem(owner, it.source), user: user + feedback });
      cost += reply.costUsd;
      const summary = parseSummary(reply.text);
      if (summary) return { summary, costUsd: cost };
      feedback = '\n\nAnswer with the JSON between <summary> and </summary>, with at least "summary" filled in.';
    }
    return { costUsd: cost };
  }

  /** What the agent gets: the summary as data, and how to act on it. */
  function handOff(it: ArchiveItem, s: ItemSummary): string {
    const what = it.title ?? s.title ?? "a conversation";
    const caveat = SOURCES[it.source]?.caveat;
    const body = [
      `Summary: ${s.summary}`,
      ...bullets("Decided", s.decisions),
      ...bullets(`${owner}'s tasks`, s.ownerTasks),
      ...bullets("Others' tasks", s.othersTasks),
      ...bullets("Open", s.open),
    ].join("\n");
    return [
      `${owner}'s conversation "${what}" (${from(it)}, ${when(it)}${withWhom(it)}) is now kept in full; history_search finds what was said and by whom.${caveat ? ` ${caveat}` : ""}`,
      "",
      wrapUntrusted(body, "summary of the recording"),
      "",
      `Handle it as a great personal assistant would. Do what is clearly ${owner}'s and easy to undo, such as a reminder for a task of theirs, without asking. Ask about what is unclear or would matter if it were wrong, all questions in one text. Anything that goes to other people, costs money or speaks for ${owner}: ask first.`,
      `The summary is already kept with the conversation and noted in today's journal; your memory notes are for lasting facts about ${owner} and their people.`,
      `Text ${owner} only when something needs them; otherwise end with exactly NO_REPLY.`,
    ].join("\n");
  }

  return {
    async receive(input) {
      const people = input.people?.length ? input.people : speakersOf(input.text, owner);
      const it = deps.items.add({ ...input, ...(people.length ? { people } : {}) });
      if (!deps.call) {
        journal(it, undefined);
        record(it, "kept, not summarized");
        return { outcome: "kept, not summarized", costUsd: 0 };
      }
      let cost = 0;
      try {
        const { summary, costUsd } = await summarize(it, deps.call);
        cost = costUsd;
        if (!summary) {
          journal(it, undefined);
          record(it, "summary unreadable", { costUsd: cost });
          return { outcome: "summary unreadable", costUsd: cost };
        }
        deps.items.setSummary(it.id, summary);
        const kept = deps.items.get(it.id) ?? { ...it, summary };
        journal(kept, summary.summary);
        const reply = await deps.runTask({ id: `intake-${it.id}`, name: kept.title ?? summary.title ?? "conversation", prompt: handOff(kept, kept.summary ?? summary) });
        record(kept, "handed over", { costUsd: cost, ownerTasks: summary.ownerTasks.length, decisions: summary.decisions.length });
        return { outcome: "handed over", summary, costUsd: cost, reply };
      } catch (err) {
        record(it, "failed", { costUsd: cost, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
        return { outcome: "failed", costUsd: cost };
      }
    },
  };
}
