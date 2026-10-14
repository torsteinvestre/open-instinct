// [sunshine:reactions] Is Sunshine precise about tapbacks? Builds the real system prompt for the
// owner's iMessage thread, offers the real react tool plus simple stand-ins for other tools, plays
// short, varied conversations through Sonnet 5.5 (tool calls answered locally, nothing is sent), and
// scores each against what a friend would accept. Can compare the current guidance ("new") with the
// earlier numbered ladder ("old") on the same messages. Costs well under $1.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/reactions.mjs [rounds=2] [new|old|both=both] [kinds=all, or e.g. happy,sad]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ALL_CAPABILITIES, ContactStore, DEFAULT_PERSONA, StateDir, buildSystemPrompt, defaultConfig, resolveModel, timeStamp } from "@open-instinct/core";
import { messagingTools } from "@open-instinct/inkbox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 2);
const which = process.argv[3] ?? "both";
const onlyKinds = process.argv[4] && process.argv[4] !== "all" ? new Set(process.argv[4].split(",")) : null;
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");

const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
config.agent = { ...config.agent, name: "Sunshine" };
// [sunshine:stable-cache] STAMPS=off plays the messages as before the change (clock in the prompt, no stamps).
const STAMPS = process.env.STAMPS !== "off";
config.features = { ...config.features, stableCache: STAMPS };
const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4790000000" };
const promptAt = (now) => buildSystemPrompt({
  config, principal: owner, channel: "imessage", now,
  capabilities: [...ALL_CAPABILITIES], toolGroups: ["messaging", "owner", "memory", "schedule", "web", "files"],
  memoryDigest: "Torstein lives in Oslo. Follows XRP and Norwegian startups. Loves Tine iskaffe.", persona: DEFAULT_PERSONA,
});
const DEFAULT_NOW = "2026-10-13T12:30:00Z"; // a Tuesday, 14:30 in Oslo
const NEW_SYSTEM = promptAt(new Date(DEFAULT_NOW));
// A case can set its own clock ("goodnight" late, "god morgen" early), so the model never has to
// point out the time instead of answering. [sunshine:stable-cache] The clock rides on the message,
// as the runtime sends it.
const stampedAt = (iso, text) => (STAMPS ? `${timeStamp(new Date(iso ?? DEFAULT_NOW), "Europe/Oslo")}\n${text}` : text);

// The earlier guidance (commit 631ed59), for comparison on the same messages.
const OLD_LADDER = [
  "Tapbacks (the react tool), in your owner's own thread only. Ask in order and stop at the first that fits:",
  "1. Does the message ask for something, or do they need to know what you did? Answer in words, no tapback. A tapback alone would leave them wondering whether you got it.",
  '2. Big news that also asks for something ("I got the job! Remind me to sign tomorrow")? love with alone: false, then the answer, without repeating the feeling in words.',
  '3. Closing a task you just did ("thanks", "ok", "perfect", "sounds good", a thumbs up)? like or love with alone: true, and no text.',
  '4. A social moment ("goodnight", good news they share, excitement, a compliment)? love with alone: false, then a few warm words like a friend would ("Night!", "Nice, enjoy Saturday!"). A short natural question or a personal touch is fine where a friend would add one ("How are she and the baby doing?"). A social reply never offers to do something, not even about an earlier problem in the conversation; if they want help, they will ask.',
  "5. When they react to one of your messages, that needs no reply of any kind.",
  "6. In doubt: no tapback.",
].join("\n");
const start = NEW_SYSTEM.indexOf("Tapbacks (the react tool) are how");
const end = NEW_SYSTEM.indexOf("Most messages get no tapback.") + "Most messages get no tapback.".length;
if (start < 0 || end < start) throw new Error("could not find the tapback guidance in the system prompt");
const OLD_SYSTEM = NEW_SYSTEM.slice(0, start) + OLD_LADDER + NEW_SYSTEM.slice(end);

