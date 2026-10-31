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
 * [sunshine:fixed-form] The summary comes in a fixed form (structured outputs, SUMMARY_SCHEMA); it was JSON between
 * tags, asked for once more when it could not be read.
 *
 * The journal line is how the owner's own conversation learns the item exists: today's and
 * yesterday's journal are in every owner prompt (MemoryStore.digest); older items are found by search.
 *
 * [sunshine:in-the-flow] The hand-off brings what is already known (recall.ts), what the email and calendar show now for
 * what is unclear (lookup.ts, read by code) and the email and calendar tools along. His first voice note (2026-10-27)
 * was answered with a question whose answer was in his email.
 *
 * [sunshine:acting] How to act on it (look before asking, where doing ends by the owner's setting, heard is not typed,
 * ask before anything outward) is the owner's one rule in the system prompt (acting.ts), the same as for their own
 * messages; the hand-off points to it.
 */
import { wrapUntrusted, type ArchiveItem, type AuditLog, type InstinctConfig, type ItemArchive, type ItemSummary, type MemoryStore } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import type { Recall } from "./recall.js";
import { weeksLine, type LookUp, type LookUpAsk } from "./lookup.js";

/** The model for the summary (env INTAKE_MODEL; "off" keeps items without summarizing them). */
export const DEFAULT_INTAKE_MODEL = "anthropic/claude-sonnet-5-5";
/** Telling settled from open in a long conversation is judgment; a few seconds of thought per item. */
export const INTAKE_REASONING = "medium" as const;
/**
 * [sunshine:flowing-in] The model for short sources that come many a day (an email, a calendar change; env
 * INTAKE_SMALL_MODEL; "off" reads them with INTAKE_MODEL). The 29 Oct design: Haiku in a fixed form per email.
 */
export const DEFAULT_INTAKE_SMALL_MODEL = "anthropic/claude-haiku-5-5";
export const INTAKE_SMALL_REASONING = "low" as const;
const LIST_MAX = 20;
const LINE_MAX = 400;
const SUMMARY_MAX = 1200;
const JOURNAL_GIST_MAX = 240;
/**
 * How each source reads in the journal and the hand-off, and what may be wrong in what it sends. [sunshine:hindsight] Also
 * each item's context line in Hindsight.
 */
export const SOURCES: Record<string, SourceInfo> = {
  band: { words: "heard by the band", caveat: "Speaker names come from voice recognition and the words from speech recognition; both can be wrong." },
  // [sunshine:recordings] A recording the owner made on their phone and sent. [sunshine:flowing-in] onPurpose
  recording: { words: "recorded on their phone", caveat: "Speaker names come from voice recognition and the words from speech recognition; both can be wrong. Voices without a known print show as \"Speaker 1\", \"Speaker 2\".", onPurpose: true },
  // [sunshine:flowing-in] The owner's apps (flowing-in.ts), each item one email or one calendar change.
  email: { words: "received by email", noun: "email", record: (owner) => `an email ${owner} received`, small: true },
  "email-sent": { words: "sent from their email", noun: "email", record: (owner) => `an email ${owner} sent`, small: true },
  calendar: { words: "from their calendar", noun: "calendar change", record: (owner) => `a change in ${owner}'s calendar`, small: true },
};

export interface SourceInfo {
  /** How it reads in the journal and the hand-off: "recorded on their phone". */
  words: string;
  /** What may be wrong in what it sends. */
  caveat?: string;
  /** [sunshine:flowing-in] What one item is, for the reading and Hindsight ("an email Torstein received"); unset: a conversation. */
  record?: (owner: string) => string;
  /** [sunshine:flowing-in] Its name in the hand-off ("email"); unset: conversation. */
  noun?: string;
  /**
   * [sunshine:flowing-in] The owner sent it on purpose (a voice note is a request, like a text): always handed over.
   * Anything else arrives by itself and is handed over only when the reading finds something for the assistant
   * (`needs`); most email is only worth remembering, and an agent turn costs cents each.
   */
  onPurpose?: boolean;
  /** [sunshine:flowing-in] Short and many a day: read by the small model. */
  small?: boolean;
}

export interface IntakeItem {
  id: string;
  source: string;
  title?: string;
  startedAt: number;
  endedAt?: number;
  people?: string[];
  text: string;
}

