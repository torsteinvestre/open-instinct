// [sunshine:watcher] How do the news texts read? Runs the decide step on real headlines from the
// owner's own news (13-14 Oct 2026) with a picture like theirs, and prints every text it would
// send. DECIDE_FILE=path uses another decide prompt (to compare an earlier wording). Nothing is sent.
// Usage (from packages/watcher, after `pnpm build`, ANTHROPIC_API_KEY set):
//   [DECIDE_FILE=old.txt] node scenarios/wording.mjs [rounds=2]
import { readFileSync } from "node:fs";
import { DECIDE_SYSTEM, decideUser, modelCall, parseDecision, resolveWatcherModel } from "../dist/index.js";

const rounds = Number(process.argv[2] ?? 2);
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const system = process.env.DECIDE_FILE ? readFileSync(process.env.DECIDE_FILE, "utf8") : DECIDE_SYSTEM;
const call = modelCall(resolveWatcherModel("anthropic/claude-sonnet-5-5"), { apiKey, reasoning: "medium" });
const now = "Wednesday 14 October 2026 at 10:00 (Europe/Oslo)";
const profile = [
  "Torstein lives in Oslo, texts in English, likes short messages.",
  "Holds XRP (Ripple's cryptocurrency) and follows it closely, but wants only what matters to a holder: big price moves, legal and regulatory rulings, ETF decisions, major Ripple deals or ledger changes. No routine price commentary or minor partnerships (Oct 13: asked for fewer XRP texts).",
  "Norwegian startups: most interested; funding rounds, launches, people.",
  "Startups and venture funding worldwide: secondary, only big rounds.",
  "AI: casual, only the biggest moments.",
  "Mentioned once that his friend Jonas works at Kahoot (weak).",
].join("\n");
const h = (title, source, topic) => ({ title, source, topic, age: "2 hours ago" });
const SETS = [
  { name: "XRP: regulation + ledger bug", headlines: [
    h("COIN Stock Jumps, XRP Leads Crypto Majors After Scott Bessent Signals CLARITY Act Is On Senate's 'One-Yard Line'", "Stocktwits", "XRP"),
    h("A 10-Year-Old XRP Ledger Bug Could Mint XRP From Nothing", "Memeburn", "XRP"),
    h("XRP Price Prediction: Analysts Eye $1.50 Breakout", "CoinGape", "XRP"),
  ] },
  { name: "XRP: big-bank adoption", headlines: [
    h("Standard Chartered Makes Major Launch for RLUSD on XRP Ledger", "Bitget", "XRP"),
    h("Ripple Partners With Meritz Securities", "Crypto Times", "XRP"),
  ] },
  { name: "Norwegian startups: two stories", headlines: [
    h("Sanna henter 30 millioner til regnskapsjakten", "SHIFTER", "Norwegian startups"),
    h("Norsk YC-startup hevder å slå OpenAI i kodeagent-test", "SHIFTER", "Norwegian startups"),
    h("23-åring tar over som sjef i nordisk venturefond", "SHIFTER", "Norwegian startups"),
  ] },
  { name: "Global: one huge round", headlines: [
    h("Autonomous driving company Applied Intuition valued at $30 billion following funding offers", "KuCoin", "Startups worldwide"),
    h("Home Energy Cleantech Startup 1KOMMA5° Raises €70 Million at Unicorn Valuation", "ESG Today", "Startups worldwide"),
  ] },
  // Clearly worth a text, so there is wording to compare.
  { name: "XRP: ETF approved", headlines: [
    h("SEC approves first spot XRP ETFs; trading begins Monday", "Reuters", "XRP"),
    h("XRP jumps 12% after ETF approval", "CoinDesk", "XRP"),
  ] },
  { name: "Norway: a big moment (lives in Oslo)", headlines: [
    h("Norway qualify for the World Cup for the first time since 1998", "NRK", "Norway"),
  ] },
  { name: "A friend's company (connection not obvious)", headlines: [
    h("Kahoot! to be acquired by Microsoft for $2.1 billion", "E24", "Norwegian startups"),
  ] },
  { name: "AI: a really big moment", headlines: [
    h("OpenAI makes its newest model free for everyone, including in ChatGPT's free tier", "The Verge", "AI"),
    h("Google positions Gemini 4 Argon for long-horizon agentic work", "TechRadar", "AI"),
  ] },
];

let cost = 0;
for (const set of SETS) {
  console.log(`\n=== ${set.name}`);
  for (let r = 0; r < rounds; r++) {
    const headlines = set.headlines.map((x, i) => ({ n: i + 1, ...x }));
    const reply = await call({ system, user: decideUser({ now, profile, cards: [], notes: [], headlines }) });
    cost += reply.costUsd;
    let text = "(no text)";
    try { text = parseDecision(reply.text).message?.text ?? "(no text)"; } catch (e) { text = `(unreadable: ${e.message})`; }
    console.log(`  r${r + 1}: ${text.replace(/\n/g, " / ")}`);
  }
}
console.log(`\nCost: $${cost.toFixed(4)}`);
