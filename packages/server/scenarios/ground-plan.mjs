// [sunshine:grounding] Paid (about 2 cents). The grounding step's small model alone, on Torstein's own past texts: does
// it gather nothing for everyday texts, the right days and email searches for texts about his life, can every answer be
// read now that it comes in a fixed form ([sunshine:fixed-form]), and how long does it take?
//
// Real conditions kept: his real texts, each with the time it was sent ("now" for the step) and the 8 texts before it
// from his archived thread; his memory notes; recall on the message from the stored copy of his chats and kept items
// (look-before-ask.mjs's <SNAPSHOT>-cut, chats from the day before each text and older only, as live); Claude Haiku 5.5
// at "low", through the same modelCall as the live agent. Differences: the notes and kept items are today's for every
// text (recordings of 27 Oct are visible to a text of 15 Oct); the earlier texts lack the time stamp the live thread
// puts on each; voice notes are left out (they go through the recording's summary instead). Nothing is looked up in
// email or the calendar: this checks what the step asks for, not what it finds.
//
// Pass, per text, from the answers written below before run 1 (five texts moved to "either" after it, the reason
// given there; the 3 Nov search check made strict, as run 1's searches could not find the email): everyday texts
// gather nothing; texts about his own
// life ask for something, with the days and the email searches named where the text calls for them; texts that could
// fairly go either way are reported, not graded.
//
// Usage (from packages/server, after `pnpm build`; ANTHROPIC_API_KEY set):
//   SNAPSHOT=~/sunshine-memory/repro-2026-10-29/data MAX_USD=0.05 node scenarios/ground-plan.mjs
//   DRY=1   checks the check on known answers; no model call
//   ONLY="Anything happening" ROUNDS=10   only the texts starting so, each ROUNDS times (how often, not once)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---- the check -----------------------------------------------------------------------------------------------------
// need: true (something to gather), false (nothing), null (either is fair; reported only). days: each must be covered by
// the answer's days ("a/b" spans count). search: the answer's searches must match it.
// Moved to "either" after run 1, from the texts around them (not read when the answers were first written): the
// favourite colour and the APLD interest are in his notes, which the agent always has; "Try now" and the 25 Oct "Yeah"
// answer Sunshine's offer to fetch APLD news, so gathering it is fair.
const EXPECT = new Map([
  ["Yeah", { need: null }],
  ["Satte spørsmålstegn ved", { need: false }],
  ["Anyway. Whats my favorite color?", { need: null }],
  ["You are amazing", { need: false }],
  ["Satte et hjerte ved", { need: false }],
  ["Book a meeting today at 11", { need: true, days: ["2026-10-16"] }],
  ["Could you reschedule it for 12", { need: true, days: ["2026-10-16"] }],
  ["Try now", { need: null }],
  ["What do you mean «xrp isnt a security»", { need: false }],
  ["Anything from brave in my inbox?", { need: true, search: /brave/i }],
  ["Should i eat mango before bed", { need: false }],
  ["Whats my fav color", { need: null }],
  ["Why is there a riot in france", { need: false }],
  ["?", { need: false }],
  ["Why is this so common in france", { need: false }],
  ["Yo", { need: false }],
  ["Have i told you im interested in the APLD stock", { need: null }],
  ["When was that concert again?", { need: true, search: /concert|ticket|cole|billett/i }],
  ["What do you know about my financials", { need: true }],
  ["What day is the concert", { need: true }],
  ["Does ripple want banks to use xrp or RLUSD", { need: false }],
  // The texts before it say "An event on 3 Nov ... I don't have the details": a search must be able to find that email.
  ["Anything happening next week for me", { need: true, days: ["2026-11-02/2026-11-08"], search: /founders|guestlist|"?\b3\.? nov|nov(ember)? 3\b/i }],
]);
// Short answers ("Yeah", "Yo") match only themselves; longer ones by how the text starts.
const keyFor = (text) => [...EXPECT.keys()].find((start) => text === start || (start.length >= 15 && text.startsWith(start)));
const expectFor = (text) => EXPECT.get(keyFor(text)) ?? { need: null };

const span = (d) => { const [a, b] = d.split("/"); return [a, b ?? a]; };
const covers = (days, d) => days.some((x) => { const [a, b] = span(x); return a <= d && d <= b; });
function check(text, ask) {
  const want = expectFor(text);
  if (!ask) return { graded: true, pass: false, why: "unreadable" };
  if (want.need === null) return { graded: false, pass: null, why: ask.needed ? "gathered (either is fair)" : "nothing (either is fair)" };
  if (!want.need) return { graded: true, pass: !ask.needed, why: ask.needed ? "gathered for an everyday text" : "nothing gathered" };
  const misses = [];
  if (!ask.needed) misses.push("gathered nothing");
  for (const d of want.days ?? []) { const [a, b] = span(d); if (!covers(ask.days, a) || !covers(ask.days, b)) misses.push(`days miss ${d}`); }
  if (want.search && !want.search.test(ask.searches.join(" "))) misses.push(`no search like ${want.search}`);
  return { graded: true, pass: misses.length === 0, why: misses.join("; ") || "as expected" };
}

// ---- his texts -----------------------------------------------------------------------------------------------------
const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const SNAPSHOT = resolve(need("SNAPSHOT").replace(/^~/, homedir()));
const CUT = `${SNAPSHOT}-cut`; // its chats stop before the 29 Oct text; the texts come from the whole copy
const thread = readFileSync(join(SNAPSHOT, "history", "owner.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ownerTexts = thread.map((e, i) => ({ ...e, i })).filter((e) => e.who === "owner" && !/^\[attachment\]/.test(e.text));

if (process.env.DRY) {
  // Every answer written above belongs to a real text, and which texts are graded how.
  const used = new Set(ownerTexts.map((e) => keyFor(e.text)).filter(Boolean));
  for (const start of EXPECT.keys()) if (!used.has(start)) console.log(`WRONG no text matches the answer for "${start}"`);
  for (const e of ownerTexts) { const w = expectFor(e.text); console.log(`  ${w.need === null ? "either" : w.need ? "gather" : "nothing"}  "${e.text.replace(/\s+/g, " ").slice(0, 70)}"`); }
  console.log(`${ownerTexts.length} texts: ${ownerTexts.filter((e) => expectFor(e.text).need === false).length} nothing, ${ownerTexts.filter((e) => expectFor(e.text).need === true).length} gather, ${ownerTexts.filter((e) => expectFor(e.text).need === null).length} either\n`);
  const known = [
    ["Yo", { needed: false, about: [], days: [], searches: [] }, true],
    ["Yo", { needed: true, about: ["a greeting"], days: [], searches: [] }, false],
    ["Anything happening next week for me", { needed: true, about: ["plans next week"], days: ["2026-11-02/2026-11-08"], searches: ["guestlist OR tickets"] }, true],
    ["Anything happening next week for me", { needed: true, about: ["plans next week"], days: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"], searches: ["\"3 Nov\""] }, true],
    ["Anything happening next week for me", { needed: true, about: ["the 3 Nov event"], days: ["2026-11-02/2026-11-08"], searches: ["\"3 November\" OR \"Nov 3\" OR \"3. november\""] }, true],
    ["Anything happening next week for me", { needed: true, about: ["plans next week"], days: ["2026-11-02"], searches: ["guestlist"] }, false],
    ["Anything happening next week for me", { needed: true, about: ["plans next week"], days: ["2026-11-02/2026-11-08"], searches: [] }, false],
    // Run 1's searches: they could not find the 3 Nov email.
    ["Anything happening next week for me", { needed: true, about: ["J. Cole concert"], days: ["2026-11-02/2026-11-08"], searches: ["\"J. Cole\" OR \"Fall-Off Tour\" OR \"Unity Arena\"", "\"invitation\" OR \"calendar invite\" OR \"meeting\" OR \"booking\" OR \"ticket\""] }, false],
    ["Anything from brave in my inbox?", { needed: true, about: ["email from Brave"], days: [], searches: ["from:brave"] }, true],
    ["Anything from brave in my inbox?", { needed: true, about: ["email"], days: [], searches: ["newer_than:7d"] }, false],
    ["Book a meeting today at 11 with the following people", { needed: true, about: ["meeting"], days: ["2026-10-16"], searches: [] }, true],
    ["Book a meeting today at 11 with the following people", { needed: true, about: ["meeting"], days: ["2026-10-17"], searches: [] }, false],
    ["Whats my fav color", undefined, false],
  ];
  let ok = 0;
  for (const [text, ask, want] of known) {
    const got = check(text, ask);
    ok += got.pass === want;
    console.log(`${got.pass === want ? "ok   " : "WRONG"} ${got.pass ? "pass" : "fail"} (${got.why}) <- "${text.slice(0, 40)}" ${JSON.stringify(ask?.days ?? null)} ${JSON.stringify(ask?.searches ?? null)}`);
  }
  console.log(`\n${ok}/${known.length} known answers graded right`);
  process.exit(ok === known.length && used.size === EXPECT.size ? 0 : 1);
}

// ---- the runs ------------------------------------------------------------------------------------------------------
const apiKey = need("ANTHROPIC_API_KEY");
const MAX_USD = Number(process.env.MAX_USD ?? 0.05);

const { AuditLog, HistoryArchive, ItemArchive, MeaningSearch, MemoryStore, StateDir, defaultConfig } = await import("@open-instinct/core");
const { modelCall, resolveWatcherModel } = await import("@open-instinct/watcher");
const { DEFAULT_GROUND_MODEL, createGround, parseGround } = await import("../dist/ground.js");
const { createRecall } = await import("../dist/recall.js");
const { createLocalEmbedder } = await import("../dist/embedder.js");

const state = new StateDir(CUT);
const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
const audit = new AuditLog(new StateDir(mkdtempSync(join(tmpdir(), "ground-plan-")))); // nothing written into the copy
const embedder = createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: 8, log: () => {} });
const meaning = new MeaningSearch({ state, embedder, config, history: new HistoryArchive(state), items: new ItemArchive(state), audit });
console.log(`meaning search: ${meaning.status().stored} of ${meaning.status().pieces} pieces stored`);
const recallInner = createRecall({ meaning, config, audit, waitMs: 8_000 });
let recallMs = 0;
const recall = async (q, o) => { const t = Date.now(); try { return await recallInner(q, o); } finally { recallMs += Date.now() - t; } };

const model = resolveWatcherModel(DEFAULT_GROUND_MODEL);
const inner = modelCall(model, { reasoning: "low", apiKey });
let last = { text: "", ms: 0, costUsd: 0 };
const call = async (req) => { const t = Date.now(); const r = await inner(req); last = { text: r.text, ms: Date.now() - t, costUsd: r.costUsd }; return r; };

const notes = new MemoryStore(state);

const ONLY = process.env.ONLY?.trim();
const ROUNDS = Number(process.env.ROUNDS ?? 1);
const runs = ownerTexts.filter((e) => !ONLY || e.text.startsWith(ONLY)).flatMap((e) => Array.from({ length: ROUNDS }, () => e));
const results = [];
let spent = 0;
for (const e of runs) {
  if (spent + last.costUsd > MAX_USD) { console.log(`stopped: $${spent.toFixed(4)} spent, the next would pass MAX_USD ${MAX_USD}`); break; }
  // As the live runtime picks them: the latest 8 texts, Sunshine's own notes left out, each clipped to 500 characters.
  const recent = thread.slice(0, e.i).filter((r) => r.who === "owner" || r.who === "agent").slice(-8).map((r) => ({ who: r.who, text: r.text.slice(0, 500) }));
  recallMs = 0;
  last = { text: "", ms: 0, costUsd: 0 };
  const ground = createGround({ call, config, memory: notes, audit, recall, now: () => new Date(e.ts) });
  await ground({ text: e.text, recent, conversationKey: e.key });
  const ask = parseGround(last.text);
  const got = check(e.text, ask);
  spent += last.costUsd;
  const r = { at: new Date(e.ts).toISOString(), text: e.text, ask: ask ?? null, raw: ask ? undefined : last.text.slice(0, 300), ...got, modelMs: last.ms, recallMs, costUsd: last.costUsd };
  results.push(r);
  const mark = r.pass === null ? "  -  " : r.pass ? "PASS " : "FAIL ";
  console.log(`${mark}"${e.text.replace(/\s+/g, " ").slice(0, 60)}" -> ${ask ? (ask.needed ? `about ${JSON.stringify(ask.about)} days ${JSON.stringify(ask.days)} searches ${JSON.stringify(ask.searches)}` : "nothing") : `UNREADABLE "${last.text.slice(0, 80)}"`} | ${r.why} | model ${(r.modelMs / 1000).toFixed(1)} s, recall ${(r.recallMs / 1000).toFixed(1)} s, $${r.costUsd.toFixed(4)}`);
}

const graded = results.filter((r) => r.graded);
const ms = results.map((r) => r.modelMs).sort((a, b) => a - b);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const everyday = results.filter((r) => expectFor(r.text).need === false);
console.log(`\n${graded.filter((r) => r.pass).length}/${graded.length} graded passed; ${results.filter((r) => !r.ask).length}/${results.length} unreadable; everyday texts with nothing gathered ${everyday.filter((r) => r.pass).length}/${everyday.length}`);
console.log(`model time: median ${(q(0.5) / 1000).toFixed(1)} s, 90th ${(q(0.9) / 1000).toFixed(1)} s, max ${(ms.at(-1) / 1000).toFixed(1)} s; spent $${spent.toFixed(4)}`);
const out = join(homedir(), "sunshine-memory", `ground-plan-${new Date().toISOString().slice(0, 10)}${ONLY ? `-only-${ROUNDS}x` : ""}.json`);
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`saved ${out}`);
await embedder.close?.();
process.exit(0);
