/**
 * [sunshine:watcher] The news watch as the agent sees it, plus the gate the scheduler runs.
 * The checks themselves run in code (check.ts) and never wake the agent. In conversation, the
 * agent keeps the written picture of the owner, the searches and the settings, and can run a
 * check on request ("anything new?"). All tools are owner-only: they hold the owner's interests.
 */
import {
  defineTool,
  textResult,
  wrapUntrusted,
  type AuditLog,
  type InstinctConfig,
  type Lookup,
  type Outbox,
  type RegisteredTool,
  type ScheduleEntry,
  type Scheduler,
  type StateDir,
  type ToolContext,
  type ToolResultLike,
} from "@open-instinct/core";
import { Type } from "typebox";
import { CHECK_INTERVALS, ago, checkCron, everyText, localDate, normalizeTime } from "./clock.js";
import { runCheck, type CheckDeps, type CheckOutcome } from "./check.js";
import { JevSieve, type RelevanceSieve } from "./jev.js";
import type { ModelCall } from "./models.js";
import { DEFAULT_EDITION, editionParams } from "./news.js";
import { PROFILE_MAX_CHARS, QUERY_MAX_CHARS, SEARCH_MAX, TOPIC_MAX_CHARS, WatchStore, type WatchSearch, type WatchState } from "./store.js";

/** The gate name scheduled checks carry (ScheduleEntry.gate). */
export const WATCH_GATE = "watcher";
/** The label on scheduled checks. The gate runs the check; no model run uses this prompt. */
export const WATCH_PROMPT = "News watch check (runs in code through the watcher gate).";

export interface WatcherDeps {
  state: StateDir;
  config: InstinctConfig;
  outbox: Outbox;
  audit: AuditLog;
  scheduler: Scheduler;
  /** TYPESAFE_API_KEY. Without it (and without `sieve`) headlines go through unsieved, capped. */
  typesafeApiKey?: string;
  sieve?: RelevanceSieve;
  /** Step 1 (screen) and step 2 (decide). Either may be undefined: that step is switched off. */
  screen?: ModelCall;
  decide?: ModelCall;
  /** Step 3, the writer, and what it needs from the host. See CheckDeps. */
  write?: ModelCall;
  writerContext?: CheckDeps["writerContext"];
  research?: CheckDeps["research"];
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => Date;
  dailyTextLimit?: number;
  dailyModelCallLimit?: number;
  askAfterHours?: number;
}

export interface Watcher {
  tools: RegisteredTool[];
  /** For RuntimeDeps.scheduleGates. Runs a check and never wakes the agent. */
  gate: (entry: ScheduleEntry) => Promise<boolean>;
  /** On first boot with the feature on: switch the owner's checks on. Afterwards: repair missing checks. */
  ensureStarted(): void;
  runCheck(mode: "scheduled" | "asked"): Promise<CheckOutcome>;
}

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function ownerOnly(ctx: ToolContext): ToolResultLike | undefined {
  return ctx.principal.kind === "owner" ? undefined : fail("Keeping up with the news belongs to the owner; only the owner's own conversations can use it.");
}

