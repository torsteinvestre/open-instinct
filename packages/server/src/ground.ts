/**
 * [sunshine:grounding] Every message from the owner is grounded before the model answers it: what Sunshine already knows
 * about what it concerns, and what the owner's email and calendar show for it, gathered by code.
 *
 * Why (2026-10-29): Torstein texted "Anything happening next week for me"; Sunshine read his calendar (empty) and asked
 * him for the details of a 3 Nov event it knew of, though they were in his email. Replayed on a copy of his thread
 * (scenarios/look-before-ask.mjs), it never searched email (0/3), with more thinking allowed (0/3, the model judged
 * the text too simple to think about) and without its old questions in the thread (0/3: it then forgot the event and
 * answered from the calendar alone). An instruction to look would still leave looking to the model's diligence, the
 * flaw the memory design (DESIGN-memory-in-the-flow.md) set out to remove. Assistants that know a person's work do it
 * in code: Microsoft 365 Copilot grounds every prompt in the person's mail, calendar and files before the model sees
 * it; Glean answers from its index; Town feeds its wiki into every session. The model's own tools stay for follow-ups.
 *
 * Staged as two calls (Anthropic's prompting guide): a small, fast model reads the message and writes what it concerns,
 * the days it is about and the email searches that may answer it; code runs recall (recall.ts) and the look-up
 * (lookup.ts) on them; the agent then answers with all of it. A greeting or a general question gathers nothing.
 * What is known comes first (first replay, 2026-10-29: 1/3): the small model wrote its searches before it saw that a 3
 * Nov event was known, so it searched for "invitation OR booking" and missed the email, and the agent then said there
 * was nothing in email. Now recall on the message itself goes to the small model, which plans the searches for what
 * is known only in part.
 */
import { wrapUntrusted, type AuditLog, type GroundInput, type InstinctConfig, type MemoryStore } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import type { LookUp } from "./lookup.js";
import type { Recall } from "./recall.js";

/** The grounding step's model (env GROUND_MODEL; "off" grounds nothing): small and fast, since every reply waits for it. */
export const DEFAULT_GROUND_MODEL = "anthropic/claude-haiku-5-5";
const LIST_MAX = 8;
const LINE_MAX = 300;
/** Chats from the last day are in the thread itself; recall brings only older ones. */
const THREAD_DAY_MS = 24 * 60 * 60 * 1000;

export interface GroundAsk {
  needed: boolean;
  about: string[];
  days: string[];
  searches: string[];
}

export function groundSystem(owner: string): string {
  return [
    `You prepare ${owner}'s personal assistant to answer ${owner}'s new message. Before it answers, code gathers what the assistant already knows about what you list and reads ${owner}'s calendar and email for it.`,
    "",
    "Answer with JSON between <ground> and </ground>:",
    `{"needed": true, "about": [], "days": [], "searches": []}`,
    `- needed: false when the answer needs nothing from ${owner}'s own life, plans or records (a greeting, thanks, a general question such as the weather or a fact); then leave the lists empty.`,
    `- about: what the message concerns in ${owner}'s life (people, projects, events, plans, places), each in a few plain words someone would search for, including what it implies: "is the weekend free?" concerns their plans and events that weekend.`,
    `- days: the dates it concerns, worked out from now, as YYYY-MM-DD, or YYYY-MM-DD/YYYY-MM-DD for a span (a week runs Monday to Sunday). Their calendar is read for these.`,
    `- searches: what to search ${owner}'s email for when the answer or part of it may be in an email (invitations, registrations, tickets, bookings, plans with someone named), in Gmail's search words: quote exact phrases and put OR between the ways the same thing may be written. Anything the assistant knows of only in part (an event without its time or place, a booking without its details) gets a search that would find the rest, by its name or its date as an email would write it. A search finds emails by their words and by when they were sent, not by when an event takes place. Empty when email cannot help.`,
  ].join("\n");
}

function list(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => (x.trim().length <= LINE_MAX ? x.trim() : `${x.trim().slice(0, LINE_MAX - 1)}…`)).slice(0, LIST_MAX)
    : [];
}

/** The JSON object in an answer: between <ground> tags, else in a code fence or bare (2026-10-29: 1 answer in 10 unreadable). */
function jsonIn(text: string): string | undefined {
  const tagged = /<ground>\s*([\s\S]*?)\s*<\/ground>/i.exec(text)?.[1];
  const inner = tagged ?? /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  return start >= 0 && end > start ? inner.slice(start, end + 1) : undefined;
}

