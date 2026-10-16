// [sunshine:onboarding] A new friend's first chat with Sunshine: does it feel like meeting someone
// helpful, or like a form? Boots the real server in a throwaway folder with a new friend's settings
// (Åsa from Sweden, signed up through the gateway: name, Swedish number, Stockholm time, the news on,
// no apps, empty memory), captures the exact instructions, tool list and the welcome note the runtime
// puts in front of a first text, and plays the first chat through Sonnet 5.5. The friend is played by Haiku 5.5 from a short description, so Sunshine's
// questions get natural answers instead of a script that may not fit them. A skill Sunshine opens is
// the real SKILL.md; apps_connect gives the real "not set up" answer; web searches get a canned result;
// other tools say done. Nothing is sent anywhere.
// Checks each of Sunshine's texts: asks for the name or timezone signup already gave; more than one
// question; offers apps or asks about partner and family on day one; uses her name; answers in her
// language; length. Prints every text whole: read them too.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set): node scenarios/onboarding.mjs
// (about 15 cents). DRY=1 only captures the instructions and stops: free.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { encodeEvent, resolveModel, timeStamp } from "@open-instinct/core";
import { resolveWatcherModel } from "@open-instinct/watcher";
import { boot } from "../dist/boot.js";
import { handleChat } from "../dist/http.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey && !process.env.DRY) throw new Error("ANTHROPIC_API_KEY is not set");
const sonnet = resolveModel("anthropic/claude-sonnet-5-5");
const haiku = resolveWatcherModel("anthropic/claude-haiku-5-5");
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const TZ = "Europe/Stockholm";
const OWNER = "+46701234567";

// The real instructions and tools for a friend's agent, captured from a booted server through a stand-in model.
const dir = mkdtempSync(join(tmpdir(), "onboarding-"));
mkdirSync(join(dir, "memory"), { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_WATCHER: "1", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1", INSTINCT_MODEL: "faux/faux-1",
  INSTINCT_OWNER_NAME: "Åsa Lindqvist", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: TZ, INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-asa-k3f9", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const fauxModels = createModels();
fauxModels.setProvider(faux.provider);
const captured = [];
const streamFn = (m, context, opts) => { captured.push(context); return fauxModels.streamSimple(m, context, opts); };
const fetchImpl = async (input) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`offline: ${url}`);
};
const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, fetchImpl, outbox: { send: async () => {}, typing: async () => {} }, logger: () => {} });
faux.setResponses([fauxAssistantMessage("Hej!")]);
await handleChat(app, { message: encodeEvent({ id: "evt_onb", event_type: "imessage.received", timestamp: new Date().toISOString(), data: { message: { id: "msg_onb", conversation_id: "conv_owner", remote_number: OWNER, content: "Hej!", is_group: false, participants: [OWNER] } } }), conversation_id: "conv_owner" });
for (let i = 0; i < 50 && captured.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
const first = captured[0]?.messages?.find((m) => m.role === "system");
if (!first) throw new Error("could not capture the system prompt");
rmSync(dir, { recursive: true, force: true });
const SYSTEM = first.content;
const TOOLS = first.toolsAdded.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
// The welcome note the runtime put in front of the first text ([sunshine:onboarding]), exactly as sent.
const textOfMsg = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));
const WELCOME = captured[0].messages.find((m) => m.role === "user" && textOfMsg(m).includes("[Not a message from"));
console.log(`friend's agent: ${TOOLS.length} tools, instructions ${SYSTEM.length} characters, welcome note: ${WELCOME ? `${textOfMsg(WELCOME).length} characters` : "MISSING"}`);
if (process.env.DRY) {
  console.log(`owner named: ${SYSTEM.includes("Åsa Lindqvist")}; apps line: ${SYSTEM.match(/- Apps[^\n]*/)?.[0] ?? "none"}`);
  console.log(`tools include apps_connect: ${TOOLS.some((t) => t.name === "apps_connect")}, watch_profile_update: ${TOOLS.some((t) => t.name === "watch_profile_update")}, load_skill: ${TOOLS.some((t) => t.name === "load_skill")}`);
  console.log(`--- welcome note\n${WELCOME ? textOfMsg(WELCOME) : "(none)"}`);
  process.exit(0);
}
if (!WELCOME) throw new Error("no welcome note in front of the first text");

