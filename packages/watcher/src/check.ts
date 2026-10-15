/**
 * [sunshine:watcher] One news check, start to finish, in code:
 *   1. fences first: off, quiet hours, the daily model budget
 *   2. collect: Google News per search, last day, nothing seen before, Jev sieve  (scan.ts)
 *   3. screen: a cheap model drops clear noise (off unless the operator names one) (step 1)
 *   4. decide: a stronger model applies the playbook                              (step 2)
 *   4b. write: the text as the agent itself, with what it knows and a web search   (step 3)
 *   5. the door: checks the decision against the facts, then texts, keeps, remembers
 * No headline means no model call. Nothing is texted without step 2's decision passing the door.
 * Every check leaves one "check" entry in the audit log with what happened and what it cost.
 */
import type { AuditLog, InstinctConfig, Lookup, Outbox, Principal } from "@open-instinct/core";
import { ago, inQuietHours, localDate } from "./clock.js";
import { checkDecision, parseDecision, parseScreen, type Decision, type NewStory, type StoryUpdate } from "./decide.js";
import type { RelevanceSieve } from "./jev.js";
import type { ModelCall } from "./models.js";
import { DECIDE_SYSTEM, INTERESTS_QUESTION, SCREEN_SYSTEM, decideUser, parseWritten, screenUser, writeSystem, writeUser, type PromptHeadline, type WriteStory, type WriterContext } from "./prompts.js";
import { headlineKeys, runScan, type Candidate } from "./scan.js";
import { JOURNAL_SIEVE_MAX, newCardId, type JournalItem, type StoryCard, type WatchState, type WatchStore } from "./store.js";

/** Unprompted watcher texts per owner day. A fuse: reaching it means the judgment is too loose. */
export const DAILY_TEXT_LIMIT = 6;
/** Model calls per owner day (both steps). A cost fuse against a runaway loop. */
export const DAILY_MODEL_CALL_LIMIT = 40;
/**
 * Headlines step 2 sees at most per check. Raised from 15 after the first preview (on a busy day
 * Haiku passed 26 and the rest went undecided), then from 25 to 60 when the screen went off and
 * checks moved to every two hours (2026-10-15).
 */
export const DECIDE_MAX = 60;
/** New headlines that arrive per hour across a typical owner's searches (measured 2026-10-15: 25-30). */
export const HEADLINES_PER_HOUR = 30;

/**
 * How many headlines one check takes on: an hour's worth for every hour since the last check, at
 * least an hour's worth, at most DECIDE_MAX. The short list and step 2 use the same number; what
 * does not fit is not marked seen, so it waits for the next check (until it is a day old).
 */
export function headlinesPerCheck(everyMinutes: number): number {
  return Math.min(DECIDE_MAX, Math.max(HEADLINES_PER_HOUR, Math.round((HEADLINES_PER_HOUR * everyMinutes) / 60)));
}
/** Hours the watch runs without interests before it asks for them once. */
export const ASK_AFTER_HOURS = 24;
/** [sunshine:watcher] Characters of one story's search results the writer sees. */
export const RESEARCH_MAX_CHARS = 2500;

export interface CheckDeps {
  store: WatchStore;
  config: InstinctConfig;
  outbox: Outbox;
  audit: AuditLog;
  now: () => Date;
  sieve?: RelevanceSieve;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  /** Step 1. Undefined: switched off. */
  screen?: ModelCall;
  /** Step 2. Undefined: switched off, and step 1's model decides instead. */
  decide?: ModelCall;
  /** [sunshine:watcher] Step 3, the writer. Undefined: the decision's own text is sent, as before. */
  write?: ModelCall;
  /** What the agent knows, for the writer (persona, memory, the end of the owner's thread). */
  writerContext?: () => WriterContext;
  /** One web search for the writer, results as text. Undefined or failing: it writes from the headline. */
  research?: (query: string, signal?: AbortSignal) => Promise<string>;
  dailyTextLimit?: number;
  dailyModelCallLimit?: number;
  askAfterHours?: number;
}

