// [sunshine:memory] Does the nightly notes pass keep what a friend would remember, and keep out what does
// not belong? Short made-up conversations, one case each (a stated preference against a habit, what
// Sunshine read in email against what they took up, health they raised, calendar invitees, setup talk, a
// trip that is over, a file sent once, notes in the wrong section, a phone number, a move, nothing new),
// each run once through the real pass and Sonnet 5.5, and the notes it writes checked by code.
// Optionally also copies of a live agent's notes and thread (memory-copy.sh, kept outside the repo).
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/memory-notes.mjs [case,case] [today=<copy.json>] [old=<copy.json>]   (about 25 cents)
//   RUNS=2 runs the live copies twice. MAX_USD (default 0.35) stops before the next run once passed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, MemoryStore, Scheduler, StateDir, defaultConfig, writeSession } from "@open-instinct/core";
import { modelCall, resolveWatcherModel } from "@open-instinct/watcher";
import { MEMORY_REASONING, createMemoryPass } from "../dist/memory-pass.js";
import { renderNotes, saveLabels } from "../dist/memory-notes.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const args = process.argv.slice(2);
const pick = args.find((a) => !a.includes("="));
const copies = args.filter((a) => a.includes("=")).map((a) => { const [name, file] = a.split("="); return { name, copy: JSON.parse(readFileSync(file, "utf8")) }; });
const RUNS = Number(process.env.RUNS ?? 1);
const MAX_USD = Number(process.env.MAX_USD ?? 0.35);
const NOW = new Date("2026-10-17T01:30:00Z"); // 03:30 in Oslo
const T = Date.parse("2026-10-16T08:00:00Z");
const MIN = 60_000;

let seq = 0;
const stamp = (ts) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
const me = (text, m) => ({ role: "user", content: [{ type: "text", text: `[${stamp(T + m * MIN)} Europe/Oslo]\n${text}` }], timestamp: T + m * MIN });
const sun = (text, m) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: T + m * MIN + 5000 });
/** Sunshine used a tool first (email, calendar, the web), then said `text`. */
const sunAfter = (tool, text, m) => {
  const id = `t${++seq}`;
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: {} }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: T + m * MIN + 1000 },
    { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: "..." }], isError: false, timestamp: T + m * MIN + 2000 },
    sun(text, m),
  ];
};
const APPS = "app_composio_multi_execute_tool";
const lasting = (text) => ({ text, kind: "lasting", source: "said" });

