// [sunshine:meaning-search] Free: the 25-question test (sunshine-ops NOTES "Memory trial") run through Sunshine's own
// search code. The owner's Claude Code work sessions are kept as items (source "claude-code", one line per turn), stored
// with the real 4-bit search model, then each question is asked as written and as keywords: through history_search
// with meaning search (as it runs live), through history_search without it (word search, as before), and ranked by
// meaning and words merged, by meaning only and by words only. Every result's text goes to OUT, graded by
// ~/sunshine-memory/grade_scenario.py with the same grader as the earlier tests. No model calls, nothing sent; the
// owner's history stays on this machine (STATE keeps the stored vectors between runs).
//
// Usage (from packages/server, after `pnpm build`):
//   SESSIONS=~/sunshine-memory/data/history/sessions.json QUESTIONS=~/sunshine-memory/keys/history-questions.json \
//   STATE=<folder> OUT=<results.json> [MODELS=<model folder>] [THREADS=8] node scenarios/meaning-search.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, AuditLog, ItemArchive, MeaningSearch, MemoryStore, Scheduler, StateDir, ToolRegistry, coreTools, defaultConfig } from "@open-instinct/core";
import { createLocalEmbedder } from "../dist/embedder.js";

const need = (name) => process.env[name]?.trim() || (() => { throw new Error(`${name} must be set`); })();
const sessions = JSON.parse(readFileSync(need("SESSIONS"), "utf8"));
const questions = JSON.parse(readFileSync(need("QUESTIONS"), "utf8")).questions;
const OUT = need("OUT");
const RESULT_CHARS = 8000; // what the earlier tests graded

const state = new StateDir(need("STATE"));
state.ensure();
const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
config.agent = { ...config.agent, name: "Sunshine" };

const items = new ItemArchive(state);
if (items.all().length === 0) {
  for (const s of sessions) {
    const text = s.turns.map((t) => `[${t.at.slice(0, 16).replace("T", " ")}] ${t.role}: ${t.text.replace(/\s+/g, " ")}`).join("\n");
    const kept = items.add({ id: s.id, source: "claude-code", startedAt: Date.parse(s.start), endedAt: Date.parse(s.end), people: ["Claude"], text });
    if (kept.text.length < text.length) console.log(`  ${s.id}: kept ${kept.text.length} of ${text.length} characters`);
  }
}
const embedder = createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: Number(process.env.THREADS ?? 8), log: (m) => console.log(`  ${m}`) });
const audit = new AuditLog(state);
const meaning = new MeaningSearch({ state, embedder, config, items, audit });

let s = meaning.status();
console.log(`${items.all().length} sessions as items; ${s.pieces} pieces, ${s.stored} stored`);
if (s.stored < s.pieces) {
  const t0 = Date.now();
  const tick = setInterval(() => {
    const now = meaning.status();
    console.log(`  stored ${now.stored} of ${now.pieces} (${((Date.now() - t0) / 1000 / Math.max(1, now.stored - s.stored)).toFixed(2)} s per piece)`);
  }, 60_000);
  await meaning.sync();
  clearInterval(tick);
  s = meaning.status();
  console.log(`stored ${s.stored} of ${s.pieces} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

const toolsWith = (extra) => {
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit, config, outbox: { send: async () => {} }, items, ...extra }));
  return registry.get("history_search");
};
const withMeaning = toolsWith({ meaning });
const wordsOnly = toolsWith({});
const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein" }, conversationKey: "imessage:test", channel: "imessage", ownerTurn: true, now: () => new Date() };
const textOf = (r) => (typeof r === "string" ? r : r.content.map((c) => c.text ?? "").join(""));
const joined = (pieces) => {
  const out = [];
  let size = 0;
  for (const p of pieces) {
    if (size >= RESULT_CHARS) break;
    const t = p.lines.join("\n");
    out.push(t);
    size += t.length + 1;
  }
  return out.join("\n");
};

const results = {};
const times = [];
for (const q of questions) {
  results[q.id] = {};
  for (const kind of ["q", "kw"]) {
    const query = kind === "q" ? q.q : q.keywords;
    const r = {};
    const t0 = Date.now();
    r.tool = textOf(await withMeaning.spec.execute({ query }, ctx));
    times.push(Date.now() - t0);
    r.tool_words = textOf(await wordsOnly.spec.execute({ query }, ctx));
    for (const mode of ["meaning", "both", "words"]) r[mode] = joined(await meaning.search(query, {}, mode));
    results[q.id][kind] = r;
  }
}
times.sort((a, b) => a - b);
console.log(`history_search with meaning: median ${times[times.length >> 1]} ms, slowest ${times.at(-1)} ms`);
writeFileSync(OUT, JSON.stringify(results));
console.log(`results written to ${OUT}`);
await embedder.close();