export type CheckMode =
  /** A scheduled check: texts through the door, inside the fences. */
  | "scheduled"
  /** The owner asked for news in a conversation: the agent says it in its reply; nothing is texted. */
  | "asked";

export interface CheckOutcome {
  /** "writer held": chosen, then held back by the writer (old news re-posted, or a bad moment). */
  status: "off" | "quiet" | "no searches" | "asked interests" | "budget" | "nothing new" | "screened out" | "no model" | "model failed" | "refused" | "nothing to tell" | "sent" | "held" | "writer held" | "to tell";
  /** The message: sent (scheduled) or for the agent to say (asked). */
  text?: string;
  note?: string;
  kept?: number;
}

const OWNER_ID = "owner";
const KEY = "scheduled:watcher";

export async function runCheck(deps: CheckDeps, mode: CheckMode, signal?: AbortSignal): Promise<CheckOutcome> {
  const at = deps.now();
  const tz = deps.config.owner.timezone || "UTC";
  const today = localDate(at, tz);
  const s = deps.store.read();
  const log: Record<string, unknown> = { watcher: "check", mode };
  // The decision journal: every headline this check looked at and where its path ended.
  const items: JournalItem[] = [];
  const fate = new Map<Candidate, JournalItem>();
  const finish = (outcome: CheckOutcome): CheckOutcome => {
    deps.audit.append({ kind: "policy", conversationKey: KEY, principal: OWNER_ID, detail: { ...log, outcome: outcome.status, ...(outcome.note ? { note: outcome.note } : {}) } });
    if (items.length) {
      deps.store.appendJournal({ at: at.toISOString(), mode, outcome: outcome.status, ...(outcome.note ? { note: outcome.note } : {}), ...(typeof log["costUsd"] === "number" ? { costUsd: log["costUsd"] } : {}), items });
    }
    return outcome;
  };
  const journalItem = (c: Candidate, stage: JournalItem["stage"], result: JournalItem["result"]): JournalItem => ({
    title: c.title,
    ...(c.source ? { source: c.source } : {}),
    topic: c.topic,
    link: c.link,
    stage,
    result,
    ...(c.p !== undefined ? { p: Math.round(c.p * 100) / 100 } : {}),
  });

  // 1. Fences.
  if (mode === "scheduled") {
    if (!s.on) return finish({ status: "off" });
    if (inQuietHours(at, tz, s.quiet)) return finish({ status: "quiet" });
  }
  if (s.searches.length === 0) {
    const hours = (at.getTime() - Date.parse(s.startedAt)) / 3600_000;
    if (mode === "scheduled" && !s.askedInterests && hours >= (deps.askAfterHours ?? ASK_AFTER_HOURS)) {
      const sent = await door(deps, s, at, tz, INTERESTS_QUESTION, [], "question");
      deps.store.update((st) => void (st.askedInterests = true));
      return finish({ status: sent ? "asked interests" : "held", text: INTERESTS_QUESTION });
    }
    return finish({ status: "no searches" });
  }
  const callsToday = s.calls.filter((c) => localDate(new Date(c.at), tz) === today).length;
  if (callsToday >= (deps.dailyModelCallLimit ?? DAILY_MODEL_CALL_LIMIT)) {
    log["fault"] = "daily model budget reached; headlines stay unseen for later checks";
    return finish({ status: "budget" });
  }

  // 2. Collect: as many headlines as arrive between two checks.
  const perCheck = headlinesPerCheck(s.everyMinutes);
  const { summary, candidates, rejected } = await runScan(
    { store: deps.store, ...(deps.sieve ? { sieve: deps.sieve } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.lookup ? { lookup: deps.lookup } : {}), now: () => at, totalMax: perCheck },
    signal,
  );
  Object.assign(log, { fetched: summary.fetched, fresh: summary.fresh, shortlist: summary.passed, sieve: summary.sieve, jevInputTokens: summary.jevInputTokens, ...(summary.errors.length ? { errors: summary.errors } : {}) });
  for (const r of [...rejected].sort((a, b) => (b.p ?? 0) - (a.p ?? 0)).slice(0, JOURNAL_SIEVE_MAX)) items.push(journalItem(r, "sieve", "dropped"));
  for (const c of candidates) {
    const it = journalItem(c, "decide", "undecided");
    fate.set(c, it);
    items.push(it);
  }
  if (candidates.length === 0) return finish({ status: "nothing new" });

  const decider = deps.decide ?? deps.screen;
  const screener = deps.decide ? deps.screen : undefined; // with step 2 off, step 1's model decides directly
  if (!decider) {
    unsee(deps, candidates);
    log["fault"] = "no model configured for the news watch";
    return finish({ status: "no model" });
  }
  const numbered = (list: Candidate[]): PromptHeadline[] => list.map((c, i) => ({ n: i + 1, topic: c.topic, title: c.title, ...(c.source ? { source: c.source } : {}), age: ago(c.publishedAt, at) }));
  let cost = 0;
  const record = (step: "screen" | "decide" | "write", costUsd: number) => {
    cost += costUsd;
    deps.store.update((st) => void st.calls.push({ at: at.toISOString(), step, costUsd }));
  };

  // 3. Screen (step 1): generous; on failure everything goes on, capped.
  let passed = candidates;
  if (screener) {
    try {
      const reply = await screener({ system: SCREEN_SYSTEM, user: screenUser({ profile: s.profile, headlines: numbered(candidates) }), ...(signal ? { signal } : {}) });
      record("screen", reply.costUsd);
      const result = parseScreen(reply.text, candidates.length);
      passed = result.pass.map((n) => candidates[n - 1]!).filter(Boolean);
      log["screened"] = { in: candidates.length, out: passed.length, model: reply.model, ...(result.note ? { note: result.note } : {}) };
      for (const c of candidates) {
        if (passed.includes(c)) continue;
        const it = fate.get(c)!;
        it.stage = "screen";
        it.result = "dropped";
      }
    } catch (err) {
      log["screenFailed"] = String(err instanceof Error ? err.message : err);
    }
  }
  if (passed.length === 0) {
    const note = `Screened ${candidates.length} new headlines; none worth a closer look.`;
    remember(deps, at, note);
    log["costUsd"] = round(cost);
    return finish({ status: "screened out", note });
  }
  passed = passed.slice(0, perCheck);

  // 4. Decide (step 2), with one retry when the answer breaks a fact the code can check.
  const headlines = numbered(passed);
  const byNumber = new Map(passed.map((c, i) => [i + 1, c] as const));
  const cards = s.stories;
  let decision: Decision | undefined;
  let feedback: string | undefined;
  try {
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {
      const reply = await decider({
        system: DECIDE_SYSTEM,
        user: decideUser({ now: nowText(at, tz), profile: s.profile, cards: cards.map((c) => cardLine(c, at, tz)), notes: s.notes.map((n) => `${shortTime(new Date(n.at), tz)}: ${n.text}`), headlines, ...(feedback ? { feedback } : {}) }),
        ...(signal ? { signal } : {}),
      });
      record("decide", reply.costUsd);
      log["decideModel"] = reply.model;
      let parsed: Decision;
      try {
        parsed = parseDecision(reply.text);
      } catch (err) {
        feedback = `The reply could not be read as JSON (${err instanceof Error ? err.message : String(err)}).`;
        continue;
      }
      const problems = checkDecision(parsed, byNumber, cards);
      if (problems.length === 0) decision = parsed;
      else feedback = problems.join("\n");
    }
  } catch (err) {
    // The model is unreachable: these headlines wait for the next check instead of being lost.
    unsee(deps, passed);
    log["decideFailed"] = String(err instanceof Error ? err.message : err);
    log["costUsd"] = round(cost);
    return finish({ status: "model failed" });
  }
  log["costUsd"] = round(cost);
  if (!decision) {
    log["refused"] = feedback;
    remember(deps, at, "A decision was refused by the checks twice; nothing was sent.");
    return finish({ status: "refused" });
  }

  // 5. The door.
  for (const c of passed) fate.get(c)!.result = "nothing";
  const kept = decision.keep.map((k) => ({ c: byNumber.get(k.headline)!, why: k.why })).filter((k) => k.c);
  for (const { c } of kept) fate.get(c)!.result = "kept";
  if (kept.length) {
    deps.store.update((st) => {
      for (const { c, why } of kept) if (!st.later.some((l) => l.link === c.link)) st.later.push({ at: at.toISOString(), title: c.title, link: c.link, topic: c.topic, ...(why ? { why } : {}) });
    });
  }
  if (decision.note) remember(deps, at, decision.note);
  if (!decision.message) return finish({ status: "nothing to tell", note: decision.note, kept: kept.length });

  const stories = decision.message.stories.map((st) => ({ st, c: byNumber.get(st.headline)! }));
  const distinct = stories.filter(({ st }) => st.card === "new" && (st as NewStory).distinct);
  if (distinct.length) log["distinctClaims"] = distinct.map(({ st }) => (st as NewStory).distinct);
  const links = stories.map(({ c }) => c.link);

  // 4b. Write (step 3): a scheduled text is written as the agent itself. Asked news goes into the
  // agent's own reply anyway. A failure here never loses the story: the decision's text goes out.
  let text = decision.message.text;
  if (mode === "scheduled" && deps.write) {
    const written = await writeText(deps, s, at, tz, stories, record, signal);
    log["costUsd"] = round(cost);
    if ("held" in written) {
      for (const { c } of stories) {
        const it = fate.get(c)!;
        it.stage = "write";
        it.result = "dropped";
      }
      const note = `Chose to tell ${stories.map(({ c }) => `"${c.title}"`).join(" and ")}, then held it back while writing: ${written.held}`;
      remember(deps, at, note);
      log["writerHeld"] = written.held;
      return finish({ status: "writer held", note, kept: kept.length });
    }
    if ("text" in written) text = written.text;
    else log["writerFailed"] = written.failed;
  }

  if (mode === "scheduled") {
    const sent = await door(deps, s, at, tz, text, links, "news");
    if (!sent) {
      // Held by a fence: worth telling, so it waits as kept-for-later rather than being lost.
      deps.store.update((st) => {
        for (const { c } of stories) if (!st.later.some((l) => l.link === c.link)) st.later.push({ at: at.toISOString(), title: c.title, link: c.link, topic: c.topic, why: "held by quiet hours or the daily limit" });
      });
      for (const { c } of stories) fate.get(c)!.result = "kept";
      return finish({ status: "held", text, note: decision.note });
    }
  }
  const cardOf = tell(deps, at, stories);
  for (const { c } of stories) {
    const it = fate.get(c)!;
    it.result = "told";
    const id = cardOf.get(c.link);
    if (id) it.card = id;
  }
  return finish({ status: mode === "scheduled" ? "sent" : "to tell", text, note: decision.note, kept: kept.length });
}