// Each case: the notes before (labelled or as plain markdown), the day's conversation, and checks on the
// notes after: `has` (anywhere or in a section), `not` (anywhere or in a section).
const CASES = [
  { key: "pref", why: "a stated preference", messages: [me("pls keep your answers short, I hate long texts", 0), sun("Got it, short it is.", 0)], has: [["Preferences", /short/i]] },
  { key: "habit", why: "a habit in what they ask for is not a preference", messages: [me("remind me to drink water in 20 min", 0), sun("Will do.", 0), me("remind me to drink water again in an hour", 60), sun("Done.", 60), me("water reminder in 30 min pls", 180), sun("Set.", 180)], not: [[null, /water/i]] },
  { key: "inbox", why: "what Sunshine read out and nobody took up", messages: [me("check my inbox", 0), ...sunAfter(APPS, "Three new: Helsenorge says your prescription is ready to pick up, Nordnet's September statement, and a Ticketmaster newsletter.", 0), me("ok thanks", 2), sun("👍", 2)], not: [[null, /Helsenorge|prescription|Nordnet|Ticketmaster/i]] },
  { key: "takenup", why: "something read that they took up", messages: [me("anything on my calendar thursday?", 0), ...sunAfter(APPS, "Thursday 14:00: dentist at Grünerløkka Tannlegesenter.", 0), me("ugh right, I need to move that to next week", 2), sun("Which day suits you?", 2)], has: [["Lately", /dentist/i]] },
  { key: "health", why: "health they raised themselves", messages: [me("hurt my back lifting yesterday, I have physio on monday", 0), sun("Ouch, hope it eases. Want a reminder before Monday?", 0)], has: [[null, /back|physio/i]], not: [["Preferences", /back|physio/i]] },
  { key: "invitees", why: "calendar invitees: only who they talked about, no addresses", messages: [me("what's tomorrow look like?", 0), ...sunAfter(APPS, "10:00 roadmap meeting with Miles (miles@acmeco.io) and Jaleel (jaleel.k@gmail.com).", 0), me("nice, miles is my cofounder btw", 2), sun("Good to know.", 2)], has: [["People", /Miles/]], not: [[null, /@/], [null, /Jaleel/]] },
  { key: "setup", why: "talk about Sunshine itself", messages: [me("connect my gmail", 0), ...sunAfter("apps_connect", "Here's the link to connect Gmail: https://connect.composio.dev/link/x", 0), me("done. and check the news every 4 hours instead", 3), ...sunAfter("watch_settings", "Done, every 4 hours from now on.", 3)], not: [[null, /gmail|connect|every 4 hours|news/i]] },
  { key: "done", why: "a plan that is over", before: [{ text: "Trip to Lisbon 20-23 Oct with Sanna", kind: "current", source: "said", date: "2026-10-10" }, lasting("Lives in Oslo.")], messages: [me("back from lisbon, amazing trip!", 0), sun("Welcome back! Glad it was good.", 0)], has: [[null, /Oslo/]], not: [["Lately", /Trip to Lisbon 20-23 Oct/]] },
  { key: "oneoff", why: "a file sent once", messages: [me("make me a pdf packing list for a weekend in bergen", 0), ...sunAfter("create_pdf", "Here it is.", 0), me("thx", 1), sun("Have a good trip!", 1)], not: [[null, /pdf|packing list/i]] },
  // The colleagues may stay in a line about Torstein's work under About (a judgement call); they must not be lost.
  { key: "legacy", why: "older notes in the wrong section, unlabeled", beforeMd: "# Memory\n## About Torstein\n- Lives in Oslo.\n- Thinking about a trip to the Maldives. Not booked.\n- Runs company meetings with Jaleel and Zia.\n## Preferences\n- Likes short answers.\n- Often asks for quick water reminders.\n", messages: [me("hey", 0), sun("Hey! What's up?", 0)], has: [["Lately", /Maldives/], [null, /Jaleel|Zia/], ["Preferences", /short/i], ["About", /Oslo/]], not: [["About", /Maldives/], [null, /water/i]] },
  { key: "phone", why: "a phone number stays out", messages: [me("sanna's number is +47 912 34 567, she's my girlfriend", 0), sun("Saved. Good to know about Sanna.", 0)], has: [["People", /Sanna/]], not: [[null, /912|\+47/]] },
  { key: "moved", why: "a lasting fact that changed", before: [lasting("Lives in Oslo."), lasting("Works as a product designer.")], messages: [me("we moved to bergen last week!", 0), sun("Big change! How is it so far?", 0)], has: [["About", /Bergen/], ["About", /designer/i]], not: [[null, /Lives in Oslo/]] },
  { key: "upcoming", why: "something coming up stays until its day", messages: [me("got J. Cole tickets!! oslo spektrum 21 nov", 0), sun("Nice! That'll be a great night.", 0)], has: [["Lately", /J\.?\s?Cole/i]], labels: [[/J\.?\s?Cole/i, (l) => l.kind !== "current" || (l.until ?? "") >= "2026-11-21", "kept until the concert"]] },
  { key: "kanye", why: "a setting that also says something about them", messages: [me("text me if kanye ever announces a show in norway", 0), ...sunAfter("watch_profile_update", "Will do, I'll keep an eye out.", 0)], has: [[null, /Kanye/]], not: [[null, /text (me|him|you)|keep an eye|watch/i]] },
  { key: "fundplan", why: "a lasting fact and a plan are separate notes", messages: [me("i have about 1.5M in an ASK fund, thinking about selling some to buy an apartment", 0), sun("Worth weighing the tax and the loan side.", 0)], has: [["About", /1[.,]5|ASK|aksjespare/i], ["Lately", /apartment/i]] },
  // Due notes: past their day, decided by the model before they go (the fund must not go with its plan).
  { key: "duefund", why: "a due plan that holds a lasting fact", before: [lasting("Lives in Oslo."), { text: "Has about 1.5M NOK in an aksjesparekonto and is thinking about what to do with it", kind: "current", source: "said", date: "2026-09-30" }], messages: [me("whats 12 times 14", 0), sun("168.", 0)], has: [["About", /1[.,]5|aksjespare|ASK/i]] },
  { key: "dueplan", why: "a due plan nobody mentioned again", before: [lasting("Lives in Oslo."), { text: "Thinking about a trip to the Maldives", kind: "current", source: "said", date: "2026-09-25" }], messages: [me("whats 12 times 14", 0), sun("168.", 0)], has: [["About", /Oslo/]], not: [["Lately", /Maldives/]] },
  { key: "dueevent", why: "an event that has happened, with a lasting part", before: [{ text: "Has tickets to J. Cole at Oslo Spektrum on 14 Oct; huge fan", kind: "current", source: "said", date: "2026-10-01", until: "2026-10-14" }], messages: [me("whats 12 times 14", 0), sun("168.", 0)], has: [[null, /J\.?\s?Cole/i]], not: [["Lately", /tickets/i]] },
  { key: "nothing", why: "nothing new: every note stays", before: [lasting("Lives in Oslo."), { text: "Sanna: girlfriend, studies medicine", kind: "person", source: "said" }, { text: "Likes short answers.", kind: "preference", source: "said" }, { text: "Weighing an apartment in Oslo against keeping the fund", kind: "current", source: "said", date: "2026-10-15" }], messages: [me("what's 15% of 2340?", 0), sun("351.", 0)], has: [["About", /Oslo/], ["People", /Sanna/], ["Preferences", /short/], ["Lately", /apartment/]] },
].filter((c) => !pick || pick.split(",").includes(c.key));

