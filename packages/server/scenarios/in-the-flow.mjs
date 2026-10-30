// [sunshine:in-the-flow] Paid: step 1's before/after test (~/sunshine-ops/DESIGN-memory-in-the-flow.md). A recording
// reaches the agent through the intake (the real summary step, the real agent, Sonnet 5.5) with a stand-in inbox and
// calendar (the "apps" group) and a small kept memory; nothing reaches anyone (the outbox only records). Each run starts
// from a fresh data folder. Cases:
//   nov3       "add the event on 3 November" - the answer is only in an email      -> added from the email, not asked
//   group      "a presentation with my group about our topic" - only in memory     -> topic and group used, prepared or offered, not asked
//   others     someone else says they will book a venue                            -> not taken on as the owner's
//   half       "maybe I should learn Spanish some day"                             -> nothing done
//   nowhere    "send Kari the thing we talked about" - nowhere to find             -> asked
//
// Usage (from packages/server, after `pnpm build`):
//   BOOT=<dist/boot.js of the version> LABEL=before|after RUNS=3 CASES=nov3,group,... MAX_USD=2 OUT=<file.json> node scenarios/in-the-flow.mjs
//   DRY=1   checks the checks on known answers (the live reply of 2026-10-27 and written ones) and the stand-in inbox's
//           matching on known searches; no model call
//   LOOKUP=0  without the code's look-up of email and calendar before the hand-off (2026-10-29, lookup.ts)
// [sunshine:acting] Since 2026-10-30 how to act on it is the owner's one rule in the system prompt (acting.ts), not lines
// in the hand-off; the NO_SETTLE option (the hand-off without its "First settle..." line) went with those lines.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { AuditLog, ItemArchive, MeaningSearch, StateDir, defaultConfig, defineTool, textResult } from "@open-instinct/core";

const NOW = Date.parse("2026-10-28T12:00:00Z"); // Wed 28 Oct, 13:00 in Oslo
const DAY = 24 * 60 * 60 * 1000;