/**
 * [sunshine:watcher] Step 3: write the chosen stories as the agent would text them, with what it
 * knows and one web search per story. Returns the text, a hold-back with its reason, or a failure
 * (the caller then sends the decision's own text). Never throws.
 */
async function writeText(
  deps: CheckDeps,
  s: WatchState,
  at: Date,
  tz: string,
  stories: Array<{ st: NewStory | StoryUpdate; c: Candidate }>,
  record: (step: "write", costUsd: number) => void,
  signal?: AbortSignal,
): Promise<{ text: string } | { held: string } | { failed: string }> {
  try {
    const context: WriterContext = deps.writerContext?.() ?? { persona: "", memory: "", thread: "" };
    const found = await Promise.all(
      stories.map(async ({ c }) => {
        if (!deps.research) return "";
        try {
          const results = await deps.research(`${c.title} ${c.source ?? ""}`.trim(), signal);
          return `Search for "${c.title}":\n${results.slice(0, RESEARCH_MAX_CHARS)}`;
        } catch {
          return `The search for "${c.title}" failed; write from the headline.`;
        }
      }),
    );
    const told: WriteStory[] = stories.map(({ st, c }) => {
      const card = st.card === "new" ? undefined : s.stories.find((x) => x.id === st.card);
      return { title: c.title, ...(c.source ? { source: c.source } : {}), ...(card ? { update: { subject: card.subject, event: card.event, status: card.status } } : {}) };
    });
    const reply = await deps.write!({
      system: writeSystem({ agentName: deps.config.agent.name, ownerName: deps.config.owner.name, persona: context.persona, memory: context.memory, profile: s.profile }),
      user: writeUser({ now: nowText(at, tz), thread: context.thread, stories: told, found }),
      ...(signal ? { signal } : {}),
    });
    record("write", reply.costUsd);
    return parseWritten(reply.text) ?? { failed: "the writer's reply was empty or too long" };
  } catch (err) {
    return { failed: String(err instanceof Error ? err.message : err) };
  }
}

