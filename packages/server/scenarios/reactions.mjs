// [sunshine:reactions] Is Sunshine precise about tapbacks? Builds the real system prompt for the
// owner's iMessage thread, offers the real react tool plus simple stand-ins for other tools, plays
// short conversations through Sonnet 5.5 (tool calls answered locally, nothing is sent), and scores
// each against the outcomes a friend would accept. Costs well under $1.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set): node scenarios/reactions.mjs [rounds=2]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ALL_CAPABILITIES, ContactStore, DEFAULT_PERSONA, StateDir, buildSystemPrompt, defaultConfig, resolveModel } from "@open-instinct/core";
import { messagingTools } from "@open-instinct/inkbox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 2);
// Optional: only some kinds, e.g. "closing,social".
const kinds = process.argv[3] ? new Set(process.argv[3].split(",")) : undefined;
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");

const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
config.agent = { ...config.agent, name: "Sunshine" };
const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4790000000" };
const system = buildSystemPrompt({
  config, principal: owner, channel: "imessage", now: new Date("2026-10-13T12:30:00Z"),
  capabilities: [...ALL_CAPABILITIES], toolGroups: ["messaging", "owner", "memory", "schedule", "web", "files"],
  memoryDigest: "Torstein lives in Oslo. Follows XRP and Norwegian startups. Loves Tine iskaffe.", persona: DEFAULT_PERSONA,
});

const dir = mkdtempSync(join(tmpdir(), "reactions-"));
const state = new StateDir(dir); state.ensure();
const react = messagingTools({ channel: { react: async () => {}, send: async () => {}, typing: async () => {} }, contacts: new ContactStore(state), config }).find((t) => t.spec.name === "react").spec;
rmSync(dir, { recursive: true, force: true });
const loose = (props) => ({ type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) });
const TOOLS = [
  { name: react.name, description: react.description, parameters: react.parameters },
  { name: "schedule_create", description: "Schedule a reminder or job for the owner at a time.", parameters: loose(["name", "prompt", "at", "cron"]) },
  { name: "watch_profile_update", description: "Add or change what the news watch follows for the owner.", parameters: loose(["profile", "topic", "query"]) },
  { name: "web_search", description: "Search the web.", parameters: loose(["query"]) },
  { name: "send_file", description: "Send a file from the workspace in this conversation.", parameters: loose(["path", "caption"]) },
  { name: "book_table", description: "Book a restaurant table for the owner.", parameters: loose(["restaurant", "when", "guests"]) },
  { name: "notify_contact", description: "Send a short text to one of the owner's contacts.", parameters: loose(["to", "text"]) },
];
const RESULTS = { react: (a) => (a.alone ? `Reacted ${a.reaction}. That is your whole reply: send no text.` : `Reacted ${a.reaction}. Now answer in words.`), schedule_create: () => "Scheduled.", watch_profile_update: () => "Saved.", web_search: () => "No useful results.", send_file: () => "Sent packing-list.pdf in the current imessage conversation.", book_table: () => "Booked.", notify_contact: () => "Sent." };

const asst = (content) => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
let callN = 0;
/** An earlier turn in which the agent really did something: its tool call, the result, then its text. */
function didThen(tool, args, result, text) {
  const id = `tc_${++callN}`;
  return [asst([{ type: "toolCall", id, name: tool, arguments: args }]), { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() }, asst(text)];
}

