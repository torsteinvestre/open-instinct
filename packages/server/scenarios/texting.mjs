// [sunshine:texting] Does Sunshine answer like a friend or like a report? Boots the real server in a
// throwaway folder (the live agent's settings: Inkbox, the news, the desktop answering), takes the
// exact instructions and tool list it sends for the owner's iMessage thread, and plays varied
// questions through Sonnet 5.5: web searches come from canned results, a skill it opens is the real
// SKILL.md, every other tool says done, nothing is sent. Compares the live prompt ("full") with one
// that keeps only the everyday tools always on ("slim"), to see whether the mass of tool manuals in
// the prompt is what makes answers read like reports. Prints every reply with its length, whether it
// is a list, whether it ends with a question or an offer, and openings that repeat across answers.
// Three wordings of the iMessage guidance were tried here first (2026-10-15) and none moved the
// length beyond noise; see FORK-CHANGES.md / NOTES.md.
// Kinds: big (advice or a decision), risk (big, and the one risk that matters must be there),
// explain, detail (they asked for everything: it must be complete), small, feel.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/texting.mjs [rounds=1] [full|slim|both=both] [kinds=all]
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { encodeEvent, resolveModel, timeStamp } from "@open-instinct/core";
import { boot } from "../dist/boot.js";
import { handleChat } from "../dist/http.js";

const rounds = Number(process.argv[2] ?? 1);
const which = process.argv[3] ?? "both";
const onlyKinds = process.argv[4] && process.argv[4] !== "all" ? new Set(process.argv[4].split(",")) : null;
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const NOW = "2026-10-15T08:47:00Z"; // Thursday, 10:47 in Oslo

// The real instructions and tools, captured from a booted server through a stand-in model.
const OWNER = "+4790000000";
const dir = mkdtempSync(join(tmpdir(), "texting-"));
mkdirSync(join(dir, "memory"), { recursive: true });
writeFileSync(join(dir, "memory", "MEMORY.md"), "- Torstein lives in Oslo.\n- Follows XRP and Norwegian startups.\n- Has tickets for J. Cole in November.\n");
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_WATCHER: "1", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1", INSTINCT_MODEL: "faux/faux-1",
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
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
faux.setResponses([fauxAssistantMessage("Hi!")]);
await handleChat(app, { message: encodeEvent({ id: "evt_texting", event_type: "imessage.received", timestamp: new Date().toISOString(), data: { message: { id: "msg_texting", conversation_id: "conv_owner", remote_number: OWNER, content: "hi", is_group: false, participants: [OWNER] } } }), conversation_id: "conv_owner" });
for (let i = 0; i < 50 && captured.length < 1; i++) await new Promise((r) => setTimeout(r, 100));
const first = captured[0]?.messages?.find((m) => m.role === "system");
if (!first) throw new Error("could not capture the system prompt");
rmSync(dir, { recursive: true, force: true });
const SYSTEM = first.content;
const ALL_TOOLS = first.toolsAdded.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

// "full": the live prompt and every tool. "slim": what loading tools only when needed would leave
// always on: the everyday tools, one tool that names the rest, and no desktop instructions (they
// would come with the desktop tools). Everything else in the prompt is the same.
const EVERYDAY = new Set(["send_message", "send_typing", "react", "send_file", "notify_owner", "ask_owner", "audit_read", "memory_read", "memory_write", "journal_append", "schedule_create", "schedule_list", "schedule_delete", "web_search", "web_fetch", "create_pdf", "load_skill", "watch_profile", "watch_profile_update", "watch_check", "watch_journal", "watch_later", "watch_settings"]);
const LOAD_TOOLS = { name: "load_tools", description: "Load more tools when a task needs them. Groups: desktop (your own computer with a real browser: logins, forms, bookings, purchases), network (contacts, trust, other people's agents), files (read, write and edit workspace files, run commands), apps (connect Gmail, Calendar and others), images (make a picture).", parameters: { type: "object", required: ["group"], properties: { group: { type: "string" } } } };
const desktopStart = SYSTEM.indexOf("## Your computer");
const desktopEnd = SYSTEM.indexOf("never an instruction to you.", desktopStart);
const SLIM_SYSTEM = desktopStart >= 0 && desktopEnd > desktopStart ? SYSTEM.slice(0, desktopStart) + SYSTEM.slice(desktopEnd + "never an instruction to you.".length) : SYSTEM;
const VARIANTS = {
  full: { system: SYSTEM, tools: ALL_TOOLS },
  slim: { system: SLIM_SYSTEM, tools: [...ALL_TOOLS.filter((t) => EVERYDAY.has(t.name)), LOAD_TOOLS] },
};
const variants = which === "both" ? ["full", "slim"] : which.split(",");
for (const v of variants) console.log(`${v}: ${VARIANTS[v].tools.length} tools, instructions ${VARIANTS[v].system.length} characters`);