/** Text the owner, inside the fences. Returns false when a fence held it. */
async function door(deps: CheckDeps, s: WatchState, at: Date, tz: string, text: string, links: string[], kind: "news" | "question"): Promise<boolean> {
  const held = (reason: string, fault = false) => {
    deps.audit.append({ kind: "policy", conversationKey: KEY, principal: OWNER_ID, detail: { watcher: "held", reason, ...(fault ? { fault: true } : {}) } });
    return false;
  };
  const phone = deps.config.owner.phones[0];
  if (!phone) return held("the owner has no phone on file");
  if (inQuietHours(at, tz, s.quiet)) return held("quiet hours");
  const today = localDate(at, tz);
  if (s.sent.filter((r) => localDate(new Date(r.at), tz) === today).length >= (deps.dailyTextLimit ?? DAILY_TEXT_LIMIT)) {
    return held("daily text limit reached: the judgment is too loose", true);
  }
  const principal: Principal = { kind: "owner", id: OWNER_ID, tier: "owner", displayName: deps.config.owner.name };
  await deps.outbox.send({ channel: "imessage", to: phone, text }, { principal, conversationKey: KEY });
  deps.audit.append({ kind: "outbound", conversationKey: KEY, principal: OWNER_ID, detail: { channel: "imessage", to: phone, chars: text.length, via: "watcher", kind } });
  deps.store.update((st) => void st.sent.push({ at: at.toISOString(), text, links, kind }));
  return true;
}

