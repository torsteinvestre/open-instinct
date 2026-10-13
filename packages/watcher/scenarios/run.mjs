// [sunshine:watcher] Runs the decision scenarios against real models and reports how often each
// model's outcome is one a thoughtful friend would accept. Costs real money (well under $1).
// Usage (from packages/watcher, after `pnpm build`, with ANTHROPIC_API_KEY set):
//   node scenarios/run.mjs [rounds=2] [models=sonnet,haiku]
import { writeFileSync } from "node:fs";
import { DECIDE_SYSTEM, SCREEN_SYSTEM, checkDecision, decideUser, modelCall, parseDecision, parseScreen, resolveWatcherModel, screenUser } from "../dist/index.js";
import { SCENARIOS } from "./scenarios.mjs";

const rounds = Number(process.argv[2] ?? 2);
const which = (process.argv[3] ?? "sonnet,haiku").split(",");
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const MODELS = {
  sonnet: modelCall(resolveWatcherModel("anthropic/claude-sonnet-5-5"), { apiKey, reasoning: "medium" }),
  haiku: modelCall(resolveWatcherModel("anthropic/claude-haiku-5-5"), { apiKey, reasoning: "low" }),
};
const now = "Tuesday 13 October 2026 at 14:00 (Europe/Oslo)";

function outcomes(decision, count) {
  const out = Array(count).fill("nothing");
  for (const k of decision.keep) if (k.headline >= 1 && k.headline <= count) out[k.headline - 1] = "keep";
  for (const s of decision.message?.stories ?? []) if (s.headline >= 1 && s.headline <= count) out[s.headline - 1] = s.card === "new" ? "tell:new" : `tell:update:${s.card}`;
  return out;
}

const results = [];
let cost = 0;
for (const name of which) {
  const call = MODELS[name];
  let ok = 0, total = 0, refused = 0;
  for (let r = 0; r < rounds; r++) {
    for (const sc of SCENARIOS) {
      const headlines = sc.headlines.map((h, i) => ({ n: i + 1, topic: "interest", title: h.title, source: h.source, age: h.age }));
      const cards = sc.cards.map((c) => ({ id: c.id, subject: c.subject, event: c.event, status: c.status, told: `${c.daysAgo} days ago`, updates: 0 }));
      const reply = await call({ system: DECIDE_SYSTEM, user: decideUser({ now, profile: sc.profile, cards, notes: [], headlines }) });
      cost += reply.costUsd;
      let decision;
      try { decision = parseDecision(reply.text); } catch (e) { results.push({ model: name, round: r, scenario: sc.name, error: String(e) }); total += sc.headlines.length; continue; }
      const problems = checkDecision(decision, new Map(sc.headlines.map((h, i) => [i + 1, { title: h.title, link: `https://new/${i}` }])), sc.cards.map((c) => ({ ...c, firstTold: "", lastTold: "" })));
      if (problems.length) refused++;
      const got = outcomes(decision, sc.headlines.length);
      sc.headlines.forEach((h, i) => {
        total++;
        const pass = h.accept.includes(got[i]);
        if (pass) ok++;
        results.push({ model: name, round: r, scenario: sc.name, headline: h.title, got: got[i], accept: h.accept, pass });
      });
      if (decision.message) results.push({ model: name, round: r, scenario: sc.name, text: decision.message.text, note: decision.note, problems });
    }
  }
  console.log(`${name}: ${ok}/${total} headline outcomes acceptable${refused ? `, ${refused} decisions the door would refuse` : ""}`);
}

// Screen step: does Haiku pass on every headline that should be told?
let missed = 0, mustTell = 0;
for (const sc of SCENARIOS) {
  const headlines = sc.headlines.map((h, i) => ({ n: i + 1, topic: "interest", title: h.title, source: h.source, age: h.age }));
  const reply = await MODELS.haiku({ system: SCREEN_SYSTEM, user: screenUser({ profile: sc.profile, headlines }) });
  cost += reply.costUsd;
  const pass = new Set(parseScreen(reply.text, headlines.length).pass);
  sc.headlines.forEach((h, i) => {
    if (h.accept.every((a) => a.startsWith("tell"))) {
      mustTell++;
      if (!pass.has(i + 1)) { missed++; results.push({ model: "haiku-screen", scenario: sc.name, headline: h.title, dropped: true }); }
    }
  });
}
console.log(`haiku screen: dropped ${missed} of ${mustTell} must-tell headlines`);
console.log(`cost: $${cost.toFixed(4)}`);
for (const r of results) if (r.pass === false || r.dropped || r.error) console.log("MISS", JSON.stringify(r));
for (const r of results) if (r.text) console.log(`TEXT [${r.model} r${r.round}] ${r.scenario}: ${r.text}${r.problems?.length ? `  PROBLEMS: ${r.problems.join(" | ")}` : ""}`);
writeFileSync(process.env.SCENARIO_OUT ?? "/tmp/watcher-scenarios.json", JSON.stringify(results, null, 2));