const dir = mkdtempSync(join(tmpdir(), "reactions-"));
const state = new StateDir(dir); state.ensure();
const react = messagingTools({ channel: { react: async () => {}, send: async () => {}, typing: async () => {} }, contacts: new ContactStore(state), config }).find((t) => t.spec.name === "react").spec;
rmSync(dir, { recursive: true, force: true });
const VARIANTS = {
  new: { system: NEW_SYSTEM, reactDescription: react.description, loneDropsAlways: false, result: (a) => (a.alone ? `Reacted ${a.reaction}. No text is needed unless you also did something they should hear about.` : `Reacted ${a.reaction}. Now write your reply.`) },
  old: { system: OLD_SYSTEM, reactDescription: "Put an iMessage tapback on the owner's message you are answering, in their own one-to-one thread. Alone (alone: true) when they close a task and no text is needed; with a few words (alone: false) for a social moment or with your answer to big news. Never as the only reply to a question or a request.", loneDropsAlways: true, result: (a) => (a.alone ? `Reacted ${a.reaction}. That is your whole reply: send no text.` : `Reacted ${a.reaction}. Now answer in words.`) },
};
const variants = which === "both" ? ["new", "old"] : which.split(",");
for (const v of variants) if (!VARIANTS[v]) throw new Error(`unknown variant ${v}`);
const loose = (props) => ({ type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) });
const STANDINS = [
  { name: "schedule_create", description: "Schedule a reminder or job for the owner at a time.", parameters: loose(["name", "prompt", "at", "cron"]) },
  { name: "schedule_list", description: "List the owner's reminders and scheduled jobs.", parameters: loose([]) },
  { name: "schedule_update", description: "Change the time of an existing reminder or booking.", parameters: loose(["id", "to"]) },
  { name: "watch_profile_update", description: "Change what the news watch follows for the owner, or note their reaction to a news text.", parameters: loose(["profile", "topic", "query"]) },
  { name: "web_search", description: "Search the web.", parameters: loose(["query"]) },
  { name: "send_file", description: "Send a file from the workspace in this conversation.", parameters: loose(["path", "caption"]) },
  { name: "book_table", description: "Book a restaurant table for the owner.", parameters: loose(["restaurant", "when", "guests"]) },
  { name: "buy_tickets", description: "Buy event tickets for the owner.", parameters: loose(["event", "quantity"]) },
  { name: "notify_contact", description: "Send a short text to one of the owner's contacts.", parameters: loose(["to", "text"]) },
];
const STANDIN_RESULTS = { schedule_create: "Scheduled.", schedule_list: "s_1: call mom | one-time | waiting, next today 18:00\ns_3: dentist | one-time | waiting, next Thursday 14:00", schedule_update: "Moved.", watch_profile_update: "Saved.", web_search: "No useful results.", send_file: "Sent packing-list.pdf in the current imessage conversation.", book_table: "Booked: Pjoltergeist, 19:00, 2 guests.", buy_tickets: "Bought 2 tickets, 450 kr.", notify_contact: "Sent." };

const asst = (content) => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
let callN = 0;
/** An earlier turn in which the agent really did something: its tool call, the result, then its text. */
function didThen(tool, args, result, text) {
  const id = `tc_${++callN}`;
  return [asst([{ type: "toolCall", id, name: tool, arguments: args }]), { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() }, asst(text)];
}
const reminder = () => didThen("schedule_create", { name: "call mom", prompt: "Remind the owner to call mom.", at: "2026-10-13T16:00:00Z" }, "Scheduled s_1 for 2026-10-13T16:00:00Z.", "Done, I'll remind you at 18:00.");
const booking = () => didThen("book_table", { restaurant: "Pjoltergeist", when: "Friday 19:00", guests: "2" }, "Booked: Pjoltergeist, Friday 19:00, 2 guests, ref PJ-4411.", "Booked: Friday 19:00, table for two. Ref PJ-4411.");
const pdf = () => didThen("send_file", { path: "packing-list.pdf", caption: "Weekend packing list" }, "Sent packing-list.pdf in the current imessage conversation.", "");
const NEWS = "Since you follow XRP: it's down about 8% this week, around $1.37, after the leverage flush.";
const news = () => didThen("web_search", { query: "XRP price this week" }, "CoinDesk, today: XRP trades near $1.37, down about 8% on the week after a wave of leveraged liquidations.", NEWS);