/** Record what the owner now knows: new story cards, or updates to existing ones. Returns link -> card id. */
function tell(deps: CheckDeps, at: Date, stories: Array<{ st: NewStory | StoryUpdate; c: Candidate }>): Map<string, string> {
  const iso = at.toISOString();
  const cardOf = new Map<string, string>();
  deps.store.update((s) => {
    for (const { st, c } of stories) {
      if (st.card === "new") {
        const n = st as NewStory;
        const id = newCardId();
        cardOf.set(c.link, id);
        s.stories.push({ id, subject: n.subject, event: n.event, status: n.status, titles: [c.title], links: [c.link], firstTold: iso, lastTold: iso, updates: 0 });
      } else {
        const card = s.stories.find((x) => x.id === st.card);
        if (!card) continue;
        cardOf.set(c.link, card.id);
        card.status = (st as StoryUpdate).status;
        card.titles.push(c.title);
        card.links.push(c.link);
        card.lastTold = iso;
        card.updates += 1;
      }
    }
    s.later = s.later.filter((l) => !stories.some(({ c }) => c.link === l.link));
  });
  return cardOf;
}

function remember(deps: CheckDeps, at: Date, text: string): void {
  deps.store.update((s) => void s.notes.push({ at: at.toISOString(), text: text.slice(0, 400) }));
}

/** Forget that these headlines were looked at, so the next check sees them again. */
function unsee(deps: CheckDeps, list: Candidate[]): void {
  deps.store.update((s) => {
    for (const c of list) for (const k of headlineKeys(c)) delete s.seen[k];
  });
}

function cardLine(c: StoryCard, at: Date, tz: string) {
  return { id: c.id, subject: c.subject, event: c.event, status: c.status, told: `${shortTime(new Date(c.firstTold), tz)}${c.updates ? `, last update ${ago(c.lastTold, at)}` : ""}`, updates: c.updates };
}

function nowText(at: Date, tz: string): string {
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(at)} (${tz})`;
}

function shortTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