// Outcomes: "tapback only", "tapback + text", "text only", "nothing". `kind` groups them:
//   words: a question or request (a tapback alone here is the critical mistake)
//   closing: closing a task (tapback alone; any text is pointless)
//   social: a social moment (tapback plus a few warm words; checked for length, questions and offers)
//   none: needs nothing at all
const reminder = didThen("schedule_create", { name: "call mom", prompt: "Remind the owner to call mom.", at: "2026-10-13T16:00:00Z" }, "Scheduled s_1 for 2026-10-13T16:00:00Z.", "Done, I'll remind you at 18:00.");
const booking = didThen("book_table", { restaurant: "Pjoltergeist", when: "Friday 19:00", guests: "2" }, "Booked: Pjoltergeist, Friday 19:00, 2 guests, ref PJ-4411.", "Booked: Friday 19:00, table for two. Ref PJ-4411.");
const dentist = didThen("schedule_create", { name: "dentist", prompt: "Remind the owner about the dentist.", at: "2026-10-15T12:00:00Z" }, "Scheduled s_2 for 2026-10-15T12:00:00Z.", "Done, I'll remind you Thursday at 14:00.");
const S = [
  // closing a task
  { kind: "closing", name: "thanks after a reminder", before: [["remind me to call mom at 6", reminder]], msg: "thanks!", accept: ["tapback only"] },
  { kind: "closing", name: "perfect after a booking", before: [["can you book a table for two at Pjoltergeist friday at 7?", booking]], msg: "perfect", accept: ["tapback only"] },
  { kind: "closing", name: "thumbs up after a confirmation", before: [["remind me about the dentist thursday at 2", dentist]], msg: "👍", accept: ["tapback only", "nothing"] },
  { kind: "closing", name: "sounds good", before: [["what time should I leave for the 19:00 booking at Pjoltergeist?", didThen("web_search", { query: "walking time Oslo S to Pjoltergeist" }, "Walking route Oslo S to Pjoltergeist (Rosteds gate 15): 1.6 km, 20 minutes.", "Leave by 18:30; it's a 20 minute walk from Oslo S.")]], msg: "sounds good", accept: ["tapback only"] },
  { kind: "closing", name: "thanks for the help", before: [["can you book a table for two at Pjoltergeist friday at 7?", booking]], msg: "thanks for the help, appreciate it", accept: ["tapback only"] },
  // social moments
  { kind: "social", name: "goodnight", msg: "goodnight!", accept: ["tapback + text"] },
  { kind: "social", name: "got the tickets", msg: "Got the tickets for Saturday!", accept: ["tapback + text"] },
  { kind: "social", name: "big family news", msg: "My sister just had her baby!!", accept: ["tapback + text"] },
  { kind: "social", name: "passed an exam", msg: "I passed my exam!!", accept: ["tapback + text"] },
  { kind: "social", name: "a compliment", before: [["I'm out of iskaffe again", "Sounds like an emergency. Stay strong."]], msg: "haha you're hilarious", accept: ["tapback + text", "tapback only"] },
  { kind: "social", name: "cheering a result", before: [[null, "Brann beat Molde 2-1, Nordmann scored the winner."]], msg: "yesss", accept: ["tapback + text", "tapback only"] },
  // questions and requests
  { kind: "words", name: "Kanye request", msg: "Btw. Let me know if kanye is touring to norway", accept: ["text only"] },
  { kind: "words", name: "good news plus a request", msg: "I got the job!! Remind me to sign the contract tomorrow at 9", accept: ["tapback + text", "text only"] },
  { kind: "words", name: "weather question", msg: "What's the weather in Oslo tomorrow?", accept: ["text only"] },
  { kind: "words", name: "funny but asks something", msg: "lol ok but can you check bus times to the airport tomorrow morning?", accept: ["text only"] },
  { kind: "words", name: "resend a file", msg: "Can you send me that packing list PDF again?", accept: ["text only"] },
  { kind: "words", name: "bad news", msg: "ugh my flight got cancelled", accept: ["text only"] },
  { kind: "words", name: "thanks plus a new request", before: [["remind me to call mom at 6", reminder]], msg: "thanks! can you also text Sam that I'll be late?", accept: ["text only", "tapback + text"] },
  // needs nothing
  { kind: "none", name: "they reacted to a news text", before: [[null, "Since you follow XRP: it's down about 8% this week, around $1.37."]], msg: "[reaction love on message 1bff6a56-684d-4a7f-8de2-5aae84ef5695]", accept: ["nothing"] },
  { kind: "none", name: "they reacted to a confirmation", before: [["can you book a table for two at Pjoltergeist friday at 7?", booking]], msg: "[reaction like on message 2c1a7e90-1111-4a7f-8de2-5aae84ef0000]", accept: ["nothing"] },
];