// Checks for the live copies: facts that must stay, slips that must not appear.
const LIVE = {
  today: { keep: { Oslo: /Oslo/, fund: /1[.,]5\s?M|1\.5 million|aksjesparekonto|ASK/i, "J. Cole": /J\.?\s?Cole/i, XRP: /XRP/, blue: /blue/i, iskaffe: /iskaffe|iced coffee/i, "short answers": /short answers/i, Kanye: /Kanye/i } },
  old: { keep: { Oslo: /Oslo/, blue: /blue/i, iskaffe: /iskaffe|iced coffee/i } },
};
const LIVE_NOT = [[null, /packing list|\bPDF\b/i], [null, /(Gmail|Calendar)[^\n]{0,40}connected|connected[^\n]{0,40}(Gmail|Calendar)/i], [null, /water reminder/i], [null, /Helsenorge|prescription/i], [null, /payment failing|deployment crash/i], [null, /checks the news|news every/i], [null, /[\w.+-]+@[\w-]+\.[a-z]{2,}|\+\d[\d\s]{6,}\d/i], ["About", /Maldives|thinking about|weighing|next step/i]];

function sections(md) {
  const out = {};
  let cur = null;
  for (const line of md.split("\n")) {
    const h = /^##\s+(\w+)/.exec(line);
    if (h) { cur = h[1]; out[cur] = ""; continue; }
    if (cur) out[cur] += `${line}\n`;
  }
  return out;
}
function check(md, has = [], not = []) {
  const s = sections(md);
  const fails = [];
  for (const [sec, re] of has) if (!re.test(sec ? (s[sec] ?? "") : md)) fails.push(`missing ${re} ${sec ? `in ${sec}` : ""}`.trim());
  for (const [sec, re] of not) if (re.test(sec ? (s[sec] ?? "") : md)) fails.push(`has ${re} ${sec ? `in ${sec}` : ""}`.trim());
  return fails;
}

