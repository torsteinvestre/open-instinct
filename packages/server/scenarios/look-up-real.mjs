// [sunshine:in-the-flow] Paid (the summary step only, Sonnet 5.5, about 2-3 cents a run) and it READS THE OWNER'S REAL
// EMAIL AND CALENDAR (read only; Torstein's OK each time). The question: does the summary step write searches and days
// that find the answer in a real inbox and calendar? The stand-in scenario (in-the-flow.mjs) cannot tell: its inbox is
// four made-up emails. The agent is not run; the hand-off it would get is graded.
//   nov3      "the event on the third of November ... it's in some email"   -> the Founders Story email is looked up
//   jcole     "put the J. Cole concert in my calendar" (notes: tickets)      -> the ticket email or calendar event is looked up,
//                                                                              and the summary says nothing about what the calendar holds
//   nextweek  "do I have anything next week?"                                -> the calendar of next week (Mon-Sun) is read
// Deliberate differences from live: short seeded notes instead of his real notes (fewer distractions, so a little
// easier); the record is made "now", so dates resolve against today.
//
// Usage (from packages/server, after `pnpm build`), through ~/sunshine-ops (it passes the agent's saved Composio session):
//   APPS_JSON=<the agent's apps.json> COMPOSIO_API_KEY=... ANTHROPIC_API_KEY=... RUNS=2 CASES=nov3,jcole,nextweek MAX_USD=0.5 node scenarios/look-up-real.mjs
//   DRY=1   checks the checks on known answers; no model call, no email read
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, ItemArchive, MemoryStore, StateDir, defaultConfig } from "@open-instinct/core";
import { APPS_STATE_FILE, ComposioApps } from "@open-instinct/apps";
import { modelCall, resolveWatcherModel } from "@open-instinct/watcher";
import { DEFAULT_INTAKE_MODEL, INTAKE_REASONING, createIntake } from "../dist/intake.js";
import { composioSources, createLookUp } from "../dist/lookup.js";

const TZ = "Europe/Oslo";
const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
// Next week's Monday and Sunday, from today in Oslo.
function nextWeek(now) {
  const today = Date.parse(`${ymd(now)}T12:00:00Z`);
  const dow = new Date(today).getUTCDay(); // 0 Sunday
  const monday = today + ((8 - dow) % 7 || 7) * 86_400_000;
  return { first: ymd(monday), last: ymd(monday + 6 * 86_400_000) };
}

// Claims about what the calendar holds, in the kept summary (the 27 Oct guess: "not in it yet"). Calendar only: "it's in
// some email" is what he said, not a claim about the inbox.
const STATE_CLAIM = /\b(not|isn't|is not|already|still not)\b[^.;,]{0,40}\b(in|on)\b[^.;,]{0,20}\bcalendar\b|\bnot in it yet\b|\bcalendar\s+(doesn't|does not|has no)\b/i;
const summaryText = (s) => [s?.summary ?? "", ...(s?.decisions ?? []), ...(s?.ownerTasks ?? []), ...(s?.othersTasks ?? []), ...(s?.open ?? []), ...(s?.toSettle ?? [])].join("\n");