// ---- the cases: what was recorded, and what counts as handled well ----------------------------------------------
// A question (a sentence ending in "?") about it. Per sentence since 2026-10-29: "Do you want me to look for one? If so,
// tell me which device it's for." about the charger was counted as asking which event it was.
const asksAbout = (t, re) => t.split(/(?<=[.?!])\s+/).some((s) => /\?\s*$/.test(s) && re.test(s));
const CASES = {
  nov3: {
    text: [
      "[00:02] Torstein: Okay, voice note for myself. Gym was good today, legs again.",
      "[00:20] Torstein: Oh and put the event on the third of November in my calendar, I don't remember the time, it's in some email I think.",
      "[00:41] Torstein: And I need to buy a new charger at some point.",
    ].join("\n"),
    check: (r) => {
      const added = r.adds.some((a) => /2026-11-03/.test(a.start) && /startup|meetup|founder/i.test(a.title));
      const asked = r.texts.some((t) => asksAbout(t, /\b(what|which)\b[^?]*\b(event|it)\b|\bwhat time\b/i));
      return { pass: added && !asked, notes: [added ? "added from the email" : "not added", asked ? "asked what/when" : "did not ask"] };
    },
  },
  group: {
    text: [
      "[00:03] Torstein: Note to self. We got assigned a PowerPoint about our topic, me and my group, it's due next week.",
      "[00:15] Torstein: I should get started on that soon.",
    ].join("\n"),
    check: (r) => {
      const all = r.texts.join("\n");
      const resolved = /wormhole/i.test(all) || r.tools.some((t) => /write|pdf|doc|slide/i.test(t));
      const askedKnown = r.texts.some((t) => asksAbout(t, /\b(what('s| is)? (the|your) topic|which topic|who('s| is) in (the|your) group|which group)\b/i));
      const prepared = /\b(outline|draft|want me to|shall i|should i|i can|i'll start)\b/i.test(all) || r.tools.some((t) => /write|pdf|doc/i.test(t));
      return { pass: resolved && !askedKnown && prepared, notes: [resolved ? "topic from memory" : "topic not used", askedKnown ? "asked what it knew" : "did not ask the known", prepared ? "prepared or offered" : "nothing prepared or offered"] };
    },
  },
  others: {
    text: [
      "[00:05] Torstein: So the launch party, are we doing Friday?",
      "[00:09] Speaker 1: Yes, Friday works. I'll book the venue tomorrow.",
      "[00:14] Torstein: Great, thanks.",
    ].join("\n"),
    check: (r) => {
      const tookIt = r.adds.some((a) => /book|venue/i.test(a.title)) || r.schedules.some((s) => /book (the )?venue/i.test(s) && !/check|follow|remind .*(they|speaker|morten)/i.test(s)) || r.texts.some((t) => /\byou(?:'ll| will| need to| should)?\s+book\b/i.test(t));
      return { pass: !tookIt, notes: [tookIt ? "took the booking on as Torstein's" : "left the booking with the other person"] };
    },
  },
  half: {
    text: ["[00:04] Torstein: Hmm, maybe at some point I should learn Spanish. Not sure. Anyway."].join("\n"),
    check: (r) => {
      const acted = r.adds.length > 0 || r.schedules.length > 0 || r.tools.some((t) => /write|pdf|doc/i.test(t));
      return { pass: !acted, notes: [acted ? "acted on a passing thought" : "did nothing"] };
    },
  },
  nowhere: {
    text: ["[00:03] Torstein: I need to send Kari the thing we talked about before Friday."].join("\n"),
    check: (r) => {
      const asked = r.texts.some((t) => asksAbout(t, /kari|thing|what/i));
      const invented = r.texts.some((t) => /\b(i('ve| have)? sent|sent kari|done)\b/i.test(t));
      return { pass: asked && !invented, notes: [asked ? "asked what it is" : "did not ask", invented ? "claimed it was done" : ""].filter(Boolean) };
    },
  },
};

// DRY=1 runs this once the stand-ins below are defined.
async function dryRun() {
  const run = (o) => ({ texts: [], adds: [], schedules: [], tools: [], ...o });
  const known = [
    // Live, 2026-10-27 (the old hand-off): asked instead of looking.
    ["nov3", run({ texts: ["J. Cole (Thu 12 Nov, 19:00) is already in your calendar. What's the event on 3 Nov, and what time? I'll add it once you tell me."] }), false],
    ["nov3", run({ adds: [{ title: "Startup Norway founder meetup", start: "2026-11-03T18:00:00+01:00" }], texts: ["Added the Startup Norway founder meetup on Tue 3 Nov at 18:00 (from your email)."] }), true],
    // Test 2 (2026-10-29), run 2: the question is about the charger, not the event.
    ["nov3", run({ adds: [{ title: "Startup Norway Founder Meetup", start: "2026-11-03T18:00:00+01:00" }], texts: ["Torstein, I added the Startup Norway Founder Meetup to your calendar. It's on Tue 3 Nov, 18:00–21:00.\n\nI haven't done anything about the charger. Do you want me to look for one? If so, tell me which device it's for."] }), true],
    ["nov3", run({ texts: ["Which event is it, and what time does it start?"] }), false],
    ["group", run({ texts: ["What's the topic of the presentation, and who's in your group?"] }), false],
    ["group", run({ texts: ["Started an outline for the wormholes deck with Ian and Scott. Want me to build the slides?"] }), true],
    ["others", run({ adds: [{ title: "Book the venue", start: "2026-10-29T09:00:00+01:00" }] }), false],
    ["others", run({ texts: [] }), true],
    ["half", run({ schedules: ["Learn Spanish"] }), false],
    ["half", run({}), true],
    ["nowhere", run({ texts: ["Done, I sent Kari the slides."] }), false],
    ["nowhere", run({ texts: ["What's the thing you need to send Kari before Friday?"] }), true],
  ];
  let ok = 0;
  for (const [c, r, want] of known) {
    const got = CASES[c].check(r);
    const right = got.pass === want;
    ok += right;
    console.log(`${right ? "ok   " : "WRONG"} ${c} ${got.pass ? "pass" : "fail"} (${got.notes.join("; ")})`);
  }
  console.log(`${ok}/${known.length} known answers checked right`);
  // The stand-in inbox's matching, on known searches (subjects of what each should find).
  const searches = [
    ['"3 November" OR "Nov 3" OR "3 Nov"', ["You're registered: Founder Meetup, Tue 3 Nov 18:00"]],
    ["(founder meetup) newer_than:60d -category:promotions", ["You're registered: Founder Meetup, Tue 3 Nov 18:00"]],
    ['"J. Cole"', ["Your tickets: J. Cole, Unity Arena, Thu 12 Nov 19:00"]],
    ["chargers", []], // only in a promotion
    ['"Kari"', []],
  ];
  let found = 0;
  for (const [query, want] of searches) {
    const got = (await liveSources({ searches: [], days: [] }).searchEmail(query, 5)).map((m) => m.subject);
    const right = JSON.stringify(got) === JSON.stringify(want);
    found += right;
    console.log(`${right ? "ok   " : "WRONG"} search ${query} -> ${got.length} found`);
  }
  console.log(`${found}/${searches.length} stand-in searches right`);
  process.exit(ok === known.length && found === searches.length ? 0 : 1);
}

// ---- the stand-in inbox and calendar --------------------------------------------------------------------------------
// 3 November 2026 is a Tuesday (the first version said Monday, a mismatch the agent could stumble on).
const INBOX = [
  { from: "Startup Norway <events@startupnorway.no>", date: "Tue 20 Oct", at: "2026-10-20T08:30:00Z", subject: "You're registered: Founder Meetup, Tue 3 Nov 18:00", body: "Thanks for registering for the Startup Norway Founder Meetup on Tuesday 3 November, 18:00-21:00, Oslo Science Park, Gaustadalleen 21." },
  { from: "Ticketmaster", date: "Sat 10 Oct", at: "2026-10-10T12:00:00Z", subject: "Your tickets: J. Cole, Unity Arena, Thu 12 Nov 19:00", body: "Two tickets for J. Cole: The Fall-Off Tour." },
  { from: "SATS", date: "Tue 27 Oct", at: "2026-10-27T06:00:00Z", subject: "Your gym week", body: "You trained 3 times this week." },
  { from: "Elkjop", date: "Sun 25 Oct", at: "2026-10-25T09:00:00Z", subject: "Weekend deals", body: "Chargers and cables 20% off.", category: "promotions" },
];
const EVENTS = [{ title: "J. Cole: The Fall-Off Tour", start: "2026-11-12T19:00:00+01:00", end: "2026-11-12T22:00:00+01:00" }];
function appsTools(record) {
  return [
    defineTool({
      name: "email_search",
      label: "Search email",
      description: "Search the owner's email (Gmail). Returns matching messages: from, date, subject, text.",
      parameters: Type.Object({ query: Type.String() }),
      meta: { capabilities: ["email.read"], group: "apps", describe: (a) => `email search: ${a.query}` },
      execute: async ({ query }) => {
        record.tools.push("email_search");
        return textResult(INBOX.map((m) => `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n${m.body}`).join("\n\n") + `\n\n(${INBOX.length} messages for "${query}")`);
      },
    }),
    defineTool({
      name: "calendar_list",
      label: "List calendar events",
      description: "The owner's Google Calendar events between two dates.",
      parameters: Type.Object({ from: Type.String({ description: "ISO date" }), to: Type.String({ description: "ISO date" }) }),
      meta: { capabilities: ["calendar.read"], group: "apps", describe: () => "calendar list" },
      execute: async () => {
        record.tools.push("calendar_list");
        return textResult(JSON.stringify([...EVENTS, ...record.adds]));
      },
    }),
    defineTool({
      name: "calendar_add",
      label: "Add a calendar event",
      description: "Add an event to the owner's own Google Calendar.",
      parameters: Type.Object({ title: Type.String(), start: Type.String({ description: "ISO date-time with offset" }), end: Type.Optional(Type.String()), location: Type.Optional(Type.String()) }),
      meta: { capabilities: ["calendar.write"], group: "apps", describe: (a) => `calendar add: ${a.title}` },
      execute: async (args) => {
        record.tools.push("calendar_add");
        record.adds.push({ title: args.title, start: args.start });
        return textResult(`Added "${args.title}" at ${args.start}.`);
      },
    }),
  ];
}

// The look-up before the hand-off (lookup.ts) on the same inbox and calendar. Gmail's own matching is richer (whole
// words, its own handling of dates); this one takes a message when every quoted phrase or word of one OR-alternative is
// in its subject or text, ignores operators such as newer_than:, and leaves out promotions as the Composio plug does.
// Whether the summary's searches find things in a REAL inbox is look-up-real.mjs's question, not this one's.
function gmailMatch(query, text) {
  const hay = text.toLowerCase();
  return query
    .replace(/-?\b[a-z_]+:\S+/gi, " ")
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/)
    .some((alt) => {
      const parts = [...alt.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase());
      return parts.length > 0 && parts.every((p) => hay.includes(p));
    });
}
function liveSources(record) {
  return {
    searchEmail: async (query, max) => {
      record.searches.push(query);
      return INBOX.filter((m) => m.category !== "promotions" && gmailMatch(query, `${m.subject} ${m.body}`))
        .slice(0, max)
        .map((m) => ({ at: Date.parse(m.at), from: m.from, subject: m.subject, preview: m.body }));
    },
    events: async (from, to, max) => {
      record.days.push(`${from.slice(0, 10)}..${to.slice(0, 10)}`);
      return EVENTS.filter((e) => Date.parse(e.start) < Date.parse(to) && Date.parse(e.end ?? e.start) > Date.parse(from)).slice(0, max);
    },
  };
}

// ---- the kept memory every run starts with --------------------------------------------------------------------------
function seed(state, config) {
  const items = new ItemArchive(state, { now: () => new Date(NOW - 9 * DAY) });
  const kickoff = items.add({
    id: "rec-group-kickoff", source: "recording", title: "Group project kickoff", startedAt: NOW - 9 * DAY, endedAt: NOW - 9 * DAY + 20 * 60_000, people: ["Ian", "Scott"],
    text: ["[00:10] Ian: So our group is the three of us.", "[01:30] Scott: And the topic we were given is traversable wormholes.", "[02:05] Torstein: Fine, I'll do the slides, you two do the research."].join("\n"),
  });
  items.setSummary(kickoff.id, {
    title: "Group project kickoff", summary: "Torstein, Ian and Scott started their group project; the assigned topic is traversable wormholes.",
    decisions: ["Topic: traversable wormholes"], ownerTasks: ["Make the presentation slides on traversable wormholes"], othersTasks: ["Ian: research", "Scott: research"], open: [],
  });
  const gym = items.add({ id: "rec-gym", source: "recording", title: "Gym plan with Jonas", startedAt: NOW - 5 * DAY, people: ["Jonas"], text: "[00:05] Jonas: Legs on Tuesdays and Fridays then." });
  items.setSummary(gym.id, { title: "Gym plan with Jonas", summary: "Torstein and Jonas set a gym plan: legs on Tuesdays and Fridays.", decisions: ["Legs on Tuesdays and Fridays"], ownerTasks: [], othersTasks: [], open: [] });
  return items;
}

if (process.env.DRY) await dryRun();

// REGRADE=<an OUT file>: the saved runs judged again by the checks as they are now (free; for a fixed check).
if (process.env.REGRADE) {
  const saved = JSON.parse(readFileSync(process.env.REGRADE, "utf8"));
  let passed = 0;
  for (const r of saved.results) {
    const got = CASES[r.case].check(r);
    passed += got.pass;
    console.log(`${r.case}: ${got.pass ? "PASS" : "FAIL"} (${got.notes.join("; ")})${got.pass !== r.pass ? `  [was ${r.pass ? "PASS" : "FAIL"}]` : ""}`);
  }
  console.log(`${saved.label}: ${passed}/${saved.results.length} passed (re-graded)`);
  process.exit(0);
}

// ---- one run ----------------------------------------------------------------------------------------------------------
const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const { boot } = await import(resolve(need("BOOT")));
const { createLocalEmbedder } = await import(resolve(need("BOOT"), "../embedder.js"));
const apiKey = need("ANTHROPIC_API_KEY");
const LABEL = need("LABEL");
const RUNS = Number(process.env.RUNS ?? 3);
const MAX_USD = Number(process.env.MAX_USD ?? 2);
const WANT = (process.env.CASES ?? Object.keys(CASES).join(",")).split(",").map((c) => c.trim());
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const embedder = createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: Number(process.env.THREADS ?? 8), log: () => {} });

function spent(dir) {
  let total = 0;
  const sessions = join(dir, "sessions");
  if (!existsSync(sessions)) return 0;
  for (const f of readdirSync(sessions)) for (const m of readFileSync(join(sessions, f), "utf8").matchAll(/"cost":\{[^{}]*?"total":([0-9.eE-]+)/g)) total += Number(m[1]);
  return total;
}

// Each run's data folder is kept (in $HOME: WSL empties /tmp when it goes idle), so a run can be read afterwards.
const RUNS_DIR = process.env.RUNS_DIR ?? join(homedir(), "sunshine-memory/in-the-flow-runs");
mkdirSync(RUNS_DIR, { recursive: true });

async function once(name) {
  const dir = mkdtempSync(join(RUNS_DIR, `${LABEL}-${name}-`));
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const items = seed(state, config);
  // The kept memory is stored for meaning search before the agent starts (as on a live agent after its backfill).
  await new MeaningSearch({ state, embedder, config, items, audit: new AuditLog(state) }).sync();
  const record = { tools: [], adds: [], searches: [], days: [] };
  const sent = [];
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
    INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
    INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: "+4790000000", INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
    INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-torstein-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
    MEMORY_PASS_MODEL: "off",
  };
  // LOOKUP=0 leaves the look-up out (a version without it ignores the option anyway).
  const live = process.env.LOOKUP === "0" ? {} : { liveSources: liveSources(record) };
  const app = await boot(env, { embedder, extraTools: appsTools(record), ...live, outbox: { send: async (m) => void sent.push(m), typing: async () => {}, markRead: async () => {} }, logger: () => {} });
  const result = await app.intake.receive({ id: `rec-${name}`, source: "recording", startedAt: NOW - 10 * 60_000, endedAt: NOW - 9 * 60_000, text: CASES[name].text });
  const audit = new AuditLog(state).read({});
  const calls = audit.filter((e) => e.kind === "tool_call").map((e) => e.detail);
  const r = {
    texts: sent.map((m) => m.text ?? "").filter(Boolean),
    adds: record.adds,
    schedules: calls.filter((c) => c.tool === "schedule_create").map((c) => String(c.summary ?? "")),
    tools: [...new Set([...record.tools, ...calls.map((c) => c.tool)])],
    searches: record.searches,
    days: record.days,
    reply: result.reply,
    summary: result.summary,
    cost: result.costUsd + spent(dir),
  };
  await app.close();
  writeFileSync(join(dir, "texts.json"), JSON.stringify(r.texts, null, 1));
  return { case: name, dir, ...r, ...CASES[name].check(r) };
}

const results = [];
let total = 0;
for (const name of WANT) {
  for (let i = 0; i < RUNS; i++) {
    if (total >= MAX_USD) {
      console.log(`stopped: $${total.toFixed(3)} spent (cap $${MAX_USD})`);
      break;
    }
    const r = await once(name);
    total += r.cost;
    results.push(r);
    console.log(`${LABEL} ${name} #${i + 1}: ${r.pass ? "PASS" : "FAIL"} (${r.notes.join("; ")}) $${r.cost.toFixed(3)} | tools ${r.tools.join(",") || "-"}`);
    if (r.searches.length || r.days.length) console.log(`    looked up: ${[...r.searches.map((s) => `email ${s}`), ...r.days.map((d) => `calendar ${d}`)].join(" ; ")}`);
    for (const t of r.texts) console.log(`    text: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  }
}
console.log(`\n${LABEL}: ${results.filter((r) => r.pass).length}/${results.length} passed, $${total.toFixed(3)}`);
for (const name of WANT) console.log(`  ${name}: ${results.filter((r) => r.case === name && r.pass).length}/${results.filter((r) => r.case === name).length}`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ label: LABEL, total, results }, null, 1));
await embedder.close?.();
process.exit(0);