// kind: closing (tapback alone or nothing), approval / mixed / words / sad (words needed: a lone
// tapback is CRITICAL), happy (tapback plus a few warm words; checked for length, and for offers
// unless offerOk: an offer is the obvious next step for exactly what they shared),
// theirs (their plain tapback: no reply), signal (their ? / 👎 / 😡: a few words).
// Earlier answers are tool-backed, so the model never has to correct a claim it could not have made.
const S = [
  { kind: "closing", name: "thanks! after a reminder", before: [["remind me to call mom at 6", reminder()]], msg: "thanks!" },
  { kind: "closing", name: "perfect after a booking", before: [["book a table for two at Pjoltergeist friday at 7", booking()]], msg: "perfect" },
  { kind: "closing", name: "👍 after a confirmation", before: [["remind me to call mom at 6", reminder()]], msg: "👍" },
  { kind: "closing", name: "takk! after a file", before: [["send me the packing list as a pdf", pdf()]], msg: "takk!" },
  { kind: "closing", name: "great, thx after an answer", before: [["when's my dentist?", didThen("schedule_list", {}, "s_3 dentist reminder: Thursday 2026-10-15 14:00 Europe/Oslo.", "Thursday at 14:00.")]], msg: "great, thx" },
  { kind: "closing", name: "ok cool after an answer", before: [["is the SATS gym in Oslo open on sunday?", didThen("web_search", { query: "SATS Oslo opening hours sunday" }, "SATS Oslo: Sunday 10:00-18:00.", "Yes, 10:00 to 18:00 on Sundays.")]], msg: "ok cool" },
  { kind: "closing", name: "sounds good after advice", before: [["I'm at Oslo S, when should I leave for the 19:00 dinner at Pjoltergeist?", didThen("web_search", { query: "walking time Oslo S to Pjoltergeist" }, "About 20 minutes on foot.", "Leave around 18:35; it's about 20 minutes on foot.")]], msg: "sounds good" },
  { kind: "approval", name: "ok = yes to booking", before: [["any tables at Pjoltergeist friday?", "There's a table for two at 19:00 on Friday. Want me to book it?"]], msg: "ok" },
  { kind: "approval", name: "yes please to news watch", before: [["is kanye touring?", "Nothing announced for Norway yet. Should I add him to your news watch so I tell you if he is?"]], msg: "yes please" },
  { kind: "approval", name: "yep go ahead to tickets", before: [["any tickets left for Brann on saturday?", didThen("web_search", { query: "Brann tickets saturday" }, "Brann tickets, Saturday 18:00: east stand, 2 seats left, 450 kr each.", "Yes, two seats in the east stand, 450 kr each. Want me to buy them?")]], msg: "yep go ahead" },
  { kind: "mixed", name: "thanks + move it", before: [["book a table for two at Pjoltergeist friday at 7", booking()]], msg: "thanks! and move it to 8 instead" },
  { kind: "mixed", name: "thanks + text Sam", before: [["remind me to call mom at 6", reminder()]], msg: "thanks! can you also text sam that i'll be late tonight?" },
  { kind: "happy", name: "goodnight!", at: "2026-10-13T20:45:00Z", msg: "goodnight!" },
  { kind: "happy", name: "concert tickets next week", msg: "Got tickets for the concert next week!!", offerOk: true },
  { kind: "happy", name: "booked Rome flights", msg: "just booked flights to Rome for november 🇮🇹", offerOk: true },
  { kind: "happy", name: "got the job, starts the 3rd", msg: "I GOT THE JOB!! starting on the 3rd", offerOk: true },
  { kind: "happy", name: "passed driving test", msg: "I passed my driving test 🎉" },
  { kind: "happy", name: "sister had a baby", msg: "my sister just had her baby!!" },
  { kind: "happy", name: "we got engaged", msg: "we got engaged!!! 💍" },
  { kind: "happy", name: "first 10k", msg: "just ran my first 10k without stopping" },
  { kind: "happy", name: "Brann won", msg: "BRANN WON 3-0 😍" },
  { kind: "happy", name: "you're hilarious", before: [["I'm out of iskaffe again", "Sounds like an emergency. Stay strong."]], msg: "haha you're hilarious" },
  { kind: "happy", name: "god morgen", at: "2026-10-13T05:45:00Z", msg: "god morgen ☀️" },
  { kind: "happy", name: "finally friday", at: "2026-10-16T14:30:00Z", msg: "finally friday 🙌" },
  { kind: "sad", name: "grandma passed away", msg: "my grandma passed away this morning" },
  { kind: "sad", name: "flight cancelled", msg: "ugh my flight got cancelled" },
  { kind: "sad", name: "three deadlines", msg: "ugh three deadlines tomorrow and i havent started any of them" },
  { kind: "sad", name: "feeling sick", msg: "feeling kinda sick today" },
  { kind: "words", name: "weather question", msg: "what's the weather in oslo tomorrow?" },
  { kind: "words", name: "hva er klokka", msg: "hva er klokka?" },
  { kind: "words", name: "resend the pdf", msg: "can you resend the packing list pdf?" },
  { kind: "words", name: "lol + bus times", msg: "lol ok but can you check bus times to the airport tomorrow morning?" },
  { kind: "words", name: "remind at 5", msg: "remind me to buy iskaffe when i leave work at 5" },
  { kind: "theirs", name: "their ❤️ on a news text", before: [[null, news()]], msg: "[reaction love on message 1bff6a56-684d-4a7f-8de2-5aae84ef5695]" },
  { kind: "theirs", name: "their 👍 on a confirmation", before: [["book a table for two at Pjoltergeist friday at 7", booking()]], msg: "[reaction like on message 2c1a7e90-1111-4a7f-8de2-5aae84ef0000]" },
  // As tapbacks really reach the shared line (2026-10-14): as text, in the phone's language. A
  // tapback back lands on a message that is not a bubble on their phone, so it is invisible: fine.
  { kind: "theirsText", name: "Likte «108» (Norwegian)", before: [["whats 12*9?", "108"]], msg: "Likte «108»" },
  { kind: "theirsText", name: "Loved “…” (English)", before: [[null, news()]], msg: `Loved “${NEWS}”` },
  { kind: "signal", name: "Satte spørsmålstegn ved «…»", before: [["yo sunshine", "Yo. What do you need?"]], msg: "Satte spørsmålstegn ved «Yo. What do you need?»" },
  { kind: "signal", name: "Disliked “…” (English)", before: [[null, news()]], msg: `Disliked “${NEWS}”` },
  { kind: "signal", name: "their ? on an answer", before: [["what's the deal with the XRP patch?", didThen("web_search", { query: "XRP ledger emergency amendment" }, "CoinDesk: XRPL validators fast-tracked an emergency amendment, skipping the usual two-week vote, to fix a ledger bug. Critics call it a centralization risk.", "XRPL validators pushed an emergency amendment without the usual two-week vote; some call it a centralization risk, others say it was needed to fix the ledger bug.")]], msg: "[reaction question on message 3d2b8f01-2222-4a7f-8de2-5aae84ef1111]" },
  { kind: "signal", name: "their 👎 on a news text", before: [[null, news()]], msg: "[reaction dislike on message 1bff6a56-684d-4a7f-8de2-5aae84ef5696]" },
  { kind: "signal", name: "their 😡 on a reminder", before: [["remind me about the dentist on thursday", didThen("schedule_create", { name: "dentist", prompt: "Remind the owner about the dentist.", at: "2026-10-13T06:00:00Z" }, "Scheduled s_3 for 2026-10-13T06:00:00Z.", "Done.")], [null, "Reminder: dentist today."]], msg: "[reaction 😡 on message 4e3c9a12-3333-4a7f-8de2-5aae84ef2222]" },
];
const ACCEPT = {
  closing: ["tapback only", "nothing"], approval: ["text only", "tapback + text"], mixed: ["text only", "tapback + text"], words: ["text only"],
  sad: ["text only", "tapback + text"], happy: ["tapback + text", "text only"], theirs: ["nothing"], signal: ["text only", "tapback + text"],
  theirsText: ["nothing", "tapback only"],
};
const WORDS_NEEDED = new Set(["approval", "mixed", "words", "sad"]);