const CASES = {
  nov3: {
    text: ["[00:02] Torstein: Okay, voice note for myself. Gym was good today, legs again.", "[00:20] Torstein: Oh and put the event on the third of November in my calendar, I don't remember the time, it's in some email I think.", "[00:41] Torstein: And I need to buy a new charger at some point."].join("\n"),
    check: (r) => {
      const found = /founders story/i.test(r.live);
      const claim = STATE_CLAIM.test(summaryText(r.summary));
      return { pass: found && !claim, notes: [found ? "Founders Story looked up" : "Founders Story NOT looked up", claim ? "summary claims calendar/inbox state" : "no state claim"] };
    },
  },
  jcole: {
    text: ["[00:03] Torstein: Quick one. Put the J. Cole concert in my calendar, I've got the tickets."].join("\n"),
    check: (r) => {
      const found = /^- .*j\.? ?cole/im.test(r.live);
      const claim = STATE_CLAIM.test(summaryText(r.summary));
      return { pass: found && !claim, notes: [found ? "J. Cole looked up" : "J. Cole NOT looked up", claim ? "summary claims calendar/inbox state" : "no state claim"] };
    },
  },
  nextweek: {
    text: ["[00:02] Torstein: Do I have anything next week?"].join("\n"),
    check: (r, now) => {
      // Monday to Sunday, or the working week (Monday to Friday).
      const { first, last } = nextWeek(now);
      const friday = ymd(Date.parse(`${last}T12:00:00Z`) - 2 * 86_400_000);
      const week = r.asks.some((a) => a.days.some((d) => d === `${first}/${last}` || d === `${first}/${friday}`));
      const read = /^Calendar, /m.test(r.live);
      return { pass: week && read, notes: [week ? `next week asked (${first}..)` : `next week NOT asked (days: ${r.asks.flatMap((a) => a.days).join(", ") || "none"})`, read ? "calendar read" : "calendar not read"] };
    },
  },
};
const NOTES = "## About\n- Torstein lives in Oslo and is building Sunshine, a personal AI agent.\n## Lately\n- Has tickets for the J. Cole concert in November 2026.\n";

if (process.env.DRY) {
  const now = Date.parse("2026-10-29T10:00:00Z"); // Thu 29 Oct: next week is Mon 2 - Sun 8 Nov
  const r = (o) => ({ live: "", summary: { summary: "S.", decisions: [], ownerTasks: [], othersTasks: [], open: [] }, asks: [], ...o });
  const known = [
    ["nov3", r({ live: 'Email, searched for "3 November":\n- Sat, 17 Oct 2026, from x: It\'s official! You\'re on the guestlist for Founders Story Oslo' }), true],
    ["nov3", r({ live: "Email, searched for event: nothing found." }), false],
    ["nov3", r({ live: "- Founders Story Oslo", summary: { summary: "S.", decisions: [], ownerTasks: ["Add the 3 Nov event to the calendar (not in it yet)"], othersTasks: [], open: [] } }), false],
    // What he said about where the details are is not a claim about the calendar.
    ["nov3", r({ live: "- Founders Story Oslo", summary: { summary: "Torstein does not remember the time, it is in an email.", decisions: [], ownerTasks: ["Put the 3 Nov event in the calendar, he does not remember the time"], othersTasks: [], open: [] } }), true],
    ["nov3", r({ live: "- Founders Story Oslo", summary: { summary: "The event is not yet in his calendar.", decisions: [], ownerTasks: [], othersTasks: [], open: [] } }), false],
    ["jcole", r({ live: "Email, searched for \"J. Cole\":\n- Wed, 25 Feb 2026, from Ticketmaster: Ordrebekreftelse til J. Cole: The Fall-Off Tour" }), true],
    ["jcole", r({ live: "Calendar, Thu, 12 Nov 2026:\n- 19:00-22:00 J. Cole: The Fall-Off Tour" }), true],
    ["jcole", r({ live: "Email, searched for \"J. Cole\": nothing found." }), false],
    ["jcole", r({ live: "- J. Cole", summary: { summary: "Torstein wants the J. Cole concert added; it is not on his calendar yet.", decisions: [], ownerTasks: [], othersTasks: [], open: [] } }), false],
    ["jcole", r({ live: "- J. Cole", summary: { summary: "S.", decisions: [], ownerTasks: ["Add the J. Cole concert to the calendar"], othersTasks: [], open: [] } }), true],
    ["nextweek", r({ live: "Calendar, Mon, 2 Nov 2026 to Sun, 8 Nov 2026: nothing in the calendar.", asks: [{ searches: [], days: ["2026-11-02/2026-11-08"] }] }), true],
    ["nextweek", r({ live: "Calendar, Mon, 2 Nov 2026 to Fri, 6 Nov 2026: nothing in the calendar.", asks: [{ searches: [], days: ["2026-11-02/2026-11-06"] }] }), true],
    ["nextweek", r({ live: "Calendar, Mon, 26 Oct 2026 ...", asks: [{ searches: [], days: ["2026-10-26/2026-11-01"] }] }), false],
    ["nextweek", r({ live: "", asks: [{ searches: [], days: [] }] }), false],
  ];
  let ok = 0;
  for (const [c, res, want] of known) {
    const got = CASES[c].check(res, now);
    ok += got.pass === want;
    console.log(`${got.pass === want ? "ok   " : "WRONG"} ${c} ${got.pass ? "pass" : "fail"} (${got.notes.join("; ")})`);
  }
  console.log(`${ok}/${known.length} known answers checked right`);
  process.exit(ok === known.length ? 0 : 1);
}