// [sunshine:flowing-in] "kept, nothing to act on": read, nothing for the assistant; "kept as is": not read (keepOnly).
export type IntakeOutcome = "handed over" | "kept, not summarized" | "kept, nothing to act on" | "kept as is" | "summary unreadable" | "failed";

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
  /** [sunshine:flowing-in] Reads the sources marked `small`; unset: `call` reads them. */
  smallCall?: ModelCall;
  /** The agent's turn on the summary: runtime.runSystemTask. */
  runTask: (task: { id: string; name?: string; prompt: string; load?: string[] }) => Promise<string>;
  /** [sunshine:in-the-flow] What is already known about the item's subjects (needs meaning search). */
  recall?: Recall;
  /** [sunshine:in-the-flow] Tool groups the hand-off starts with ("apps": email and calendar). */
  load?: string[];
  /** [sunshine:in-the-flow] Email and calendar read by code for what the summary says is unclear (lookup.ts). */
  lookUp?: LookUp;
}

export interface Intake {
  /**
   * [sunshine:flowing-in] `keepOnly`: keep and journal it with this note ("added by Sunshine"), without reading it or
   * handing it over: the owner's own calendar entry, or Sunshine's own change coming back.
   */
  receive(item: IntakeItem, opts?: { keepOnly?: string }): Promise<IntakeResult>;
}

const LINES = { type: "array", items: { type: "string" } };
/** [sunshine:fixed-form] The form the summary must fill (structured outputs), so it can always be read. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, summary: { type: "string" }, decisions: LINES, owner_tasks: LINES, others_tasks: LINES, open: LINES, to_settle: LINES, searches: LINES, days: LINES },
  required: ["title", "summary", "decisions", "owner_tasks", "others_tasks", "open", "to_settle", "searches", "days"],
  additionalProperties: false,
};
/**
 * [sunshine:flowing-in] What in an item may need the assistant, each with its kind; the code decides from the kind
 * (QUIET_NEEDS), so the line is drawn here, not in the reading's judgment. The gate check on his real email (2026-10-31,
 * scenarios/gate-real.mjs): with one free-form list, 15 of 70 emails that ask nothing were handed over, 13 of them codes,
 * resets and sign-in notices for what he did himself ("if this wasn't you ...") or notices that ask nothing.
 */
export const NEED_KINDS = ["event", "request", "deadline", "change", "promise", "offer", "own_action", "if_not_you", "info"] as const;
/** [sunshine:flowing-in] Kinds that never call for the agent on their own. Any other kind, or none, goes to the agent. */
export const QUIET_NEEDS: ReadonlySet<string> = new Set(["own_action", "if_not_you", "info"]);
export interface Need {
  /** One of NEED_KINDS; empty when the reading gave none (it then goes to the agent). */
  kind: string;
  what: string;
}
const NEEDS = {
  type: "array",
  items: { type: "object", properties: { kind: { type: "string", enum: [...NEED_KINDS] }, what: { type: "string" } }, required: ["kind", "what"], additionalProperties: false },
};
/** [sunshine:flowing-in] The form for what arrives by itself: the same, and what in it may need the assistant now. */
export const GATED_SUMMARY_SCHEMA = {
  ...SUMMARY_SCHEMA,
  properties: { ...SUMMARY_SCHEMA.properties, needs: NEEDS },
  required: [...SUMMARY_SCHEMA.required, "needs"],
};

/** [sunshine:flowing-in] Whether every item of this source goes to the agent, or only one the reading finds work in. */
export function gated(source: string): boolean {
  return SOURCES[source]?.onPurpose !== true;
}

