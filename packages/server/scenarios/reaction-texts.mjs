// [sunshine:reactions] On the shared line their tapbacks arrive as text in their phone's language
// ("Satte et hjerte ved «…»", "Loved “…”", "Reagerte med 🐐 på «…»"; no reaction events: checked in
// Inkbox's delivery log, 2026-10-15). Before building the fix, this asks: does Sunshine answer better
// when such a text reaches it labelled as their reaction ("labelled", as the fix would pass it on, with
// the no-tapback-on-a-tapback fence) than as the raw text ("raw", as today)? Positive reactions should
// get no text; a question or displeasure a few words. Real examples from Torstein's phone plus English
// ones. Builds the real system prompt, real react tool description, nothing is sent. About 10 cents.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/reaction-texts.mjs [rounds=1] [raw|labelled|both=both]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ALL_CAPABILITIES, ContactStore, DEFAULT_PERSONA, StateDir, buildSystemPrompt, defaultConfig, resolveModel, timeStamp } from "@open-instinct/core";
import { messagingTools } from "@open-instinct/inkbox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 1);
const which = process.argv[3] ?? "both";
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");
const TZ = "Europe/Oslo";
const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: TZ };
config.agent = { ...config.agent, name: "Sunshine" };
const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4790000000" };
const NOW = new Date("2026-10-15T12:27:00Z");
const system = buildSystemPrompt({
  config, principal: owner, channel: "imessage", now: NOW,
  capabilities: [...ALL_CAPABILITIES], toolGroups: ["messaging", "owner", "memory", "schedule", "web", "files"],
  memoryDigest: "Torstein lives in Oslo. Follows XRP and Norwegian startups.", persona: DEFAULT_PERSONA,
});
const dir = mkdtempSync(join(tmpdir(), "reaction-texts-"));
const state = new StateDir(dir); state.ensure();
const react = messagingTools({ channel: { react: async () => {}, send: async () => {}, typing: async () => {} }, contacts: new ContactStore(state), config }).find((t) => t.spec.name === "react").spec;
rmSync(dir, { recursive: true, force: true });
const loose = (props) => ({ type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) });
const TOOLS = [
  { name: react.name, description: react.description, parameters: react.parameters },
  { name: "schedule_create", description: "Schedule a reminder or job for the owner.", parameters: loose(["name", "text", "prompt", "at", "cron"]) },
  { name: "schedule_list", description: "List the owner's reminders and scheduled jobs.", parameters: loose([]) },
  { name: "watch_settings", description: "Change how often you look at the news for them, or their quiet hours.", parameters: loose(["everyMinutes"]) },
  { name: "web_search", description: "Search the web.", parameters: loose(["query"]) },
];

const asst = (content) => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: NOW.getTime() });
const user = (text) => ({ role: "user", content: `${timeStamp(NOW, TZ)}\n${text}`, timestamp: NOW.getTime() });
// Earlier answers rest on real tool results, so the model never has to correct a claim it could not
// have made (the first run of this test, without them, measured self-corrections instead).
let callN = 0;
function didThen(tool, args, result, text) {
  const id = `tc_${++callN}`;
  return [asst([{ type: "toolCall", id, name: tool, arguments: args }]), { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: result }], isError: false, timestamp: NOW.getTime() }, asst(text)];
}

