/**
 * [sunshine:watcher] The news watch's tools. The agent keeps a written picture of the owner's
 * interests, runs a check, and decides; code owns the fences. Every unprompted text goes out
 * through watch_send, which enforces quiet hours, a hidden daily limit, and no repeats.
 * All tools are owner-only: they read and write the owner's private interests.
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
  type Scheduler,
  type StateDir,
  type ToolContext,
  type ToolResultLike,
} from "@open-instinct/core";
import { Type } from "typebox";
import { ago, inQuietHours, localDate, normalizeTime } from "./clock.js";
import { JevSieve, type RelevanceSieve } from "./jev.js";
import { DEFAULT_EDITION, editionParams } from "./news.js";
import { runScan, type Candidate } from "./scan.js";
import { PROFILE_MAX_CHARS, QUERY_MAX_CHARS, SEARCH_MAX, TOPIC_MAX_CHARS, WatchStore, type WatchSearch, type WatchState } from "./store.js";

/** What a scheduled check asks the agent to do. The news-watch skill holds the instructions. */
export const WATCH_PROMPT = "Run the news-watch skill for the owner.";
/** Unprompted watcher texts per owner day. The agent is never told the number. */
export const DAILY_LIMIT = 6;
const TEXT_MAX_CHARS = 1200;

export interface WatcherDeps {
  state: StateDir;
  config: InstinctConfig;
  outbox: Outbox;
  audit: AuditLog;
  scheduler: Scheduler;
  /** TYPESAFE_API_KEY. Without it (and without `sieve`) headlines go through unsieved, capped. */
  typesafeApiKey?: string;
  /** Tests inject a sieve; otherwise Jev when there is a key. */
  sieve?: RelevanceSieve;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => Date;
  dailyLimit?: number;
}

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function ownerOnly(ctx: ToolContext): ToolResultLike | undefined {
  return ctx.principal.kind === "owner" ? undefined : fail("The news watch belongs to the owner; only the owner's own conversations can use it.");
}