export function intakeSystem(owner: string, source: string): string {
  const caveat = SOURCES[source]?.caveat;
  const record = SOURCES[source]?.record; // [sunshine:flowing-in]
  return [
    record
      ? `You read ${record(owner)} and write down what ${owner}'s personal assistant needs from it.`
      : `You read a record of something ${owner} took part in, such as a conversation their wearable recorded, and write down what ${owner}'s personal assistant needs from it.`,
    ...(caveat ? [`${caveat} Go by what the conversation as a whole makes clear.`] : []),
    "",
    "Answer with JSON:",
    `{"title": "a few words naming it", "summary": "two or three sentences: what it was about and where it ended", "decisions": [], "owner_tasks": [], "others_tasks": [], "open": [], "to_settle": [], "searches": [], "days": []${gated(source) ? `, "needs": []` : ""}}`,
    `- decisions: what was agreed or settled, as the conversation left it. A point counts as settled when the group went with it, even if nobody said "decide".`,
    `- owner_tasks: what ${owner} took on, was asked to do, or offered, with any time or deadline that was said.`,
    `- others_tasks: "Name: what they took on".`,
    // Run 2 (2026-10-24): "whether to target a younger group" was kept without the answer given to it.
    "- open: raised and left unsettled, each with where it was left: the last view stated, and by whom.",
    // [sunshine:in-the-flow] What the agent looks up before asking (2026-10-27: "the event on 3 Nov" was in the email).
    `- to_settle: what ${owner}'s tasks need that the record leaves out or unsure (which event, what time, which people, which file), each as a short question an assistant could answer from ${owner}'s email, calendar or earlier conversations. Empty when the tasks are clear.`,
    // [sunshine:in-the-flow] Code runs these before the hand-off (lookup.ts): the 2026-10-27 live check asked instead of searching.
    `- searches: for each to_settle point ${owner}'s email may answer, what to search their email for, in Gmail's search words: quote exact phrases and put OR between the ways the same thing may be written (for example "12 May" OR "May 12").`,
    `- days: the dates ${owner}'s tasks and open points are about, worked out from the day the record was made, as YYYY-MM-DD, or YYYY-MM-DD/YYYY-MM-DD for a span such as "next week". Their calendar is read for these days.`,
    // [sunshine:flowing-in] What decides whether the agent gets it at all (gated sources only).
    ...(gated(source)
      ? [`- needs: what in it may call for the assistant to do something or tell ${owner} now, each as {"kind": ..., "what": "short"}. Kinds: "event" (an event ${owner} is going to or is invited to: tickets, a registration, an invitation, even when nothing is asked), "request" (someone asks ${owner} to do something), "deadline" (something ${owner} must do or decide by a date, or something ${owner} has that ends on a date, such as a plan, a trial or access), "change" (a change to ${owner}'s plans), "promise" (something ${owner} promised), "offer" (a deal or an event on offer), "own_action" (a code, link or confirmation for something ${owner} is doing themselves just now), "if_not_you" (matters only if ${owner} did not do it themselves), "info" (tells something and asks nothing of ${owner}, and is none of the kinds above). Empty when it is only worth remembering.`]
      : []),
    "Each line short and complete on its own, in the plain words someone would later search for. Only what the record supports; empty lists are fine.",
    // [sunshine:in-the-flow] 2026-10-27: a summary's guess that a concert was "not in the calendar yet" was kept, and the agent offered to add one already there.
    "The record tells what was said and asked for, not what is in a calendar, an inbox or another app now: the assistant reads those live, so leave their state out.",
  ].join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function parseSummary(text: string): ItemSummary | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.summary !== "string" || !j.summary.trim()) return undefined;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => clip(x.trim(), LINE_MAX)).slice(0, LIST_MAX) : []);
    return {
      ...(typeof j.title === "string" && j.title.trim() ? { title: clip(j.title.trim(), 120) } : {}),
      summary: clip(j.summary.trim(), SUMMARY_MAX),
      decisions: list(j.decisions),
      ownerTasks: list(j.owner_tasks),
      othersTasks: list(j.others_tasks),
      open: list(j.open),
      ...(list(j.to_settle).length > 0 ? { toSettle: list(j.to_settle) } : {}), // [sunshine:in-the-flow]
    };
  } catch {
    return undefined;
  }
}

/**
 * [sunshine:in-the-flow] What the summary asks to look up (email searches, days). Not part of the kept summary: it is
 * for this hand-off only, and the state it finds is read again live whenever it matters.
 */
export function parseAsk(text: string): LookUpAsk {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => clip(x.trim(), LINE_MAX)).slice(0, LIST_MAX) : []);
    return { searches: list(j.searches), days: list(j.days) };
  } catch {
    return { searches: [], days: [] };
  }
}

/**
 * [sunshine:flowing-in] What the reading says may need the assistant now; for this hand-off only, like the ask. A plain
 * line (no kind) is read as a need of no kind, which goes to the agent.
 */
export function parseNeeds(text: string): Need[] {
  try {
    const v = (JSON.parse(text) as Record<string, unknown>).needs;
    if (!Array.isArray(v)) return [];
    const out: Need[] = [];
    for (const x of v) {
      const o = x && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
      const what = typeof x === "string" ? x : typeof o?.what === "string" ? o.what : "";
      if (!what.trim()) continue;
      out.push({ kind: typeof o?.kind === "string" ? o.kind.trim().toLowerCase() : "", what: clip(what.trim(), LINE_MAX) });
    }
    return out.slice(0, LIST_MAX);
  } catch {
    return [];
  }
}

/** [sunshine:flowing-in] The needs that call for the agent: every kind but the quiet ones. */
export function needsForAgent(needs: Need[]): Need[] {
  return needs.filter((n) => !QUIET_NEEDS.has(n.kind));
}