export function createWatcher(deps: WatcherDeps): Watcher {
  const now = deps.now ?? (() => new Date());
  const store = new WatchStore(deps.state, now);
  const tz = () => deps.config.owner.timezone || "UTC";
  const sieve = deps.sieve ?? (deps.typesafeApiKey ? new JevSieve({ apiKey: deps.typesafeApiKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }) : undefined);
  const checkDeps = (): CheckDeps => ({
    store,
    config: deps.config,
    outbox: deps.outbox,
    audit: deps.audit,
    now,
    ...(sieve ? { sieve } : {}),
    ...(deps.screen ? { screen: deps.screen } : {}),
    ...(deps.decide ? { decide: deps.decide } : {}),
    ...(deps.write ? { write: deps.write } : {}),
    ...(deps.writerContext ? { writerContext: deps.writerContext } : {}),
    ...(deps.research ? { research: deps.research } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.dailyTextLimit !== undefined ? { dailyTextLimit: deps.dailyTextLimit } : {}),
    ...(deps.dailyModelCallLimit !== undefined ? { dailyModelCallLimit: deps.dailyModelCallLimit } : {}),
    ...(deps.askAfterHours !== undefined ? { askAfterHours: deps.askAfterHours } : {}),
  });

  /** Replace the scheduled checks with one job matching the settings, or remove them. */
  const reschedule = (st: WatchState): void => {
    for (const id of st.scheduleIds) deps.scheduler.delete(id);
    st.scheduleIds = [];
    if (!st.on) return;
    const cron = checkCron(st.everyMinutes, st.quiet);
    if (!cron) return; // quiet hours leave no hour to look in
    const entry = deps.scheduler.create({
      name: `news watch every ${st.everyMinutes} min`,
      prompt: WATCH_PROMPT,
      cron,
      tz: tz(),
      enabled: true,
      gate: WATCH_GATE,
      toolRepliesOnly: true,
    });
    st.scheduleIds.push(entry.id);
  };

  const describeState = (s: WatchState, at: Date): string => {
    const today = localDate(at, tz());
    const costToday = s.calls.filter((c) => localDate(new Date(c.at), tz()) === today).reduce((a, c) => a + c.costUsd, 0);
    const cost30 = s.calls.reduce((a, c) => a + c.costUsd, 0);
    const lines = [
      // [sunshine:watcher] Words for the model to repeat: it is Sunshine keeping up with the news, not a
      // "news watch". Timing and settings sit apart, labelled: tested, when they led the result the
      // model recited them unasked ("Every hour I scan headlines… quiet from 22:00").
      `Keeping up with the news for them: ${s.on ? "on" : "off"}.`,
      "",
      "What you know about their interests:",
      s.profile.trim() || "(nothing yet)",
      "",
      "Searches:",
      ...(s.searches.length ? s.searches.map((x) => `- ${x.topic}: "${x.query}" (${x.edition})`) : ["(none)"]),
      "",
      "News you told them in the last two weeks:",
      ...(s.stories.length ? s.stories.map((c) => `- ${c.subject}: ${c.event} (${c.status}), told ${ago(c.firstTold, at)}${c.updates ? `, ${c.updates} update(s)` : ""}`) : ["(none)"]),
      "",
      "Timing and settings, to mention only if they ask about them:",
      `- ${s.on ? `Every ${everyText(s.everyMinutes)}` : "Off"}, outside quiet hours ${s.quiet.start}-${s.quiet.end} (${tz()}).`,
      `- Asked about interests: ${s.askedInterests ? "yes" : "not yet (the one-time question about interests has not been sent)"}. Model cost: $${costToday.toFixed(3)} today, $${cost30.toFixed(2)} in the last 30 days.`,
    ];
    if (s.lastCheck) {
      const c = s.lastCheck;
      lines.push("", `Last look at the news ${ago(c.at, at)}: ${c.fetched} headlines, ${c.fresh} new, ${c.passed} on their topics${c.errors.length ? `; problems: ${c.errors.join("; ")}` : ""}.`);
    }
    if (s.later.length) lines.push(`Kept for later, not told yet: ${s.later.length} (watch_later lists them).`);
    return lines.join("\n");
  };

  const profileRead = defineTool({
    name: "watch_profile",
    label: "News watch: profile",
    description:
      "Read what you keep track of for the owner's news: your written picture of their interests, the searches, settings, the news you texted them in the last two weeks, and your last look at the news and its cost. Use it when they ask what you keep an eye on for them, and when they react to a news text (\"not interesting\", \"already knew\", \"more like this\") so you know which text they mean.",
    parameters: Type.Object({}),
    meta: { capabilities: ["memory.write"], group: "memory", describe: () => "watch_profile" },
    execute: async (_args, ctx) => ownerOnly(ctx) ?? textResult(describeState(store.read(), ctx.now())),
  });

  const profileWrite = defineTool({
    name: "watch_profile_update",
    label: "News watch: update profile",
    description:
      "Rewrite your picture of the owner's interests and/or the searches. `profile` replaces the whole note (plain words, at most 2000 characters): what they follow and how closely, where they live, how they like to hear things, and their reactions to past news texts as short examples; mark weak signals as weak. `searches` replaces the whole list, one per interest: `topic` says only what the news is about, unambiguously (\"Brann, the Bergen football club (SK Brann)\", not \"Brann\"), never how much they care or which kind of news (\"secondary\", \"major only\", \"funding and launches\" belong in `profile`): a relevance filter reads the topic literally and drops headlines that do not fit it; `query` is a precise Google News search (\"SK Brann\"); `edition` is en-US, en-GB, no-NO, sv-SE or another language-COUNTRY pair.",
    parameters: Type.Object({
      profile: Type.Optional(Type.String()),
      searches: Type.Optional(Type.Array(Type.Object({ topic: Type.String(), query: Type.String(), edition: Type.Optional(Type.String()) }))),
    }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `watch_profile_update${(a as { searches?: unknown[] }).searches ? ` (${(a as { searches: unknown[] }).searches.length} searches)` : ""}` },
    execute: async ({ profile, searches }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      if (profile === undefined && searches === undefined) return fail("Give `profile`, `searches`, or both.");
      if (profile !== undefined && profile.length > PROFILE_MAX_CHARS) return fail(`The profile is ${profile.length} characters; keep it under ${PROFILE_MAX_CHARS}. Condense it.`);
      let clean: WatchSearch[] | undefined;
      if (searches !== undefined) {
        if (searches.length > SEARCH_MAX) return fail(`At most ${SEARCH_MAX} searches. Merge or drop some.`);
        clean = [];
        for (const s of searches) {
          const topic = s.topic.trim();
          const query = s.query.trim();
          const edition = (s.edition ?? DEFAULT_EDITION).trim();
          if (!topic || topic.length > TOPIC_MAX_CHARS) return fail(`Each topic needs 1 to ${TOPIC_MAX_CHARS} characters.`);
          if (!query || query.length > QUERY_MAX_CHARS) return fail(`Each query needs 1 to ${QUERY_MAX_CHARS} characters.`);
          if (!editionParams(edition)) return fail(`Unknown edition "${edition}". Use en-US, en-GB, no-NO, sv-SE, or a language-COUNTRY pair like de-DE.`);
          clean.push({ topic, query, edition });
        }
      }
      const s = store.update((st) => {
        if (profile !== undefined) st.profile = profile.trim();
        if (clean) {
          st.searches = clean;
          // Interests given in conversation answer the one-time question.
          if (clean.length > 0) st.askedInterests = true;
        }
      });
      return textResult(`Saved. ${s.searches.length} searches.`);
    },
  });

  const check = defineTool({
    name: "watch_check",
    label: "News watch: check now",
    description:
      "Check the news now, when the owner asks for news (\"anything new?\", \"what's happening with Brann?\"). Returns what is worth telling them, which you then say in your reply; nothing is texted separately, and it counts as told so it is not sent again later. Also mentions anything kept for later.",
    parameters: Type.Object({}),
    meta: { capabilities: ["web.read", "memory.write"], group: "web", describe: () => "watch_check" },
    execute: async (_args, ctx, signal) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const outcome = await runCheck(checkDeps(), "asked", signal);
      const s = store.read();
      const parts: string[] = [];
      if (outcome.status === "to tell" && outcome.text) parts.push("Worth telling them (say it in your reply, in your own words):", wrapUntrusted(outcome.text, "news findings"));
      else if (outcome.status === "no searches") parts.push("There are no searches yet: ask what they would like you to keep an eye on.");
      else if (outcome.status === "budget") parts.push("You have reached today's limit for looking at the news; try again tomorrow or search the web directly.");
      else if (outcome.status === "model failed" || outcome.status === "no model") parts.push("Looking at the news did not work right now.");
      else parts.push("Nothing new worth telling since the last check.");
      if (s.later.length) parts.push(`Also kept for later: ${s.later.length} smaller stories (watch_later lists them).`);
      return textResult(parts.join("\n"));
    },
  });

  const journal = defineTool({
    name: "watch_journal",
    label: "News watch: what it looked at",
    description:
      "What you looked at in the news recently and what you did with each headline: told them, kept for later, judged not worth a text, or set aside early. Use it when the owner asks what you skipped, whether you saw a story, or why you did not text about something.",
    parameters: Type.Object({ hours: Type.Optional(Type.Number({ description: "How far back, default 24, at most 168" })) }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `watch_journal ${(a as { hours?: number }).hours ?? 24}h` },
    execute: async ({ hours }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const h = Math.min(168, Math.max(1, hours ?? 24));
      const entries = store.readJournal(ctx.now().getTime() - h * 3600_000);
      if (entries.length === 0) return textResult(`No headlines looked at in the last ${h} hours.`);
      const all = entries.flatMap((e) => e.items.map((it) => ({ ...it, at: e.at })));
      const pick = (f: (i: (typeof all)[number]) => boolean, max: number) => all.filter(f).slice(-max);
      const line = (i: (typeof all)[number]) => `- [${i.topic}] ${i.title}${i.source ? ` (${i.source})` : ""}`;
      const told = pick((i) => i.result === "told", 20);
      const kept = pick((i) => i.result === "kept", 20);
      const passedOn = pick((i) => i.stage === "decide" && (i.result === "nothing" || i.result === "undecided"), 25);
      const screened = pick((i) => i.stage === "screen", 25);
      const sieved = all.filter((i) => i.stage === "sieve");
      const sievedTop = [...sieved].sort((a, b) => (b.p ?? 0) - (a.p ?? 0)).slice(0, 8);
      const cost = entries.reduce((a, e) => a + (e.costUsd ?? 0), 0);
      const body = [
        `Told them: ${told.length}`, ...told.map(line),
        "", `Kept for later: ${kept.length}`, ...kept.map(line),
        "", `Looked at closely, not worth a text: ${passedOn.length}`, ...passedOn.map(line),
        "", `Dropped as noise in the first pass: ${screened.length}`, ...screened.map(line),
        "", `Filtered out as off-topic: ${sieved.length}. The most on-topic of those:`, ...sievedTop.map((i) => `${line(i)} (relevance ${i.p ?? "?"})`),
      ].join("\n");
      const notes = entries.filter((e) => e.note).slice(-6).map((e) => `- ${ago(e.at, ctx.now())}: ${e.note}`);
      return textResult(
        [`Last ${h} hours: you looked at the news ${entries.length} times, model cost $${cost.toFixed(3)}.`, wrapUntrusted(body, "news headlines"), ...(notes.length ? ["", "Your notes from those times:", ...notes] : [])].join("\n"),
      );
    },
  });

  const later = defineTool({
    name: "watch_later",
    label: "News watch: kept items",
    description:
      "List the smaller stories kept for later. Use it when the owner asks for news or \"anything new?\". With `clear` true (the default), the listed items count as told and are removed.",
    parameters: Type.Object({ clear: Type.Optional(Type.Boolean()) }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: () => "watch_later" },
    execute: async ({ clear }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const s = store.read();
      if (s.later.length === 0) return textResult("Nothing kept for later.");
      const at = ctx.now();
      const list = s.later.map((l, i) => `${i + 1}. [${l.topic ?? "news"}] ${l.title} (kept ${ago(l.at, at)})${l.why ? `. Why: ${l.why}` : ""}\n   ${l.link}`).join("\n");
      if (clear !== false) store.update((st) => void (st.later = []));
      return textResult(wrapUntrusted(list, "news headlines kept for later"));
    },
  });

  const settings = defineTool({
    name: "watch_settings",
    label: "News watch: settings",
    description:
      `Turn keeping up with the news on or off, change how often you look (everyMinutes: ${CHECK_INTERVALS.join(", ")}, that is every ${CHECK_INTERVALS.map((m) => m / 60).join(", ")} hours; never more often than every two hours), the owner's quiet hours (nothing unprompted is sent then, e.g. 22:00 to 08:00), or record that you asked about their interests.`,
    parameters: Type.Object({
      on: Type.Optional(Type.Boolean()),
      everyMinutes: Type.Optional(Type.Number()),
      quietStart: Type.Optional(Type.String()),
      quietEnd: Type.Optional(Type.String()),
      askedInterests: Type.Optional(Type.Boolean()),
    }),
    meta: { capabilities: ["schedule.manage"], group: "schedule", describe: (a) => `watch_settings ${JSON.stringify(a)}` },
    execute: async ({ on, everyMinutes, quietStart, quietEnd, askedInterests }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      // [sunshine:watcher] Every two to 24 hours: faster cost up to four times as much (2026-10-15).
      if (everyMinutes !== undefined && !(CHECK_INTERVALS as readonly number[]).includes(everyMinutes)) {
        return fail(`You look at the news every ${CHECK_INTERVALS.map((m) => m / 60).join(", ")} hours (everyMinutes ${CHECK_INTERVALS.join(", ")}); never more often than every two hours. Offer the nearest one in a line.`);
      }
      const qs = quietStart === undefined ? undefined : normalizeTime(quietStart);
      const qe = quietEnd === undefined ? undefined : normalizeTime(quietEnd);
      if ((quietStart !== undefined && !qs) || (quietEnd !== undefined && !qe)) return fail("Quiet hours need times of day, like 22:00 and 08:00.");
      const s = store.update((st) => {
        const before = JSON.stringify([st.on, st.everyMinutes, st.quiet]);
        if (on !== undefined) st.on = on;
        if (everyMinutes !== undefined) st.everyMinutes = everyMinutes;
        if (qs) st.quiet.start = qs;
        if (qe) st.quiet.end = qe;
        if (askedInterests !== undefined) st.askedInterests = askedInterests;
        // A check job deleted by hand (schedule_delete) comes back when the settings are touched.
        const missing = st.on && (st.scheduleIds.length === 0 || st.scheduleIds.some((id) => !deps.scheduler.get(id)));
        if (JSON.stringify([st.on, st.everyMinutes, st.quiet]) !== before || missing) reschedule(st);
      });
      return textResult(describeState(s, ctx.now()).split("\n")[0] ?? "Saved.");
    },
  });

  return {
    tools: [profileRead, profileWrite, check, journal, later, settings],
    gate: async () => {
      await runCheck(checkDeps(), "scheduled");
      return false;
    },
    ensureStarted() {
      if (!store.exists()) {
        store.update((st) => {
          st.on = true;
          reschedule(st);
        });
        return;
      }
      const s = store.read();
      // [sunshine:watcher] Also when the job no longer matches the settings: a setting below two hours
      // counts as two hours now, and the first check after quiet hours moved to the full hour.
      const stale = s.scheduleIds.some((id) => {
        const job = deps.scheduler.get(id);
        return !job || job.cron !== checkCron(s.everyMinutes, s.quiet) || job.tz !== tz();
      });
      if (s.on && (s.scheduleIds.length === 0 || stale)) store.update(reschedule);
    },
    runCheck: (mode) => runCheck(checkDeps(), mode),
  };
}