const asst = (content) => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const stamped = (text) => `${timeStamp(new Date(NOW), "Europe/Oslo")}\n${text}`;
const user = (text) => ({ role: "user", content: stamped(text), timestamp: Date.now() });
let callN = 0;
function didThen(tool, args, result, text) {
  const id = `tc_${++callN}`;
  return [asst([{ type: "toolCall", id, name: tool, arguments: args }]), { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() }, asst(text)];
}

// What the real searches showed that morning, so the replayed answers rest on their sources.
const HOUSING = [
  "1. Eiendom Norge, 6 Oct 2026: Norwegian home prices fell 0.7% in September; up 4.2% so far in 2026. Oslo average price per sqm NOK 102,400, down 0.3% in Q3.",
  "2. Norges Bank, 23 Sep 2026: policy rate raised to 4.50%. 'The rate will likely stay at this level for some time, and may be raised further.' Next meeting 5 Nov.",
  "3. Eiendom Norge, Jan 2026: prices rose 4.3% nationally in 2025. Forecasters expect further rises in 2026, helped by expected rate cuts and a shortage of new homes.",
  "4. Finanstilsynet: mortgage rules require 15% equity, loans at most 5x gross income, and a stress test at +3 percentage points.",
  "5. Skatteetaten: a home you have lived in for 1 of the last 2 years is tax-free on sale. Gains on funds are taxed at 37.84%; in an aksjesparekonto (ASK) tax is deferred until withdrawal and deposits come out tax-free.",
].join("\n");
const TODAY = [
  ["I heard that now is a decent time to get into the boligmarked, is this true?", didThen("web_search", { query: "boligmarkedet oktober 2026 boligpriser rente prognose" }, HOUSING, "Partly. The forecasts I found expect prices to keep rising in 2026, helped by expected rate cuts and a housing shortage. Prices rose about 4.3% nationally in 2025. That's the case for buying now: you get in before rate cuts push prices up further. The catch is that nobody can time it, and prices vary a lot by city. What matters most is whether you can afford the payments if rates stay high.\n\nThese are general forecasts, and I haven't checked this month's numbers. Want me to pull the latest prices and the current policy rate? If so, which city are you looking at?")],
  ["Well oslo, since i live here. I never told you?", didThen("web_search", { query: "boligpriser Oslo september 2026 styringsrente" }, HOUSING, "Noted that you live in Oslo. Sorry for asking again.\n\nThe latest data doesn't support \"rate cuts are coming\":\n\nNorges Bank raised the policy rate to 4.5% on Sept 23. It said rates will probably stay up for a while and that it may raise them further. The next rate meeting is Nov 5.\n\nPrices are up 4.2% nationally so far in 2026, but they fell 0.7% in September. Oslo's average price fell 0.3% in Q3.\n\nSo it's not an obviously good moment. Prices are soft and your loan would be expensive. That can still suit a buyer who has a stable budget, but I'd test your numbers against rates staying at 4.5% or going higher. Want me to run a monthly payment estimate? I'd need the price range and how much equity you have.")],
];