const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const saved = JSON.parse(need("APPS_JSON"));
const RUNS = Number(process.env.RUNS ?? 2);
const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
const WANT = (process.env.CASES ?? Object.keys(CASES).join(",")).split(",").map((c) => c.trim());
const model = resolveWatcherModel(process.env.INTAKE_MODEL?.trim() || DEFAULT_INTAKE_MODEL, process.env);
const call = modelCall(model, { reasoning: INTAKE_REASONING, apiKey: need("ANTHROPIC_API_KEY") });

async function once(name) {
  const dir = mkdtempSync(join(tmpdir(), `look-up-real-${name}-`));
  const state = new StateDir(dir);
  state.ensure();
  // The agent's own Composio session (no new session is made): the same connection the agent uses.
  state.writeJson(APPS_STATE_FILE, saved);
  const apps = new ComposioApps({ apiKey: need("COMPOSIO_API_KEY"), userId: saved.userId, toolkits: saved.toolkits, mode: saved.mode, state, logger: () => {} });
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: TZ };
  const memory = new MemoryStore(state);
  memory.replaceDurable(NOTES);
  const audit = new AuditLog(state);
  const inner = createLookUp({ sources: composioSources(apps, () => TZ), config, audit });
  const asks = [];
  const tasks = [];
  const intake = createIntake({
    items: new ItemArchive(state), memory, config, audit, call,
    runTask: async (t) => (tasks.push(t), "NO_REPLY"),
    lookUp: async (ask) => (asks.push(ask), inner(ask)),
  });
  const now = Date.now();
  try {
    const result = await intake.receive({ id: `rec-${name}`, source: "recording", startedAt: now - 2 * 60_000, endedAt: now - 60_000, text: CASES[name].text });
    const prompt = tasks[0]?.prompt ?? "";
    const live = /<untrusted source="email and calendar">\n([\s\S]*?)\n<\/untrusted>/.exec(prompt)?.[1] ?? "";
    const r = { live, summary: result.summary, asks, cost: result.costUsd, outcome: result.outcome };
    return { case: name, ...r, ...CASES[name].check(r, now) };
  } finally {
    await apps.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
    console.log(`${name} #${i + 1}: ${r.pass ? "PASS" : "FAIL"} (${r.notes.join("; ")}) $${r.cost.toFixed(3)} ${r.outcome}`);
    for (const a of r.asks) console.log(`    asked: searches ${JSON.stringify(a.searches)} days ${JSON.stringify(a.days)}`);
    if (r.summary?.toSettle?.length) console.log(`    still unclear: ${r.summary.toSettle.join(" | ")}`);
    if (r.summary?.ownerTasks?.length) console.log(`    owner tasks: ${r.summary.ownerTasks.join(" | ")}`);
    for (const l of r.live.split("\n").filter(Boolean)) console.log(`    | ${l.slice(0, 160)}`);
  }
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed, $${total.toFixed(3)}`);
for (const name of WANT) console.log(`  ${name}: ${results.filter((r) => r.case === name && r.pass).length}/${results.filter((r) => r.case === name).length}`);
process.exit(0);
