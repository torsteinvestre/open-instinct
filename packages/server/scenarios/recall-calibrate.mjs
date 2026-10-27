// [sunshine:in-the-flow] Free: where the "related enough" line (RECALL_MIN_NEAR in src/recall.ts) belongs. The memory
// trial's archive (the owner's 20 Claude Code work sessions as items, already stored by scenarios/meaning-search.mjs)
// is searched with two kinds of queries: the trial's 25 real questions, whose answers are in it (related), and everyday
// things an owner says that it holds nothing about (unrelated). For each query, how close the best piece's meaning is;
// then, for each line, how many related queries keep a match and how many unrelated ones get one anyway. No model
// calls beyond the local search model, nothing sent; the owner's history stays on this machine.
//
// Usage (from packages/server, after `pnpm build`):
//   STATE=~/sunshine-memory/scenario-state QUESTIONS=~/sunshine-memory/keys/history-questions.json node scenarios/recall-calibrate.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog, ItemArchive, MeaningSearch, StateDir, defaultConfig } from "@open-instinct/core";
import { createLocalEmbedder } from "../dist/embedder.js";

const need = (name) => process.env[name]?.trim() || (() => { throw new Error(`${name} must be set`); })();
const questions = JSON.parse(readFileSync(need("QUESTIONS"), "utf8")).questions;
// Things an owner says that the work sessions hold nothing about: other parts of life, and tasks of the kind a
// recording hands over. Written before looking at any result.
const UNRELATED = [
  "Add the event on 3 Nov to my calendar",
  "the J. Cole concert in November",
  "gym schedule this week",
  "my brother's old job in Australia",
  "group project presentation about wormholes with Ian and Scott",
  "buy a birthday present for mum",
  "dentist appointment next Tuesday",
  "what should I cook for dinner tonight",
  "flights to Stockholm in December",
  "pay the electricity bill",
  "football match on Saturday",
  "the side effects of Accutane",
  "renew my passport",
  "call grandma on Sunday",
  "book a haircut",
  "exam in statistics next month",
  "car service at the garage",
  "Christmas plans with the family",
  "new running shoes",
  "the apartment rent increase",
];

const state = new StateDir(need("STATE"));
const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
const items = new ItemArchive(state);
const embedder = createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: Number(process.env.THREADS ?? 8), log: () => {} });
const meaning = new MeaningSearch({ state, embedder, config, items, audit: new AuditLog(state) });
const s = meaning.status();
if (s.stored < s.pieces) throw new Error(`only ${s.stored} of ${s.pieces} pieces stored: run scenarios/meaning-search.mjs first`);
console.log(`${items.all().length} items, ${s.pieces} pieces stored`);

const closest = async (q) => (await meaning.searchScored(q, {}, "meaning"))[0]?.near ?? 0;
const related = [];
for (const q of questions) related.push(await closest(q.question ?? q.text ?? q.q));
const unrelated = [];
for (const q of UNRELATED) unrelated.push(await closest(q));

const fmt = (xs) => xs.map((x) => x.toFixed(2)).sort().join(" ");
console.log(`\nclosest piece, related (${related.length}):   ${fmt(related)}`);
console.log(`closest piece, unrelated (${unrelated.length}): ${fmt(unrelated)}`);
console.log("\nline   related kept   unrelated matched anyway");
for (let line = 0.3; line <= 0.751; line += 0.025) {
  const kept = related.filter((x) => x >= line).length;
  const wrong = unrelated.filter((x) => x >= line).length;
  console.log(`${line.toFixed(3)}  ${String(kept).padStart(2)}/${related.length}           ${String(wrong).padStart(2)}/${unrelated.length}`);
}
await embedder.close?.();
process.exit(0);