export function watcherTools(deps: WatcherDeps): RegisteredTool[] {
  const now = deps.now ?? (() => new Date());
  const store = new WatchStore(deps.state, now);
  const tz = () => deps.config.owner.timezone || "UTC";
  const sieve = deps.sieve ?? (deps.typesafeApiKey ? new JevSieve({ apiKey: deps.typesafeApiKey, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }) : undefined);
  const limit = deps.dailyLimit ?? DAILY_LIMIT;

  const describeState = (s: WatchState, at: Date): string => {
    const lines = [
      `News watch: ${s.on ? `on, checks at ${s.times.join(" and ")} (${tz()})` : "off"}. Quiet hours ${s.quiet.start}-${s.quiet.end}.`,
      `Asked about interests: ${s.askedInterests ? "yes" : "not yet"}.`,
      "",
      "What you know about their interests:",
      s.profile.trim() || "(nothing yet)",
      "",
      "Searches:",
      ...(s.searches.length ? s.searches.map((x) => `- ${x.topic}: "${x.query}" (${x.edition})`) : ["(none)"]),
    ];
    if (s.lastCheck) {
      const c = s.lastCheck;
      lines.push("", `Last check ${ago(c.at, at)}: ${c.fetched} headlines, ${c.fresh} new, ${c.passed} on the short list${c.errors.length ? `; problems: ${c.errors.join("; ")}` : ""}.`);
    }
    if (s.later.length) lines.push(`Kept for later, not told yet: ${s.later.length} (watch_later lists them).`);
    return lines.join("\n");
  };

  const profileRead = defineTool({
    name: "watch_profile",
    label: "News watch: profile",
    description:
      "Read the news watch: your written picture of the owner's interests, the searches, quiet hours, check times, whether it is on, the last check, and items kept for later. Use it when they ask what you watch for them.",
    parameters: Type.Object({}),
    meta: { capabilities: ["memory.write"], group: "memory", describe: () => "watch_profile" },
    execute: async (_args, ctx) => ownerOnly(ctx) ?? textResult(describeState(store.read(), ctx.now())),
  });

  const profileWrite = defineTool({
    name: "watch_profile_update",
    label: "News watch: update profile",
    description:
      "Rewrite your picture of the owner's interests and/or the searches. `profile` replaces the whole note (plain words, at most 2000 characters): what they follow, how much they care, where they live, how they like to hear things, what they reacted to; mark weak signals as weak. `searches` replaces the whole list: one per interest, with `topic` (what it is, unambiguous, e.g. \"Brann, the Bergen football club\"), `query` (the Google News search) and `edition` (en-US, en-GB, no-NO, sv-SE, or xx-YY).",
    parameters: Type.Object({
      profile: Type.Optional(Type.String()),
      searches: Type.Optional(
        Type.Array(Type.Object({ topic: Type.String(), query: Type.String(), edition: Type.Optional(Type.String()) })),
      ),
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
        if (clean) st.searches = clean;
      });
      return textResult(`Saved. ${s.searches.length} searches.`);
    },
  });

  const scan = defineTool({
    name: "watch_scan",
    label: "News watch: check",
    description:
      "Run one news check: fetch the last day's headlines for every search, skip ones already seen, keep those the relevance filter thinks are about their topic, and return the short list together with your picture of the owner, what you already told them, and whether it is quiet hours. Deciding what matters is yours.",
    parameters: Type.Object({}),
    meta: { capabilities: ["web.read", "memory.write"], group: "web", describe: () => "watch_scan" },
    execute: async (_args, ctx, signal) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const before = store.read();
      if (before.searches.length === 0) return textResult(`No searches yet, so nothing to check.\n\n${describeState(before, ctx.now())}`);
      const { summary, candidates } = await runScan(
        {
          store,
          ...(sieve ? { sieve } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.lookup ? { lookup: deps.lookup } : {}),
          now: () => ctx.now(),
        },
        signal,
      );
      const s = store.read();
      const at = ctx.now();
      deps.audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { watcher: "check", ...summary } });
      const head = `News check. ${summary.fetched} headlines from ${summary.searches} searches, ${summary.fresh} new, ${summary.passed} on the short list (filter: ${summary.sieve === "jev" ? "Jev" : summary.sieve === "partial" ? "Jev, partly unavailable" : "none, so only the newest few per search"}).${summary.errors.length ? ` Problems: ${summary.errors.join("; ")}.` : ""}`;
      const list = candidates.length ? formatCandidates(candidates, at) : "(nothing new)";
      const told = s.sent.slice(-8).map((r) => `- ${ago(r.at, at)}: "${clip(r.text, 160)}"`);
      const quiet = inQuietHours(at, tz(), s.quiet);
      return textResult(
        [
          head,
          "",
          wrapUntrusted(list, "news headlines"),
          "",
          "What you know about the owner:",
          s.profile.trim() || "(nothing yet)",
          "",
          "Already told them recently:",
          ...(told.length ? told : ["(nothing)"]),
          ...(s.later.length ? ["", `Kept for later, not told yet: ${s.later.length} (watch_later lists them).`] : []),
          "",
          quiet ? `It is quiet hours now (${s.quiet.start}-${s.quiet.end}): do not text; keep anything worth telling with watch_keep.` : "Not quiet hours.",
        ].join("\n"),
      );
    },
  });

  const send = defineTool({
    name: "watch_send",
    label: "News watch: text the owner",
    description:
      "Text the owner something the news watch found, or the one-time question about their interests. The only way the news watch texts them. Bundle everything into one message. Pass the `links` of the stories it mentions so they are never sent twice. It may refuse (quiet hours, enough texts for today, a repeat); then keep the items with watch_keep instead.",
    parameters: Type.Object({
      text: Type.String({ description: "The message, as you would text it. Short; one line of why per item." }),
      links: Type.Optional(Type.Array(Type.String(), { description: "Links of the stories mentioned" })),
    }),
    meta: {
      capabilities: ["owner.relay", "memory.write"],
      group: "owner",
      describe: (a) => `watch_send: ${clip(String((a as { text?: unknown }).text ?? ""), 80)}`,
      replyTarget: () => "owner", // [sunshine:reply-guard] this text is the run's message
    },
    execute: async ({ text, links }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const body = text.trim();
      if (!body) return fail("Nothing to send: the text is empty.");
      if (body.length > TEXT_MAX_CHARS) return fail(`That is ${body.length} characters; keep it under ${TEXT_MAX_CHARS}.`);
      const phone = deps.config.owner.phones[0];
      if (!phone) return fail("The owner has no phone on file, so the news watch cannot text them.");
      const at = ctx.now();
      const s = store.read();
      const held = (reason: string, message: string): ToolResultLike => {
        deps.audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { watcher: "held", reason, chars: body.length } });
        return fail(message);
      };
      if (inQuietHours(at, tz(), s.quiet)) {
        return held("quiet hours", `Not sent: it is quiet hours for ${deps.config.owner.name} (${s.quiet.start}-${s.quiet.end}). Keep it with watch_keep.`);
      }
      const today = localDate(at, tz());
      if (s.sent.filter((r) => localDate(new Date(r.at), tz()) === today).length >= limit) {
        return held("daily limit", "Not sent: they have had enough unprompted texts today. Keep it with watch_keep.");
      }
      const wanted = [...new Set((links ?? []).map((l) => l.trim()).filter(Boolean))];
      const told = new Set(s.sent.flatMap((r) => r.links));
      const repeats = wanted.filter((l) => told.has(l));
      if (repeats.length) return held("repeat", `Not sent: you already told them about ${repeats.join(", ")}. Leave those out.`);

      await deps.outbox.send({ channel: "imessage", to: phone, text: body }, { principal: ctx.principal, conversationKey: ctx.conversationKey });
      deps.audit.append({ kind: "outbound", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { channel: "imessage", to: phone, chars: body.length, via: "watcher", links: wanted.length } });
      store.update((st) => {
        st.sent.push({ at: at.toISOString(), text: body, links: wanted });
        st.later = st.later.filter((l) => !wanted.includes(l.link));
      });
      return textResult(`Sent to ${deps.config.owner.name}.`);
    },
  });

  const keep = defineTool({
    name: "watch_keep",
    label: "News watch: keep for later",
    description:
      "Keep stories that are worth knowing but not worth interrupting the owner for now. They come up when the owner asks for news, or in the next text. Kept for 7 days.",
    parameters: Type.Object({
      items: Type.Array(Type.Object({ title: Type.String(), link: Type.String(), topic: Type.Optional(Type.String()), why: Type.Optional(Type.String()) })),
    }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `watch_keep ${((a as { items?: unknown[] }).items ?? []).length} items` },
    execute: async ({ items }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      const at = ctx.now().toISOString();
      const s = store.update((st) => {
        const have = new Set(st.later.map((l) => l.link));
        for (const it of items) {
          if (!it.title.trim() || !it.link.trim() || have.has(it.link)) continue;
          st.later.push({ at, title: clip(it.title.trim(), 200), link: it.link.trim(), ...(it.topic ? { topic: clip(it.topic, 80) } : {}), ...(it.why ? { why: clip(it.why, 200) } : {}) });
          have.add(it.link);
        }
      });
      return textResult(`Kept. ${s.later.length} items waiting.`);
    },
  });

  const later = defineTool({
    name: "watch_later",
    label: "News watch: kept items",
    description:
      "List the stories kept for later. Use it when the owner asks for news or \"anything new?\". With `clear` true (the default), the listed items count as told and are removed.",
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
      "Turn the news watch on or off, change the check times (owner's local time, e.g. [\"09:00\",\"18:00\"]), the owner's quiet hours (when nothing unprompted may be sent), or record that you asked about their interests.",
    parameters: Type.Object({
      on: Type.Optional(Type.Boolean()),
      times: Type.Optional(Type.Array(Type.String())),
      quietStart: Type.Optional(Type.String()),
      quietEnd: Type.Optional(Type.String()),
      askedInterests: Type.Optional(Type.Boolean()),
    }),
    meta: { capabilities: ["schedule.manage"], group: "schedule", describe: (a) => `watch_settings ${JSON.stringify(a)}` },
    execute: async ({ on, times, quietStart, quietEnd, askedInterests }, ctx) => {
      const denied = ownerOnly(ctx);
      if (denied) return denied;
      let cleanTimes: string[] | undefined;
      if (times !== undefined) {
        cleanTimes = [...new Set(times.map(normalizeTime))].filter((t): t is string => Boolean(t)).sort();
        if (cleanTimes.length !== times.length || cleanTimes.length < 1 || cleanTimes.length > 4) return fail("Give 1 to 4 different times of day, like 09:00.");
      }
      const qs = quietStart === undefined ? undefined : normalizeTime(quietStart);
      const qe = quietEnd === undefined ? undefined : normalizeTime(quietEnd);
      if ((quietStart !== undefined && !qs) || (quietEnd !== undefined && !qe)) return fail("Quiet hours need times of day, like 22:00 and 08:00.");

      const before = store.read();
      const turnOn = on ?? before.on;
      // A check job deleted by hand (schedule_delete) comes back when the watch is turned on again.
      const missing = turnOn && (before.scheduleIds.length === 0 || before.scheduleIds.some((id) => !deps.scheduler.get(id)));
      const reschedule = (on !== undefined && on !== before.on) || (cleanTimes !== undefined && turnOn) || (on === true && missing);
      const s = store.update((st) => {
        if (cleanTimes) st.times = cleanTimes;
        if (qs) st.quiet.start = qs;
        if (qe) st.quiet.end = qe;
        if (askedInterests !== undefined) st.askedInterests = askedInterests;
        st.on = turnOn;
        if (reschedule) {
          for (const id of st.scheduleIds) deps.scheduler.delete(id);
          st.scheduleIds = [];
          if (turnOn) {
            for (const t of st.times) {
              const [h, m] = t.split(":");
              const entry = deps.scheduler.create({
                name: `news watch ${t}`,
                prompt: WATCH_PROMPT,
                cron: `${Number(m)} ${Number(h)} * * *`,
                tz: tz(),
                enabled: true,
                toolRepliesOnly: true, // [sunshine:watcher] texts only through watch_send's fences
              });
              st.scheduleIds.push(entry.id);
            }
          }
        }
      });
      return textResult(describeState(s, ctx.now()).split("\n")[0] ?? "Saved.");
    },
  });

  return [profileRead, profileWrite, scan, send, keep, later, settings];
}

function formatCandidates(list: Candidate[], at: Date): string {
  return list
    .map((c, i) => `${i + 1}. [${c.topic}] ${c.title}${c.source ? ` (${c.source})` : ""}, ${ago(c.publishedAt, at)}${c.p === undefined ? ", unfiltered" : ""}\n   ${c.link}`)
    .join("\n");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