const XRP = "It has moved a bit, from about $1.37 to $1.30, which is roughly 5% down. That’s small for crypto.\n\nThe ledger news is mostly technical, like the fee and reserve amendment. Those are slow-burn changes that traders rarely price in. XRP is also moving with the whole crypto market right now.";
const XRP_FOUND = "CoinDesk, 08:05: XRP trades at $1.37. CoinDesk, 12:10: XRP at $1.30, down about 5% since the morning as the whole crypto market slides on liquidations and rate worries. XRPL validators approved the fee and reserve amendment this week.";
const NEWS = "XRP is down about 8% this week, around $1.30, after a wave of leveraged liquidations.";
const NEWS_FOUND = "CoinDesk, today: XRP trades near $1.30, down about 8% on the week after a wave of leveraged liquidations.";
const NEWS_NOTE = "[Not a message from Torstein: a note that you texted them the next message on your own, after reading the news for them. No reply is needed to it.]";
const COLE = "Unity Arena, Oslo: J. Cole, Saturday 14 November 2026, doors 19:00. Tickets sold out.";
const BRANN = "NRK, Sunday: Brann beat Viking 3-0 at home.";
const PATCH = "CoinDesk: XRPL validators pushed an emergency amendment without the usual two-week vote to fix a ledger bug; critics call it a centralization risk.";
// kind: positive (no text wanted) or signal (a few words wanted). quote: Sunshine's message they reacted to.
const S = [
  { kind: "positive", name: "NO heart (real)", before: ["check the news every 2 hours", didThen("watch_settings", { everyMinutes: 120 }, "Every 2 hours, outside quiet hours 23:00-07:00 (Europe/Oslo).", "Done. I’ll check the news every 2 hours.")], phrase: "Satte et hjerte ved", open: "«", close: "»" },
  { kind: "signal", name: "NO question (real)", before: ["how much has xrp moved since this morning?", didThen("web_search", { query: "XRP price today" }, XRP_FOUND, XRP)], search: XRP_FOUND, phrase: "Satte spørsmålstegn ved", open: "«", close: "»" },
  { kind: "positive", name: "NO custom 🐐 (real)", before: ["is the 5% exact?", "Not exactly. The two prices came from different reports, so the 5% is a rough figure."], search: XRP_FOUND, phrase: "Reagerte med 🐐 på", open: "«", close: "»" },
  { kind: "positive", name: "NO custom 😂 on 🙏 (real)", before: ["haha thanks", "🙏"], phrase: "Reagerte med 😂 på", open: "«", close: "»" },
  { kind: "positive", name: "NO custom 👌 (real)", before: ["what would a 4M apartment cost me a month if I put in 800k?", "You'd borrow 3.2M: about 18,000 NOK a month at 5.5% over 30 years, before fees and upkeep."], phrase: "Reagerte med 👌 på", open: "«", close: "»" },
  { kind: "positive", name: "EN Loved news", before: [NEWS_NOTE, didThen("web_search", { query: "XRP price this week" }, NEWS_FOUND, NEWS)], search: NEWS_FOUND, phrase: "Loved", open: "“", close: "”" },
  { kind: "positive", name: "EN Liked confirmation", before: ["remind me to call mom at 6", didThen("schedule_create", { name: "call mom", text: "Call mom", at: "2026-10-15T18:00:00+02:00" }, 'Scheduled "call mom" (id s_1). It will send exactly: "Call mom". Next run: 2026-10-15T16:00:00.000Z (Thu 15 Oct, 18:00 Europe/Oslo).', "Done, I'll remind you at 18:00.")], phrase: "Liked", open: "“", close: "”" },
  { kind: "positive", name: "EN Laughed at", before: ["I'm out of iskaffe again", "Sounds like an emergency. Stay strong."], phrase: "Laughed at", open: "“", close: "”" },
  { kind: "positive", name: "EN Emphasized", before: ["when's the J. Cole concert?", didThen("web_search", { query: "J. Cole Oslo concert date" }, COLE, "Saturday 14 November, Unity Arena.")], search: COLE, phrase: "Emphasized", open: "“", close: "”" },
  { kind: "positive", name: "EN Reacted 🔥", before: ["how did brann do?", didThen("web_search", { query: "Brann Viking result" }, BRANN, "They won 3-0 against Viking.")], search: BRANN, phrase: "Reacted 🔥 to", open: "“", close: "”" },
  { kind: "signal", name: "EN Questioned", before: ["what's the deal with the XRP patch?", didThen("web_search", { query: "XRP ledger emergency amendment" }, PATCH, "Validators pushed an emergency amendment without the usual two-week vote.")], search: PATCH, phrase: "Questioned", open: "“", close: "”" },
  { kind: "signal", name: "EN Disliked news", before: [NEWS_NOTE, didThen("web_search", { query: "XRP price this week" }, NEWS_FOUND, NEWS)], search: NEWS_FOUND, phrase: "Disliked", open: "“", close: "”" },
  { kind: "signal", name: "EN Reacted 😡 to a wrong reminder", before: ["remind me about the dentist on thursday", didThen("schedule_create", { name: "dentist", text: "Dentist today", at: "2026-10-15T08:00:00+02:00" }, 'Scheduled "dentist" (id s_3). It will send exactly: "Dentist today". Next run: 2026-10-15T06:00:00.000Z (Thu 15 Oct, 08:00 Europe/Oslo).', "Done.")], quoted: "Dentist today", phrase: "Reacted 😡 to", open: "“", close: "”" },
];
/** The message they reacted to: Sunshine's last text before the reaction (or `quoted`, a reminder it sent). */
const target = (s) => s.quoted ?? (Array.isArray(s.before[1]) ? s.before[1].at(-1).content[0].text : s.before[1]);
const clip = (t, n) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
const raw = (s) => `${s.phrase} ${s.open}${target(s)}${s.close}`;
const labelled = (s) => `[reaction ${s.phrase} on your message “${clip(target(s).replace(/\s+/g, " "), 80)}”]`;
const FENCE = "No tapback needed: this is their tapback on one of your messages, and nothing was sent. Most tapbacks need no reply at all. Answer in a few words only if theirs shows confusion or displeasure.";

