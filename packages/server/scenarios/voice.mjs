// [sunshine:watcher] How does Sunshine talk about news it sent? Boots the real server (skills, the
// news tools, the delivery mirror) in a temporary folder with every outside service unset, so
// nothing is sent. A news text goes out as the watcher sends it, then the owner asks about it.
// Prints the replies and flags talk about machinery ("news watch", checks, filters, a system).
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):  node scenarios/voice.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateDir } from "@open-instinct/core";
import { WatchStore } from "@open-instinct/watcher";
import { boot } from "../dist/boot.js";

const PHONE = "+4790000000";
const THREAD = "imessage:conv_owner";
const NEWS = process.env.NEWS_TEXT ?? "Since you follow Oslo startups: Sanna raised 30 million NOK for its accounting automation. Also, a Norwegian YC startup claims its coding agent beats OpenAI in a benchmark test.";
const QUESTIONS = ["whats sanna?", "how did you know about that?", "why did you text me that?", "are you like reading the news for me or something?"];
const MACHINERY = /news[ -]?watch|watcher|the watch\b|(my|the|news) checks?\b|checks (the )?headlines|hourly|every hour|scans?\b|filter|automated|a system\b|pipeline|scheduled job|your profile|it tracks/i;

if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY is not set");
const dir = mkdtempSync(join(tmpdir(), "voice-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(INKBOX|MARITIME|TYPESAFE|COMPOSIO|LINK|GATEWAY)_/.test(k)));
Object.assign(env, {
  INSTINCT_DATA_DIR: dir, INSTINCT_WATCHER: "1", INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", INSTINCT_COMPUTER: "none",
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: PHONE, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
});
// The owner's picture, searches and a record of the news text, as a real agent has them, so a
// look at the notes finds what was sent instead of an empty setup.
const SANNA = "https://shifter.no/nyheter/sanna-henter-30-millioner";
const sentAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
const store = new WatchStore(new StateDir(dir));
store.update((s) => {
  s.on = true;
  s.profile = "Torstein lives in Oslo, texts in English, likes short messages. Norwegian startups: most interested. Holds XRP, only what matters to a holder. Startups worldwide: big rounds only. AI: casual, biggest moments only.";
  s.searches = [
    { topic: "Norwegian startups and venture funding", query: "startup Norge", edition: "no-NO" },
    { topic: "XRP, the Ripple cryptocurrency", query: "XRP Ripple", edition: "en-US" },
    { topic: "Startups and venture funding worldwide", query: "startup funding round", edition: "en-US" },
    { topic: "Artificial intelligence", query: "artificial intelligence", edition: "en-US" },
  ];
  s.stories.push({ id: "c_sanna1", subject: "Sanna", event: "raised 30 million NOK for accounting automation", status: "announced", titles: ["Sanna henter 30 millioner til regnskapsjakten"], links: [SANNA], firstTold: sentAt, lastTold: sentAt, updates: 0 });
  s.sent.push({ at: sentAt, text: NEWS, links: [SANNA], kind: "news" });
});
store.appendJournal({ at: sentAt, mode: "scheduled", outcome: "sent", note: "Texted Sanna's 30M raise as a new Norwegian startup story.", items: [{ title: "Sanna henter 30 millioner til regnskapsjakten", source: "SHIFTER", topic: "Norwegian startups and venture funding", link: SANNA, stage: "decide", result: "told", card: "c_sanna1" }] });

const phone = [];
const fake = { send: async (msg) => { phone.push(msg.text); } };
const app = await boot(env, { outbox: fake, logger: () => {}, skillsDir: fileURLToPath(new URL("../../../skills", import.meta.url)) });
// As boot wires the Inkbox channel in production: every successful send goes to the mirror.
const send = app.outbox.send.bind(app.outbox);
app.outbox.send = async (msg, ctx) => { await send(msg, ctx); app.runtime.mirrorToOwner(msg, ctx); };

let n = 0;
const say = async (text) => {
  const before = phone.length;
  await app.runtime.handleInbound({ id: `v${++n}`, channel: "imessage", from: PHONE, conversationKey: THREAD, text, replyRef: {}, receivedAt: new Date().toISOString() });
  return phone.slice(before).join(" / ").replace(/\n/g, " / ");
};

await say("hey");
await app.outbox.send({ channel: "imessage", to: PHONE, text: NEWS }, { principal: app.runtime.ownerPrincipal(), conversationKey: "scheduled:watcher" });
console.log(`(news text: "${NEWS}")`);
let flagged = 0;
for (const q of QUESTIONS) {
  const reply = await say(q);
  const hit = reply.match(MACHINERY);
  if (hit) flagged++;
  console.log(`  owner: ${q}\n  sunshine: ${reply}${hit ? `   <== machinery talk: "${hit[0]}"` : ""}`);
}
const thread = app.runtime.conversation(THREAD, app.runtime.ownerPrincipal()).agent.state.messages;
const cost = thread.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0);
console.log(`\nReplies with machinery talk: ${flagged}/${QUESTIONS.length}. Cost: $${cost.toFixed(4)}`);
await app.close();
rmSync(dir, { recursive: true, force: true });