let cost = 0;
const results = Object.fromEntries(variants.map((v) => [v, []]));
const CASES = onlyKinds ? S.filter((s) => onlyKinds.has(s.kind)) : S;
for (const variant of variants) {
  const v = VARIANTS[variant];
  const TOOLS = [{ name: react.name, description: v.reactDescription, parameters: react.parameters }, ...STANDINS];
  for (let r = 0; r < rounds; r++) {
    for (const s of CASES) {
      const messages = [];
      for (const [u, a] of s.before ?? []) { if (u) messages.push(user(u)); if (Array.isArray(a)) messages.push(...a); else messages.push(asst(a)); }
      messages.push(user(stampedAt(s.at, s.msg)));
      const reactions = [];
      let reactedOnce = false, otherTool = false, finalText = "", loneBlocked = false;
      for (let turn = 0; turn < 5; turn++) {
        const reply = await completeSimple(model, { systemPrompt: v.system, messages, tools: TOOLS }, { apiKey, reasoning: "medium" });
        cost += reply.usage?.cost?.total ?? 0;
        messages.push(reply);
        const calls = reply.content.filter((c) => c.type === "toolCall");
        finalText = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (calls.length === 0) break;
        for (const c of calls) {
          let text;
          if (c.name === "react" && s.msg.startsWith("[reaction")) {
            // [sunshine:reactions] As the real tool: their tapback is never answered with one. Nothing is
            // sent, but a lone one still counts as the whole reply.
            text = "No tapback needed: this is their tapback on one of your messages, and nothing was sent. Most tapbacks need no reply at all. Answer in a few words only if theirs shows confusion or displeasure.";
            if (c.arguments?.alone === true) loneBlocked = true;
          } else if (c.name === "react") {
            text = reactedOnce ? "You already reacted to this message." : v.result(c.arguments);
            if (!reactedOnce) reactions.push(c.arguments);
            reactedOnce = true;
          } else {
            otherTool = true;
            text = STANDIN_RESULTS[c.name] ?? "Done.";
          }
          messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text }], isError: text.startsWith("You already"), timestamp: Date.now() });
        }
      }
      const lone = reactions.some((a) => a.alone === true) || loneBlocked;
      const dropped = lone && (v.loneDropsAlways || !otherTool);
      const sent = dropped ? "" : finalText;
      const outcome = reactions.length ? (sent ? "tapback + text" : "tapback only") : sent ? "text only" : "nothing";
      const offer = /want me to|need me to|if you('d)? like|if you want|i can (help|look|find|book|order|get|add|put|set)|shall i|should i|let me know if|happy to (help|add|set|look)/i.test(sent);
      let pass = ACCEPT[s.kind].includes(outcome);
      if (s.kind === "happy" && ((offer && !s.offerOk) || sent.split(/\s+/).length > 25)) pass = false;
      if (s.kind === "words" && outcome === "tapback + text") pass = false; // a tapback on a question is odd
      const critical = WORDS_NEEDED.has(s.kind) && (outcome === "tapback only" || outcome === "nothing");
      results[variant].push({ round: r + 1, kind: s.kind, name: s.name, offerOk: !!s.offerOk, outcome, pass, critical, offer, reactions: reactions.map((a) => `${a.reaction}${a.alone ? " alone" : ""}`).join(","), sent: sent.slice(0, 150), droppedText: dropped && finalText ? finalText.slice(0, 60) : "" });
    }
  }
}