// Search results that fit what was searched for. (A first version answered every search with the same
// news, and a hotel search "only gave unrelated news results": an artifact of the test.)
const SEARCHES = [
  [/hotel|hotell|lisbo|lissabon|alfama|boende|stay/i, "1. Booking.com, Alfama, 22-25 Oct: Memmo Alfama (4*, rooftop pool) from €210/night; Lisbon Story Guesthouse from €95/night; Alfama Patio Hostel private room from €70/night.\n2. Time Out Lisboa: Alfama is hilly with narrow streets; Graça and Baixa next door are quieter and flatter, 10 minutes' walk away."],
  [/djurgården|dif|hockey|shl/i, "1. Expressen, 15 Oct 2026: Djurgården beat Färjestad 4-2 at Hovet; Jacob Josefson scored twice. DIF are third in the SHL.\n2. Aftonbladet: next game Saturday away at Frölunda."],
  [/startup|breakit|tech|ai\b|artificial|fintech/i, "1. Breakit, 14 Oct 2026: Stockholm AI startup Lovable raises a new round at a $4bn valuation; plans to hire 200 in Sweden.\n2. DI Digital, 13 Oct 2026: Swedish tech layoffs slow in Q3; fintech hiring picks up again."],
  [/weather|väder|vädret/i, "SMHI, Stockholm: Friday 16 Oct, cloudy, 9°C, light rain from 15:00. Weekend dry, 7-10°C."],
];
const searchFor = (args) => {
  const q = JSON.stringify(args ?? {});
  return SEARCHES.find(([re]) => re.test(q))?.[1] ?? "No useful results.";
};
const toolResult = (c) => {
  if (c.name === "load_skill") {
    try { return readFileSync(join(SKILLS, String(c.arguments?.name ?? ""), "SKILL.md"), "utf8"); } catch { return "No such skill."; }
  }
  if (c.name === "apps_connect") return `Apps are not set up on this agent, so there is no sign-in link for ${String(c.arguments?.toolkit ?? "that app")} yet. Tell you in one sentence: the person running the agent needs to set COMPOSIO_API_KEY (free at composio.dev) and restart it; after that you can text a link that connects it in one tap.`;
  if (c.name === "web_search" || c.name === "web_fetch") return searchFor(c.arguments);
  if (c.name === "react") return "Reacted. Now write your reply.";
  if (["memory_write", "watch_profile_update", "watch_settings", "journal_append"].includes(c.name)) return "Saved.";
  if (c.name === "schedule_create") return "Scheduled.";
  return "Done.";
};

// The friend, played by Haiku. "Busy" uses a fixed second message, since any first text fits it.
const ASA = "You are Åsa Lindqvist, 29, living on Södermalm in Stockholm. You work in marketing at a fintech. You follow Djurgården hockey, Swedish tech startups and AI news, and you love cooking. Next week you fly to Lisbon for a friend's 30th. A friend told you about Sunshine, an assistant you text; you just signed up and connected it, out of curiosity. You text like you do with friends: short, casual Swedish, mostly lowercase, no emojis. Answer what you are asked, sometimes with one small extra detail. Write only your next text message, nothing else.";
const RUNS = [
  { name: "curious, writes Swedish", opener: "Hej!", replies: 2 },
  { name: "busy, opens in English", opener: "hi, who is this?", fixed: ["sorry, at work, can't really talk now"] },
];