async function runPass({ memoryMd, labels, route, session, owner = "Torstein", agent = "Sunshine", tz = "Europe/Oslo", now = NOW }) {
  const dir = mkdtempSync(join(tmpdir(), "memory-notes-"));
  try {
    const state = new StateDir(dir);
    state.ensure();
    state.writeJson("owner-route.json", route);
    if (typeof session === "string") state.writeText(`sessions/${encodeURIComponent(route.conversationKey)}.jsonl`, session);
    else writeSession(join(state.path("sessions"), `${encodeURIComponent(route.conversationKey)}.jsonl`), session);
    const memory = new MemoryStore(state);
    if (memoryMd) memory.replaceDurable(memoryMd);
    if (labels) saveLabels(state, labels);
    const config = defaultConfig();
    config.owner = { ...config.owner, name: owner, timezone: tz };
    config.agent = { ...config.agent, name: agent };
    // DRY=1: a stand-in that changes nothing and prints what the model would read (free).
    const base = process.env.DRY
      ? async (req) => { if (!dryShown++) console.log(`--- what the model reads\n${req.user}\n---`); return { text: '<changes>{"changes": []}</changes>', costUsd: 0, model: "dry" }; }
      : modelCall(resolveWatcherModel("anthropic/claude-sonnet-5-5"), { apiKey, reasoning: MEMORY_REASONING });
    let cost = 0;
    const call = async (req) => { const r = await base(req); cost += r.costUsd; return r; };
    const audit = new AuditLog(state);
    const outcome = await createMemoryPass({ state, memory, config, scheduler: new Scheduler(state), audit, call, now: () => now }).run();
    const changes = audit.read({ kinds: ["policy"] }).find((e) => e.detail.memoryChanges)?.detail.memoryChanges ?? [];
    return { outcome, cost, md: memory.readDurable(), changes, labels: state.readJson("memory/labels.json", {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let dryShown = 0;
let total = 0;
const rows = [];
const route ={ conversationKey: "imessage:c1", channel: "imessage" };
for (const c of CASES) {
  if (total > MAX_USD) { console.log(`Stopped: spent $${total.toFixed(3)}, over MAX_USD ${MAX_USD}.`); break; }
  const memoryMd = c.beforeMd ?? (c.before ? renderNotes(c.before, "Torstein") : "");
  const r = await runPass({ memoryMd, labels: c.before, route, session: c.messages });
  total += r.cost;
  const fails = check(r.md, c.has, c.not);
  // Checks on a note's labels: [which note (by text), test, what it means].
  for (const [re, ok, what] of c.labels ?? []) {
    const hit = Object.entries(r.labels).find(([text]) => re.test(text));
    if (!hit || !ok(hit[1])) fails.push(`not ${what}: ${hit ? JSON.stringify(hit[1]) : "no such note"}`);
  }
  rows.push({ key: c.key, ok: fails.length === 0 });
  console.log(`\n[${c.key}] ${c.why}: ${fails.length ? `FAIL (${fails.join("; ")})` : "ok"}  ${r.outcome}, $${r.cost.toFixed(4)}`);
  console.log(r.md.split("\n").filter(Boolean).map((l) => `   | ${l}`).join("\n"));
  for (const ch of r.changes) console.log(`   ~ ${ch}`);
}
for (const { name, copy } of copies) {
  for (let i = 1; i <= RUNS; i++) {
    if (total > MAX_USD) { console.log(`Stopped: spent $${total.toFixed(3)}, over MAX_USD ${MAX_USD}.`); break; }
    const r = await runPass({ memoryMd: copy.memory, route: copy.route, session: copy.session, owner: copy.owner, agent: copy.agent, tz: copy.timezone || "Europe/Oslo", now: new Date() });
    total += r.cost;
    const keep = Object.entries(LIVE[name]?.keep ?? {}).map(([k, re]) => [null, re, k]);
    const fails = [...keep.filter(([, re]) => !re.test(r.md)).map(([, , k]) => `lost ${k}`), ...check(r.md, [], LIVE_NOT)];
    // Something coming up filed as current must carry its day, or it would go before it happens.
    for (const [text, l] of Object.entries(r.labels)) if (/J\.?\s?Cole/i.test(text) && l.kind === "current" && !l.until) fails.push("J. Cole current without an until");
    // A lasting fact (the fund) filed as current would age out.
    for (const [text, l] of Object.entries(r.labels)) if (/aksjesparekonto|1[.,]5\s?M/i.test(text) && l.kind === "current") fails.push("the fund filed as current");
    rows.push({ key: `${name} ${i}`, ok: fails.length === 0 });
    console.log(`\n[live ${name} ${i}] ${fails.length ? `FAIL (${fails.join("; ")})` : "ok"}  ${r.outcome}, $${r.cost.toFixed(4)}`);
    console.log(r.md.split("\n").filter(Boolean).map((l) => `   | ${l}`).join("\n"));
    for (const ch of r.changes) console.log(`   ~ ${ch}`);
  }
}
console.log(`\n===== ${rows.filter((r) => r.ok).length}/${rows.length} ok: ${rows.map((r) => `${r.key} ${r.ok ? "ok" : "FAIL"}`).join(", ")}\nCost: $${total.toFixed(4)}`);
process.exit(0);