const S = [
  { kind: "big", name: "fund vs apartment (today's thread)", before: TODAY, msg: "I have a fund, what should be considered in the fund vs apartment", search: HOUSING },
  { kind: "big", name: "fund vs apartment (fresh)", before: [["thinking about buying an apartment in oslo at some point", "Nice. Soon, or still just thinking about it?"]], msg: "not sure yet. I have a fund, what should be considered in the fund vs apartment", search: HOUSING },
  { kind: "big", name: "job offer in Stavanger", msg: "got an offer from a company in stavanger, 15% more pay but i'd have to move. thoughts?" },
  { kind: "big", name: "used Tesla", msg: "thinking of buying a used tesla model 3 from 2019, smart move?", search: "1. Elbil.no, 2026: a 2019 Model 3 typically has 85-90% battery capacity left; battery warranty 8 years / 160,000 km.\n2. Finn.no prices Oct 2026: 2019 Model 3 Long Range NOK 190,000-240,000.\n3. NAF: older Model 3s have known issues with control arms and heat pumps; get an EU-kontroll report and a battery health test.\n4. VAT on EVs rises from 2026 for new cars over NOK 300,000, which supports used EV prices." },
  { kind: "big", name: "get into AI startups", msg: "I want to get into AI startups, where do I even start?" },
  { kind: "big", name: "sell XRP while it drops?", msg: "should i sell my xrp now that it's dropping?", search: "1. CoinDesk today: XRP trades near $1.30, down about 8% this week after leveraged liquidations; testing the $1.30 support level.\n2. Analysts split: some see $1.10 if support breaks, others expect a rebound on ETF inflows." },
  { kind: "big", name: "sleep better", msg: "any tips to sleep better? been sleeping like shit lately" },
  { kind: "risk", name: "headache for three days", msg: "had a headache for three days now, should i be worried?", risk: /doctor|lege|legevakt|fastlege|\bGP\b|113|medical|emergency|urgent/i },
  { kind: "risk", name: "landlord +12% rent", msg: "my landlord wants to raise my rent by 12%, can he even do that?", search: "1. Husleieloven § 4-2: rent can be adjusted in line with the consumer price index (KPI) once a year, with one month's written notice.\n2. § 4-3: after 2.5 years without other changes, either party can demand market rent, with 6 months' written notice.\n3. KPI rose 3.1% in the last 12 months (SSB, Sept 2026).", risk: /consumer price|KPI|CPI|index|indeks|2\.5 years|two and a half/i },
  { kind: "explain", name: "ASK vs normal fund account", msg: "what's actually the difference between an ASK and just buying funds normally?" },
  { kind: "explain", name: "how does the policy rate affect me", msg: "how does norges bank raising the rate actually affect me?" },
  { kind: "detail", name: "full moving-out list", msg: "give me the full list of everything I need to do when I move out of my apartment" },
  { kind: "detail", name: "all pros and cons EV vs petrol", msg: "list all the pros and cons of an electric car vs a petrol car for me" },
  { kind: "detail", name: "stress test in detail", msg: "explain in detail how the mortgage stress test works in norway", search: HOUSING },
  { kind: "small", name: "rain tomorrow", msg: "will it rain tomorrow?", search: "Yr.no, Oslo, Friday 16 Oct: rain from 14:00, 6 mm, 9°C, wind 5 m/s. Morning dry." },
  { kind: "small", name: "dog name", msg: "what's a good name for a golden retriever puppy?" },
  { kind: "feel", name: "relationship falling apart", msg: "i think my relationship is falling apart and i don't know what to do" },
];