let cost = 0, ok = 0, total = 0, critical = 0, pointless = 0, wordy = 0;
const rows = [];
for (let r = 0; r < rounds; r++) {
  for (const s of S.filter((x) => !kinds || kinds.has(x.kind))) {
    const messages = [];
    for (const [u, a] of s.before ?? []) { if (u) messages.push(user(u)); if (Array.isArray(a)) messages.push(...a); else messages.push(asst(a)); }
    messages.push(user(s.msg));
    const reactions = [];
    let reactedOnce = false; // the real tool refuses a second tapback on the same message
    let finalText = "";
    for (let turn = 0; turn < 4; turn++) {
      const reply = await completeSimple(model, { systemPrompt: system, messages, tools: TOOLS }, { apiKey, reasoning: "medium" });
      cost += reply.usage?.cost?.total ?? 0;
      messages.push(reply);
      const calls = reply.content.filter((c) => c.type === "toolCall");
      finalText = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
      if (calls.length === 0) break;
      for (const c of calls) {
        let text = (RESULTS[c.name] ?? (() => "Done."))(c.arguments);
        if (c.name === "react") {
          if (reactedOnce) text = "You already reacted to this message.";
          else reactions.push(c.arguments);
          reactedOnce = true;
        }
        messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text }], isError: text.startsWith("You already"), timestamp: Date.now() });
      }
    }
    const lone = reactions.some((a) => a.alone === true);
    const outcome = reactions.length ? (lone ? "tapback only" : finalText ? "tapback + text" : "tapback only") : finalText ? "text only" : "nothing";
    let pass = s.accept.includes(outcome);
    // A social reply stays short and never offers to do something (a short natural question is fine).
    const sent = outcome === "tapback + text" || outcome === "text only" ? finalText : "";
    const words = sent ? sent.split(/\s+/).length : 0;
    const tooMuch = s.kind === "social" && sent && (words > 20 || /want me to|if you('d)? like|i can (help|look|find|book|order)|shall i|should i/i.test(sent));
    if (tooMuch) pass = false;
    total++; if (pass) ok++;
    if (s.kind === "words" && outcome === "tapback only") critical++;
    if ((s.kind === "closing" || s.kind === "none") && sent) pointless++;
    if (tooMuch) wordy++;
    rows.push({ round: r + 1, kind: s.kind, name: s.name, outcome, pass, reactions: reactions.map((a) => `${a.reaction}${a.alone ? " alone" : ""}`).join(", "), text: finalText.slice(0, 140), dropped: lone && finalText ? "(text would be dropped)" : "", tooMuch });
  }
}
for (const x of rows) console.log(`${x.pass ? "ok  " : "MISS"} r${x.round} ${x.kind.padEnd(7)} ${x.name.padEnd(30)} ${x.outcome.padEnd(15)} ${x.reactions ? `[${x.reactions}] ` : ""}${x.text ? `"${x.text}"` : ""} ${x.dropped}${x.tooMuch ? " TOO MUCH" : ""}`);
const byKind = (k) => `${rows.filter((x) => x.kind === k && x.pass).length}/${rows.filter((x) => x.kind === k).length}`;
console.log(`\n${ok}/${total} acceptable (closing ${byKind("closing")}, social ${byKind("social")}, words ${byKind("words")}, none ${byKind("none")}).`);
console.log(`Critical (tapback alone where words were needed): ${critical}. Pointless text after closing or a reaction: ${pointless}. Social replies too long, asking back, or offering help: ${wordy}. Cost: $${cost.toFixed(4)}`);