const now = new Date();
const stamped = (text) => `${timeStamp(now, TZ)}\n${text}`;
const ASKS_NAME = /vad heter du|vad ska jag kalla dig|ditt namn|what('s| is) your name|what should i call you|your name\?/i;
const ASKS_TIMEZONE = /tidszon|time ?zone/i;
const APPS = /gmail|kalender|calendar|composio|COMPOSIO_API_KEY|koppla|connect (your|an) app/i;
const PEOPLE = /partner|sambo|familj|family|pojkvän|flickvän|syskon|föräldrar|parents/i;
const SWEDISH = /\b(jag|du|och|det|är|vad|för|med|inte|kan|hej)\b/i;
let cost = 0;
const summary = [];

for (const run of RUNS) {
  console.log(`\n===== ${run.name}`);
  const messages = [WELCOME, { role: "user", content: stamped(run.opener), timestamp: Date.now() }];
  const transcript = [`Åsa: ${run.opener}`];
  const texts = [];
  const tools = [];
  const turns = 1 + (run.replies ?? run.fixed.length);
  for (let turn = 0; turn < turns; turn++) {
    console.log(`\n  Åsa: ${messages.at(-1).content.split("\n").slice(1).join(" ")}`);
    let text = "";
    for (let step = 0; step < 6; step++) {
      const reply = await completeSimple(sonnet, { systemPrompt: SYSTEM, messages, tools: TOOLS }, { apiKey, reasoning: "medium" });
      cost += reply.usage?.cost?.total ?? 0;
      messages.push(reply);
      const calls = reply.content.filter((c) => c.type === "toolCall");
      text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
      if (calls.length === 0) break;
      for (const c of calls) {
        tools.push(c.name === "load_skill" ? `load_skill:${c.arguments?.name}` : c.name);
        messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: toolResult(c) }], isError: false, timestamp: Date.now() });
      }
    }
    texts.push(text);
    transcript.push(`Sunshine: ${text}`);
    const flags = [
      ASKS_NAME.test(text) && "ASKS NAME", ASKS_TIMEZONE.test(text) && "ASKS TIMEZONE", (text.match(/\?/g) ?? []).length > 1 && "MORE THAN ONE QUESTION",
      APPS.test(text) && "APPS", PEOPLE.test(text) && "PARTNER/FAMILY",
    ].filter(Boolean);
    console.log(`  Sunshine (${text.length} chars${flags.length ? `, ${flags.join(", ")}` : ""}): ${text.replace(/\n/g, " / ")}`);
    if (turn === turns - 1) break;
    let next;
    if (run.fixed) next = run.fixed[turn];
    else {
      const sim = await completeSimple(haiku, { systemPrompt: ASA, messages: [{ role: "user", content: `Your texts with Sunshine so far:\n\n${transcript.join("\n")}\n\nWrite your next text to Sunshine.`, timestamp: Date.now() }] }, { apiKey });
      cost += sim.usage?.cost?.total ?? 0;
      next = sim.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim().replace(/^Åsa:\s*/i, "");
    }
    transcript.push(`Åsa: ${next}`);
    messages.push({ role: "user", content: stamped(next), timestamp: Date.now() });
  }
  console.log(`\n  tools used: ${tools.join(", ") || "none"}`);
  const all = texts.join("\n");
  summary.push(
    `${run.name}: ${texts.length} texts, avg ${Math.round(all.length / texts.length)} chars; name used ${/Åsa/.test(texts[0] ?? "") ? "yes" : "no"}; ` +
      `asked name ${texts.filter((t) => ASKS_NAME.test(t)).length}, timezone ${texts.filter((t) => ASKS_TIMEZONE.test(t)).length}, >1 question ${texts.filter((t) => (t.match(/\?/g) ?? []).length > 1).length}, apps ${texts.filter((t) => APPS.test(t)).length}, partner/family ${texts.filter((t) => PEOPLE.test(t)).length}; ` +
      `Swedish texts ${texts.filter((t) => SWEDISH.test(t)).length}/${texts.length}; onboarding skill opened: ${tools.includes("load_skill:onboarding") ? "yes" : "no"}`,
  );
}
console.log(`\n===== summary\n${summary.join("\n")}\nCost: $${cost.toFixed(4)}`);
process.exit(0);