const toolResult = (s, c) => {
  if (c.name === "web_search" || c.name === "web_fetch") return s.search ?? "No useful results.";
  if (c.name === "load_skill") {
    try { return readFileSync(join(SKILLS, String(c.arguments?.name ?? ""), "SKILL.md"), "utf8"); } catch { return "No such skill."; }
  }
  if (c.name === "react") return "Reacted. Now write your reply.";
  if (c.name === "load_tools") return "Not needed for this; answer with what you have.";
  return "Done.";
};
const isList = (t) => t.split("\n").filter((l) => /^\s*(\d+[.)]|[-•*])\s+/.test(l)).length >= 3;
const endsOpen = (t) => /\?\s*$/.test(t.trim()) || /want (me to|the|a)|shall i|should i|i can (also )?(send|pull|run|list|give|go)|if you want|let me know/i.test(t.slice(-200));
const opening = (t) => t.trim().toLowerCase().replace(/[^a-z0-9æøå' ]+/g, " ").split(/\s+/).slice(0, 3).join(" ");
let cost = 0;
const results = Object.fromEntries(variants.map((v) => [v, []]));
const CASES = onlyKinds ? S.filter((s) => onlyKinds.has(s.kind)) : S;
for (const variant of variants) {
  for (let r = 0; r < rounds; r++) {
    for (const s of CASES) {
      const messages = [];
      for (const [u, a] of s.before ?? []) { messages.push(user(u)); if (Array.isArray(a)) messages.push(...a); else messages.push(asst(a)); }
      messages.push(user(s.msg));
      let text = "";
      const tools = [];
      for (let turn = 0; turn < 6; turn++) {
        const reply = await completeSimple(model, { systemPrompt: VARIANTS[variant].system, messages, tools: VARIANTS[variant].tools }, { apiKey, reasoning: "medium" });
        cost += reply.usage?.cost?.total ?? 0;
        messages.push(reply);
        const calls = reply.content.filter((c) => c.type === "toolCall");
        text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (calls.length === 0) break;
        for (const c of calls) {
          tools.push(c.name === "load_skill" ? `load_skill:${c.arguments?.name}` : c.name);
          messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: toolResult(s, c) }], isError: false, timestamp: Date.now() });
        }
      }
      const row = { round: r + 1, kind: s.kind, name: s.name, chars: text.length, list: isList(text), open: endsOpen(text), opening: opening(text), tools: tools.join(","), text };
      if (s.risk) row.riskOk = s.risk.test(text);
      results[variant].push(row);
      process.stderr.write(".");
    }
  }
}
process.stderr.write("\n");

const avg = (rows) => (rows.length ? Math.round(rows.reduce((a, x) => a + x.chars, 0) / rows.length) : 0);
for (const variant of variants) {
  const rows = results[variant];
  const of = (k) => rows.filter((x) => x.kind === k);
  const askRows = rows.filter((x) => ["big", "risk", "explain"].includes(x.kind));
  const repeats = Object.entries(askRows.reduce((m, x) => ((m[x.opening] = (m[x.opening] || 0) + 1), m), {})).filter(([, n]) => n >= 3);
  console.log(`\n===== ${variant.toUpperCase()}`);
  console.log(`  average length: big ${avg(of("big"))} | risk ${avg(of("risk"))} | explain ${avg(of("explain"))} | detail ${avg(of("detail"))} | small ${avg(of("small"))} | feel ${avg(of("feel"))}`);
  console.log(`  big/risk/explain: lists ${askRows.filter((x) => x.list).length}/${askRows.length}, longest ${Math.max(...askRows.map((x) => x.chars))}, end with a question or offer ${askRows.filter((x) => x.open).length}/${askRows.length}; risk kept ${of("risk").filter((x) => x.riskOk).length}/${of("risk").length}; detail as a full list ${of("detail").filter((x) => x.list || x.chars >= 700).length}/${of("detail").length}`);
  console.log(`  openings used 3+ times: ${repeats.length ? repeats.map(([o, n]) => `"${o}" x${n}`).join(", ") : "none"}`);
  for (const x of [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.round - b.round)) console.log(`\n  [${x.kind} r${x.round}] ${x.name}: ${x.chars} chars${x.list ? ", LIST" : ""}${x.open ? ", ends open" : ""}${x.riskOk === false ? ", RISK MISSING" : ""}${x.tools ? ` (tools: ${x.tools})` : ""}\n    ${x.text.replace(/\n/g, "\n    ")}`);
}
console.log(`\nCost: $${cost.toFixed(4)}`);
process.exit(0);