export function parseGround(text: string): GroundAsk | undefined {
  const json = jsonIn(text);
  if (!json) return undefined;
  try {
    const j = JSON.parse(json) as Record<string, unknown>;
    const ask = { about: list(j.about), days: list(j.days), searches: list(j.searches) };
    return { needed: j.needed !== false && (ask.about.length > 0 || ask.days.length > 0 || ask.searches.length > 0), ...ask };
  } catch {
    return undefined;
  }
}

export interface GroundDeps {
  call: ModelCall;
  config: InstinctConfig;
  memory: MemoryStore;
  audit: AuditLog;
  recall?: Recall;
  lookUp?: LookUp;
  now?: () => Date;
}

export function createGround(deps: GroundDeps): (input: GroundInput) => Promise<string | undefined> {
  const owner = deps.config.owner.name;
  const tz = () => deps.config.owner.timezone || "UTC";
  const now = () => deps.now?.() ?? new Date();
  const when = (d: Date) =>
    `${new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)} ${tz()} (${new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d)})`;

  return async (input) => {
    const started = Date.now();
    const at = now();
    const chatsBefore = at.getTime() - THREAD_DAY_MS;
    const notes = deps.memory.readDurable().trim();
    // What is known about the message itself comes first, so the searches go after what is missing from it.
    const first = deps.recall ? await deps.recall([input.text], { chatsBefore }).catch(() => undefined) : undefined;
    const user = [
      `Now: ${when(at)}.`,
      ...(notes ? ["", `What the assistant knows about ${owner} (their notes):`, "<notes>", notes, "</notes>"] : []),
      ...(first ? ["", "What the assistant has kept that may bear on the new message (earlier conversations and recordings, dated):", wrapUntrusted(first, "what the assistant has kept")] : []),
      ...(input.recent.length ? ["", "The conversation so far, latest last:", ...input.recent.map((r) => `${r.who === "owner" ? owner : "Assistant"}: ${r.text.replace(/\s+/g, " ")}`)] : []),
      "",
      `${owner}'s new message: ${input.text}`,
    ].join("\n");
    // One more try when the answer cannot be read, as the intake's summary does.
    let costUsd = 0;
    let ask: GroundAsk | undefined;
    let last = "";
    for (let attempt = 0; attempt < 2 && !ask; attempt++) {
      const reply = await deps.call({ system: groundSystem(owner), user: attempt === 0 ? user : `${user}\n\nAnswer with the JSON between <ground> and </ground>.` });
      costUsd += reply.costUsd;
      last = reply.text;
      ask = parseGround(reply.text);
    }
    const record = (detail: Record<string, unknown>) => deps.audit.append({ kind: "policy", conversationKey: input.conversationKey, principal: "owner", detail: { grounding: { ...detail, costUsd, ms: Date.now() - started } } });
    if (!ask) {
      record({ outcome: "unreadable", start: last.slice(0, 200) });
      return undefined;
    }
    if (!ask.needed) {
      record({ outcome: "nothing needed" });
      return undefined;
    }
    const [known, live] = await Promise.all([
      deps.recall
        ? deps.recall([input.text, ...ask.about, ...ask.days], { chatsBefore }).then((k) => k ?? null).catch(() => undefined)
        : Promise.resolve(undefined),
      deps.lookUp && (ask.searches.length > 0 || ask.days.length > 0) ? deps.lookUp({ searches: ask.searches, days: ask.days }).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    record({ outcome: "grounded", about: ask.about.length, days: ask.days.length, searches: ask.searches.length, known: known ? "found" : known === null ? "nothing" : "not looked", live: live ? "shown" : "none" });
    if (known === undefined && !live) return undefined;
    return [
      `[Not a message from ${owner}: what Sunshine's own code gathered for the message above, before you answer it. Use it like anything you know; check further where it leaves a gap.]`,
      ...(known
        ? ["What you already know that may bear on it (earlier conversations and kept items, best first; dated, so things may have changed since):", wrapUntrusted(known, "what you already know")]
        : known === null
          ? ["Nothing you have kept seems to bear on it."]
          : []),
      ...(live ? [`What ${owner}'s email and calendar show for it, looked up just now:`, wrapUntrusted(live, "email and calendar")] : []),
    ].join("\n");
  };
}