const KINDS = ["closing", "approval", "mixed", "happy", "sad", "words", "theirs", "theirsText", "signal"];
for (const variant of variants) {
  const rows = results[variant];
  const by = (k) => `${rows.filter((x) => x.kind === k && x.pass).length}/${rows.filter((x) => x.kind === k).length}`;
  const offers = (f) => `${rows.filter((x) => f(x) && x.offer).length}/${rows.filter(f).length}`;
  console.log(`\n===== ${variant.toUpperCase()}: ${rows.filter((x) => x.pass).length}/${rows.length} acceptable; CRITICAL (no words where words were needed): ${rows.filter((x) => x.critical).length}`);
  console.log("  " + KINDS.filter((k) => rows.some((x) => x.kind === k)).map((k) => `${k} ${by(k)}`).join(" | "));
  console.log(`  offers made: happy where one fits ${offers((x) => x.kind === "happy" && x.offerOk)} | happy where none fits ${offers((x) => x.kind === "happy" && !x.offerOk)} | sad ${offers((x) => x.kind === "sad")}`);
  // Everything it would send, grouped by case so the rounds sit side by side.
  for (const x of [...rows].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name) || a.round - b.round)) {
    console.log(`  ${x.pass ? "ok  " : "MISS"} r${x.round} ${x.kind.padEnd(8)} ${x.name.padEnd(28)} ${x.outcome.padEnd(14)} ${x.reactions ? `[${x.reactions}] ` : ""}${x.sent ? `"${x.sent}"` : ""}${x.critical ? "  <== CRITICAL" : ""}${x.offer ? "  (offer)" : ""}`);
  }
}
console.log(`\nCost: $${cost.toFixed(4)}`);