/** The named speakers of "[12:34] Name: ..." lines, in order of first turn, without the owner or unknown voices. */
export function speakersOf(text: string, owner: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\[[\d:]{4,8}\]\s*([^:\n]{1,40}):/gm)) {
    const name = m[1]!.trim();
    // [sunshine:recordings] "Speaker 2" is a voice without a name, not a person.
    if (name && name !== owner && !/^unknown\b/i.test(name) && !/^speaker \d+$/i.test(name)) seen.add(name);
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
    // [sunshine:recordings] Start and end in the owner's time, the zone named: the journal's own stamp in front of the
    // line is the machine's clock (UTC on Maritime), and "until 14:15" beside a "12:52" stamp read as a 1.5-hour meeting.
    const span = `${clock(it.startedAt)}${it.endedAt ? `-${clock(it.endedAt)}` : ""} ${tz()}`;
    const text = `${what} (${from(it)}, ${span}${withWhom(it)})${gist ? `: ${clip(gist, JOURNAL_GIST_MAX)}` : ""} (kept in full)`;
    deps.memory.appendJournal(text.replace(/\s+/g, " "), new Date(it.startedAt));
  };

  // [sunshine:in-the-flow] The record's date with its year, for the summary's days.
  const isoDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

  async function summarize(it: ArchiveItem, call: ModelCall): Promise<{ summary?: ItemSummary; ask?: LookUpAsk; needs?: Need[]; costUsd: number }> {
    const notes = deps.memory.readDurable().trim();
    const record = SOURCES[it.source]?.record; // [sunshine:flowing-in]
    const user = [
      ...(notes ? [`What you know about ${owner} (their notes):`, "<notes>", notes, "</notes>", ""] : []),
      `The record: ${it.title ? `"${it.title}", ` : ""}${from(it)}, ${when(it)}${withWhom(it)}.`,
      `It was made on ${isoDay(it.startedAt)}. From that day: ${weeksLine(new Date(it.startedAt), tz())}`, // [sunshine:in-the-flow] [sunshine:grounding] the weeks
      wrapUntrusted(it.text, record ? record(owner) : `a recording of ${owner}'s conversation`),
    ].join("\n");
    const reply = await call({ system: intakeSystem(owner, it.source), user, schema: gated(it.source) ? GATED_SUMMARY_SCHEMA : SUMMARY_SCHEMA });
    const summary = parseSummary(reply.text);
    return summary ? { summary, ask: parseAsk(reply.text), needs: parseNeeds(reply.text), costUsd: reply.costUsd } : { costUsd: reply.costUsd };
  }

  /**
   * What the agent gets: the summary and what is already known, as data, and how to act on them. `known`: what recall
   * found; null when it found nothing; undefined when nothing was looked up (no meaning search, or it failed). `live`:
   * what the email and calendar showed just now, when anything was looked up there.
   */
  function handOff(it: ArchiveItem, s: ItemSummary, known: string | null | undefined, live?: string, needs: string[] = []): string {
    const what = it.title ?? s.title ?? "a conversation";
    const caveat = SOURCES[it.source]?.caveat;
    const noun = SOURCES[it.source]?.noun; // [sunshine:flowing-in]
    const body = [
      `Summary: ${s.summary}`,
      ...bullets("Decided", s.decisions),
      ...bullets(`${owner}'s tasks`, s.ownerTasks),
      ...bullets("Others' tasks", s.othersTasks),
      ...bullets("Open", s.open),
      ...bullets("Still unclear", s.toSettle ?? []), // [sunshine:in-the-flow]
      ...bullets("May need you now", needs), // [sunshine:flowing-in]
    ].join("\n");
    return [
      `${owner}'s ${noun ?? "conversation"} "${what}" (${from(it)}, ${when(it)}${withWhom(it)}) is now kept in full; history_search finds what was said and by whom.${caveat ? ` ${caveat}` : ""}`,
      "",
      wrapUntrusted(body, noun ? `summary of the ${noun}` : "summary of the recording"),
      "",
      // [sunshine:in-the-flow] What is already known comes with it, so it is part of the decision, not a search to remember.
      ...(known
        ? ["What you already know that may bear on it (earlier conversations and kept items, best first; dated, so things may have changed since):", wrapUntrusted(known, "what you already know"), ""]
        : known === null
          ? ["Nothing you have kept seems to bear on it.", ""]
          : []),
      // [sunshine:in-the-flow] Read by code just now, so looking is not left to remembering to look.
      ...(live ? [`What ${owner}'s email and calendar show for it, looked up just now for what is still unclear and the days it is about:`, wrapUntrusted(live, "email and calendar"), ""] : []),
      // [sunshine:acting] The owner's one rule (acting.ts, in the system prompt) says how; this item is what it applies to.
      `Handle it as you handle everything for ${owner} (How you act for ${owner}), starting from what is above.`,
      `The summary is already kept with the conversation and noted in today's journal; your memory notes are for lasting facts about ${owner} and their people.`,
      `Text ${owner} when there is something to tell or ask; otherwise end with exactly NO_REPLY.`,
    ].join("\n");
  }

  /**
   * [sunshine:in-the-flow] What is known about what the item is about (null: nothing); never stops the hand-off.
   * [sunshine:hindsight] With the days the summary asked about, for recall by when things happen.
   */
  async function knownAbout(it: ArchiveItem, s: ItemSummary, days: string[] = []): Promise<string | null | undefined> {
    if (!deps.recall) return undefined;
    const queries = [it.title ?? s.title ?? "", ...s.ownerTasks, ...(s.toSettle ?? []), ...s.open];
    try {
      return (await deps.recall(queries, { exclude: it.id, ...(days.length > 0 ? { days } : {}) })) ?? null;
    } catch (err) {
      deps.audit.append({ kind: "error", detail: { recall: "failed", id: it.id, message: String(err instanceof Error ? err.message : err).slice(0, 300) } });
      return undefined;
    }
  }

  /** [sunshine:in-the-flow] What the email and calendar show for what the summary asked; never stops the hand-off. */
  async function liveAbout(it: ArchiveItem, ask: LookUpAsk | undefined): Promise<string | undefined> {
    if (!deps.lookUp || !ask || (ask.searches.length === 0 && ask.days.length === 0)) return undefined;
    try {
      return await deps.lookUp(ask);
    } catch (err) {
      deps.audit.append({ kind: "error", detail: { lookUp: "failed", id: it.id, message: String(err instanceof Error ? err.message : err).slice(0, 300) } });
      return undefined;
    }
  }

  return {
    async receive(input, opts = {}) {
      const people = input.people?.length ? input.people : speakersOf(input.text, owner);
      const it = deps.items.add({ ...input, ...(people.length ? { people } : {}) });
      // [sunshine:flowing-in] The owner's own change, or Sunshine's coming back: kept with its note, nothing to read or tell.
      if (opts.keepOnly) {
        journal(it, opts.keepOnly);
        record(it, "kept as is", { note: opts.keepOnly });
        return { outcome: "kept as is", costUsd: 0 };
      }
      // [sunshine:flowing-in] Short sources by the small model when there is one.
      const call = SOURCES[it.source]?.small && deps.smallCall ? deps.smallCall : deps.call;
      if (!call) {
        journal(it, undefined);
        record(it, "kept, not summarized");
        return { outcome: "kept, not summarized", costUsd: 0 };
      }
      let cost = 0;
      try {
        const { summary, ask, needs = [], costUsd } = await summarize(it, call);
        cost = costUsd;
        if (!summary) {
          journal(it, undefined);
          record(it, "summary unreadable", { costUsd: cost });
          return { outcome: "summary unreadable", costUsd: cost };
        }
        deps.items.setSummary(it.id, summary);
        const kept = deps.items.get(it.id) ?? { ...it, summary };
        journal(kept, summary.summary);
        const s = kept.summary ?? summary;
        // [sunshine:flowing-in] What arrived by itself goes to the agent only when the reading found something for it,
        // of a kind that calls for it; the kinds are kept in the audit either way.
        const forAgent = needsForAgent(needs);
        const kinds = needs.length > 0 ? { needs: needs.map((n) => n.kind || "?") } : {};
        if (gated(it.source) && forAgent.length === 0) {
          record(kept, "kept, nothing to act on", { costUsd: cost, ...kinds });
          return { outcome: "kept, nothing to act on", summary, costUsd: cost };
        }
        const [known, live] = await Promise.all([knownAbout(kept, s, ask?.days), liveAbout(kept, ask)]); // [sunshine:in-the-flow] [sunshine:hindsight] days
        const reply = await deps.runTask({ id: `intake-${it.id}`, name: kept.title ?? summary.title ?? "conversation", prompt: handOff(kept, s, known, live, forAgent.map((n) => n.what)), ...(deps.load?.length ? { load: deps.load } : {}) });
        record(kept, "handed over", { costUsd: cost, ownerTasks: summary.ownerTasks.length, decisions: summary.decisions.length, ...kinds });
        return { outcome: "handed over", summary, costUsd: cost, reply };
      } catch (err) {
        record(it, "failed", { costUsd: cost, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
        return { outcome: "failed", costUsd: cost };
      }
    },
  };
}
