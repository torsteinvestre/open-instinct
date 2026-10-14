// [sunshine:watcher] Does the news-watch playbook make the conversation model write clean search
// topics (only what the news is about, no importance words)? Gives Sonnet 5.5 a short stand-in for
// Sunshine's prompt, the playbook, the watch_profile_update tool, the owner's current searches and
// the owner's request, and records the searches it saves. Runs the old and the new playbook side
// by side. Costs a few cents. Usage (from packages/watcher, after `pnpm build`, keys set):
//   node scenarios/playbook-test.mjs <old SKILL.md> <new SKILL.md> [rounds=3]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { AuditLog, Scheduler, StateDir, defaultConfig } from "@open-instinct/core";
import { createWatcher, resolveWatcherModel } from "../dist/index.js";

const [oldSkill, newSkill] = [readFileSync(process.argv[2], "utf8"), readFileSync(process.argv[3], "utf8")];
const rounds = Number(process.argv[4] ?? 3);
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

// The tool exactly as Sunshine has it now; the old description is the one before the topic rule.
const dir = mkdtempSync(join(tmpdir(), "playbook-test-"));
const state = new StateDir(dir);
state.ensure();
const tool = createWatcher({ state, config: defaultConfig(), outbox: { send: async () => {} }, audit: new AuditLog(state), scheduler: new Scheduler(state) }).tools.find((t) => t.spec.name === "watch_profile_update").spec;
rmSync(dir, { recursive: true, force: true });
const OLD_DESCRIPTION =
  'Rewrite your picture of the owner\'s interests and/or the searches. `profile` replaces the whole note (plain words, at most 2000 characters): what they follow and how closely, where they live, how they like to hear things, and their reactions to past news texts as short examples; mark weak signals as weak. `searches` replaces the whole list, one per interest: `topic` says what it is, unambiguously ("Brann, the Bergen football club (SK Brann)", not "Brann"); `query` is a precise Google News search ("SK Brann"); `edition` is en-US, en-GB, no-NO, sv-SE or another language-COUNTRY pair.';

const PROFILE = "Torstein lives in Oslo, texts in English, likes short messages. Follows XRP (Ripple's cryptocurrency) closely: wants almost everything notable, including price moves, Ripple/SEC legal news, ETFs and adoption. Most interested in Norwegian/Oslo startups (funding rounds, launches, exits, ecosystem news): wants most of it. Global startup news is secondary. Kinda interested in AI (casual: only the biggest moments).";
const SEARCHES = [
  ["XRP, the Ripple cryptocurrency", "XRP Ripple", "en-US"],
  ["XRP price and market moves", "XRP price", "en-US"],
  ["Norwegian startups (Norway, Oslo): funding, launches, exits", "norsk startup", "no-NO"],
  ["Norwegian startups in English", "Norway startup funding", "en-US"],
  ["Global startups, secondary: major funding and launches", "startup funding", "en-US"],
  ["Artificial intelligence, major news only", "artificial intelligence", "en-US"],
];
const current = `News watch: on. What you know about their interests:\n${PROFILE}\n\nSearches:\n${SEARCHES.map(([t, q, e]) => `- ${t}: "${q}" (${e})`).join("\n")}`;
const IMPORTANCE = /\b(major|secondary|only|closely|notable|casual|main|minor|biggest|important|big|key)\b/i;

const sonnet = resolveWatcherModel("anthropic/claude-sonnet-5-5");
let cost = 0;
for (const [label, skill, description] of [["OLD playbook", oldSkill, OLD_DESCRIPTION], ["NEW playbook", newSkill, tool.description]]) {
  let clean = 0, total = 0;
  console.log(`\n=== ${label}`);
  for (let r = 0; r < rounds; r++) {
    const reply = await completeSimple(
      sonnet,
      {
        systemPrompt: `You are Sunshine, a personal assistant the owner texts on iMessage. Keep replies short. Use your tools to act.\n\n# Skill: news-watch (loaded)\n${skill}\n\n# Current news watch (from watch_profile)\n${current}`,
        messages: [{ role: "user", content: "Can you tidy up the news searches you made for me", timestamp: Date.now() }],
        tools: [{ name: tool.name, description, parameters: tool.parameters }],
      },
      { apiKey, reasoning: "medium" },
    );
    cost += reply.usage?.cost?.total ?? 0;
    const call = reply.content.find((c) => c.type === "toolCall" && c.name === "watch_profile_update");
    if (!call) {
      console.log(`  round ${r + 1}: no tool call. Said: ${reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").slice(0, 200)}`);
      continue;
    }
    const searches = call.arguments.searches ?? [];
    console.log(`  round ${r + 1}:`);
    for (const s of searches) {
      total++;
      const bad = IMPORTANCE.test(s.topic);
      if (!bad) clean++;
      console.log(`    ${bad ? "IMPORTANCE WORD" : "clean          "}  ${s.topic}  |  "${s.query}" (${s.edition ?? "en-US"})`);
    }
    if (call.arguments.profile !== undefined) console.log(`    profile kept the levels: ${/closely|secondary|casual|biggest/.test(call.arguments.profile) ? "yes" : "NO"}`);
  }
  console.log(`  ${label}: ${clean}/${total} topics clean`);
}
console.log(`\ncost: $${cost.toFixed(4)}`);