let cost = 0;
const rows = [];
for (const variant of which === "both" ? ["raw", "labelled"] : [which]) {
  for (let r = 0; r < rounds; r++) {
    for (const s of S) {
      const messages = [];
      if (s.before[0]) messages.push(user(s.before[0]));
      if (Array.isArray(s.before[1])) messages.push(...s.before[1]);
      else messages.push(asst(s.before[1]));
      // The reminder they reacted to went out from its job; the thread holds its copy, as the mirror writes it.
      if (s.quoted) messages.push(user(`[Not a message from Torstein: a note that you texted them the next message when "dentist", which they set up with you, came due. No reply is needed to it.]`), asst(s.quoted));
      messages.push(user(variant === "raw" ? raw(s) : labelled(s)));
      let finalText = "", lone = false, otherTool = false;
      const reacts = [];
      for (let turn = 0; turn < 5; turn++) {
        const reply = await completeSimple(model, { systemPrompt: system, messages, tools: TOOLS }, { apiKey, reasoning: "medium" });
        cost += reply.usage?.cost?.total ?? 0;
        messages.push(reply);
        const calls = reply.content.filter((c) => c.type === "toolCall");
        finalText = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (calls.length === 0) break;
        for (const c of calls) {
          let out = c.name === "web_search" ? (s.search ?? "No new results.") : c.name === "schedule_list" ? "s_1: call mom | one-time | waiting, next today 18:00" : "Done.";
          if (c.name === "react") {
            reacts.push(`${c.arguments?.reaction}${c.arguments?.alone ? " alone" : ""}`);
            if (c.arguments?.alone === true) lone = true;
            // Labelled: the fix marks it as their tapback, so the real tool's fence answers. Raw: as today.
            out = variant === "labelled" ? FENCE : c.arguments?.alone ? `Reacted ${c.arguments.reaction}. No text is needed unless you also did something they should hear about.` : `Reacted ${c.arguments.reaction}. Now write your reply.`;
          } else otherTool = true;
          messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: out }], isError: false, timestamp: Date.now() });
        }
      }
      // As the runtime: a lone tapback with no other tool drops the text after it.
      const sent = lone && !otherTool ? "" : finalText;
      const pass = s.kind === "positive" ? sent === "" : sent.length > 0;
      rows.push({ variant, round: r + 1, ...s, sent, reacts: reacts.join(","), pass });
      process.stderr.write(".");
    }
  }
}
process.stderr.write("\n");
for (const v of [...new Set(rows.map((x) => x.variant))]) {
  const mine = rows.filter((x) => x.variant === v);
  const k = (kind) => `${mine.filter((x) => x.kind === kind && x.pass).length}/${mine.filter((x) => x.kind === kind).length}`;
  console.log(`\n===== ${v.toUpperCase()}: ${mine.filter((x) => x.pass).length}/${mine.length} as wanted (positive, no text: ${k("positive")}; question or displeasure, words: ${k("signal")})`);
  for (const x of mine) console.log(`  ${x.pass ? "ok  " : "MISS"} r${x.round} ${x.kind.padEnd(8)} ${x.name.padEnd(34)} ${x.reacts ? `[${x.reacts}] ` : ""}${x.sent ? `"${x.sent.replace(/\n/g, " / ").slice(0, 160)}"` : "(no text)"}`);
}
console.log(`\nCost: $${cost.toFixed(4)}`);
