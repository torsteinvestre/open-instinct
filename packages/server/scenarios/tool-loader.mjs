// [sunshine:tool-loader] Does Sunshine load a tool group when a request needs one, and only then?
// Boots the real server in a throwaway folder with the owner's live settings (the news on, the
// desktop answering, Gmail and Calendar through Composio's router with the real tool definitions,
// shown as connected; a few facts in memory so no welcome note), then plays one text per case
// through the real runtime and Sonnet 5.5, each in a thread of its own. Every tool except load_tools
// and load_skill answers from a script (nothing reaches Gmail, a desktop or anyone's phone).
// Per case: did it load the right group before answering, did it load anything it did not need, did
// a reply say it could not do something, or mention loading? And per model call: what was read from
// and written to the prompt cache (after a load the start should still be read back).
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY and COMPOSIO_API_KEY set):
//   node scenarios/tool-loader.mjs [rounds] [case,case]   (all 18 cases, one round: about 40-60 cents)
//   MAX_USD=0.6 stops before the next case once the spend passes it. DRY=1 prints the tool list: free.
//   NOT_CONNECTED=1: Gmail and Calendar are set up but not connected yet, as for a new friend; the apps
//   cases then also need the sign-in link in the reply (cases connect,inbox,calendar,addevent).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComposioApps } from "@open-instinct/apps";
import { boot } from "../dist/boot.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const composioKey = process.env.COMPOSIO_API_KEY?.trim();
if (!apiKey || !composioKey) throw new Error("ANTHROPIC_API_KEY and COMPOSIO_API_KEY must be set");
const ROUNDS = Number(process.argv[2] ?? 1);
const PICK = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const MAX_USD = Number(process.env.MAX_USD ?? 0.7);
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";

// Shown as connected, as on the owner's agent, or not yet (NOT_CONNECTED=1, a new friend); nothing is
// asked of Composio about a real account.
const NOT_CONNECTED = Boolean(process.env.NOT_CONNECTED);
const LINK = "https://connect.composio.dev/link/lk_test_7Hq2";
ComposioApps.prototype.connectedToolkits = async function () {
  return [{ slug: "gmail", connected: !NOT_CONNECTED }, { slug: "googlecalendar", connected: !NOT_CONNECTED }];
};

const dir = mkdtempSync(join(tmpdir(), "tool-loader-"));
mkdirSync(join(dir, "memory"), { recursive: true });
writeFileSync(join(dir, "memory", "MEMORY.md"), "## About\n- Torstein lives in Oslo.\n- Has an ASK fund at Nordnet (about 1.5M NOK).\n\n## People\n- Sanna: girlfriend.\n- Martin: friend from work.\n");
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_WATCHER: "1", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1",
  INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-loader-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  BRAVE_SEARCH_API_KEY: "dummy", COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
};
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
  if (/composio/.test(url)) return realFetch(input, init); // the router's tool definitions
  throw new Error(`offline: ${url}`);
};
const sent = [];
const app = await boot(env, { fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {} }, logger: () => {} });
const { registry } = app.runtime.deps;

// Scripted answers for every tool but load_tools and load_skill.
const EMAILS = "1. Nordnet (today 08:12): Your monthly statement for September is ready.\n2. Martin Berg (yesterday 21:40): Dinner Friday at 19:00? Bring the board game.\n3. Ticketmaster (yesterday 14:03): Your J. Cole tickets, order 23-48112, Oslo Spektrum 21 Nov.";
const EVENTS = "Fri 23 Oct: 09:00-09:30 Standup; 12:00-13:00 Lunch with Sanna; 17:30 Dentist (Grünerløkka Tannlegesenter).";
function scripted(name, args) {
  const a = JSON.stringify(args ?? {});
  if (NOT_CONNECTED) {
    const app = /calendar/i.test(a) ? "googlecalendar" : "gmail";
    if (name === "apps_list" || (name === "app_composio_manage_connections" && !/connect|initiate|link|add/i.test(a))) return "Not connected: gmail, googlecalendar.";
    if (name === "apps_connect" || name === "app_composio_manage_connections") return `Connect link for ${app}: ${LINK} . Send it to the owner; they open it and sign in with Google.`;
    if (name === "app_composio_multi_execute_tool") return `Error: no connected account for ${app}. The owner has to connect it first (apps_connect).`;
  }
  if (name === "app_composio_search_tools") return /calendar|event|appointment|dentist/i.test(a)
    ? "GOOGLECALENDAR_EVENTS_LIST: list events in a time range (calendar_id, time_min, time_max)\nGOOGLECALENDAR_PATCH_EVENT: change an event (event_id, start, end)\nGOOGLECALENDAR_CREATE_EVENT: create an event"
    : "GMAIL_FETCH_EMAILS: list recent emails (max_results, query)\nGMAIL_SEND_EMAIL: send an email (recipient_email, subject, body)\nGMAIL_CREATE_EMAIL_DRAFT: draft an email";
  if (name === "app_composio_get_tool_schemas") return "Schemas as listed; all arguments are strings unless noted.";
  if (name === "app_composio_multi_execute_tool") return /CALENDAR/i.test(a) ? (/PATCH|CREATE/i.test(a) ? "Done: the event was updated." : EVENTS) : /SEND|DRAFT/i.test(a) ? "Done: sent." : EMAILS;
  if (name === "app_composio_manage_connections" || name === "apps_list") return "Connected: gmail, googlecalendar.";
  if (name === "apps_connect") return "gmail is already connected.";
  if (name === "computer" || name === "computer_batch") return "Screenshot taken: Chromium is open on a blank tab (1280x800).";
  if (name === "request_takeover" || name === "takeover_status") return "Takeover requested; waiting for the owner.";
  if (name.startsWith("computer_")) return "Done.";
  if (name === "create_pdf") return "Wrote /data/workspace/briefs/list.pdf (2.1 KB, 1 page).";
  if (name === "ls") return "briefs/\n  smoke.pdf\nnotes.md";
  if (name === "read" || name === "grep") return "notes.md: shopping: milk, coffee.";
  if (["write", "edit", "bash"].includes(name)) return "Done.";
  if (name === "image_generate") return "Image generation is not set up on this agent.";
  if (name === "contacts_search" || name === "trust_list") return "Sanna Holm: partner, +47 912 34 567. Mom (Kari): family, +47 934 56 789. Martin Berg: friend.";
  if (name.startsWith("contacts_") || name.startsWith("trust_")) return "Saved.";
  if (name === "ask_instinct") return "Asked Sanna's assistant; the answer comes back here.";
  if (name === "invite_to_network") return "Invite sent.";
  if (name === "web_search") return /weather|vær/i.test(a) ? "yr.no: Oslo tomorrow: 8°C, light rain from 14:00." : /xrp|ripple/i.test(a) ? "CoinDesk, today: XRP at $1.31, up 2% after an ETF filing update." : "No useful results.";
  if (name === "web_fetch") return "Page text: (nothing relevant)";
  if (name === "history_search") return "Thu 15 Oct, you: 'I have a fund, what should be considered in the fund vs apartment?' Reply: 'Main points: tax on the ASK when you take money out, ...'";
  if (name === "schedule_create") return "Scheduled: one text in 20 minutes (Fri 16 Oct, 16:40 Europe/Oslo).";
  if (name === "schedule_list") return "No reminders.";
  if (name.startsWith("watch_")) return "Nothing new since the last check.";
  if (name.startsWith("memory_") || name === "journal_append") return "Saved.";
  if (name === "send_file") return "Sent.";
  if (name === "react") return "Reacted.";
  return "Done.";
}
for (const t of registry.all()) {
  if (t.spec.name === "load_tools" || t.spec.name === "load_skill") continue;
  const name = t.spec.name;
  t.spec.execute = async (args) => scripted(name, args);
}

const base = registry.all().filter((t) => !["apps", "computer", "files", "contacts", "network"].includes(t.spec.meta.group)).map((t) => t.spec.name);
console.log(`base tools (${base.length}): ${base.join(", ")}`);
if (process.env.DRY) {
  console.log(`\nload_tools:\n${registry.get("load_tools")?.spec.description}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const CASES = [
  // Needs a group.
  { key: "connect", group: "apps", text: "can you connect to my gmail?" },
  { key: "addevent", group: "apps", text: "put dentist on friday at 15:00 in my calendar" },
  { key: "inbox", group: "apps", text: "check my inbox, anything important?" },
  { key: "calendar", group: "apps", text: "what's on my calendar on friday?" },
  { key: "email", group: "apps", text: "email Martin that I'll be 10 min late on friday" },
  { key: "move", group: "apps", text: "can you move my dentist appointment on friday to 16:00?" },
  { key: "form", group: "computer", text: "go to example.com in your browser and fill in their contact form with my name and number" },
  { key: "screenshot", group: "computer", text: "take a screenshot of your desktop and tell me what's open" },
  { key: "pdf", group: "files", text: "make me a PDF packing list for a weekend in Bergen" },
  { key: "files", group: "files", text: "what files do you have saved?" },
  { key: "partner", group: "people", text: "my mom Kari's number is +47 934 56 789, save her as family" },
  { key: "cansee", group: "people", text: "what can Sanna see about me?" },
  { key: "askagent", group: "people", text: "ask Sanna's assistant if she's free saturday evening" },
  { key: "contacts", group: "people", text: "who do you have in my contacts?" },
  // Needs none.
  { key: "math", group: null, text: "what's 15% of 2340?" },
  { key: "remind", group: null, text: "remind me in 20 minutes to call mom" },
  { key: "weather", group: null, text: "what's the weather in Oslo tomorrow?" },
  { key: "thanks", group: null, text: "thanks!" },
  { key: "past", group: null, text: "what did I ask you about my fund last week?" },
  { key: "xrp", group: null, text: "anything new on XRP today?" },
].filter((c) => !PICK || PICK.has(c.key));

const CANT = /\b(can't|cannot|can not|don't have (access|a way)|not able to|unable to|no access)\b/i;
const MACHINERY = /\bload(ed|ing)?\b.*\btools?\b|\btools?\b.*\bload(ed|ing)?\b/i;
let cost = 0;
const rows = [];
outer: for (let round = 1; round <= ROUNDS; round++) {
  for (const c of CASES) {
    if (cost > MAX_USD) { console.log(`\nStopped: spent $${cost.toFixed(3)}, over MAX_USD ${MAX_USD}.`); break outer; }
    const key = `imessage:loader_${c.key}_${round}`;
    sent.length = 0;
    await app.runtime.handleInbound({ id: `evt_${c.key}_${round}`, channel: "imessage", from: OWNER, conversationKey: key, text: c.text, replyRef: {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
    const conv = app.runtime.conversation(key, app.runtime.ownerPrincipal());
    const msgs = conv.agent.state.messages;
    const calls = msgs.flatMap((m) => (m.role === "assistant" ? m.content.filter((x) => x.type === "toolCall") : []));
    const loads = calls.filter((x) => x.name === "load_tools").flatMap((x) => x.arguments?.groups ?? []);
    const used = calls.map((x) => x.name).filter((n) => n !== "load_tools");
    const usage = msgs.filter((m) => m.role === "assistant" && m.usage).map((m) => m.usage);
    const spent = usage.reduce((s, u) => s + (u.cost?.total ?? 0), 0);
    cost += spent;
    const reply = sent.map((m) => m.text).filter(Boolean).join(" / ") || "(nothing sent)";
    // Not connected yet: loading is not enough, the reply has to carry the sign-in link.
    const linked = !(NOT_CONNECTED && c.group === "apps") || reply.includes(LINK);
    const right = (c.group ? loads.includes(c.group) : loads.length === 0) && linked;
    const flags = [!linked && "NO SIGN-IN LINK", !(c.group ? loads.includes(c.group) : loads.length === 0) && (c.group ? `DID NOT LOAD ${c.group}` : `NEEDLESS LOAD ${loads.join(",")}`), CANT.test(reply) && "SAYS CAN'T", MACHINERY.test(reply) && "MENTIONS LOADING", c.group && loads.some((g) => g !== c.group) && `also loaded ${loads.filter((g) => g !== c.group).join(",")}`].filter(Boolean);
    rows.push({ round, key: c.key, group: c.group, right, flags });
    console.log(`\n[${round}] ${c.key} (${c.group ?? "no group"}): ${right ? "ok" : "MISS"}${flags.length ? ` (${flags.join("; ")})` : ""}  $${spent.toFixed(4)}`);
    console.log(`  Torstein: ${c.text}`);
    console.log(`  tools: ${calls.map((x) => (x.name === "load_tools" ? `load_tools(${(x.arguments?.groups ?? []).join(",")})` : x.name)).join(" -> ") || "none"}`);
    console.log(`  cache per call (read/written): ${usage.map((u) => `${u.cacheRead}/${u.cacheWrite}`).join("  ")}`);
    console.log(`  Sunshine: ${reply.replace(/\n/g, " / ")}`);
  }
}
const need = rows.filter((r) => r.group);
const none = rows.filter((r) => !r.group);
console.log(`\n===== summary`);
console.log(`needed a group: loaded the right one ${need.filter((r) => r.right).length}/${need.length}`);
console.log(`needed none: no load ${none.filter((r) => r.right).length}/${none.length}`);
console.log(`replies saying it can't: ${rows.filter((r) => r.flags.includes("SAYS CAN'T")).length}; mentioning loading: ${rows.filter((r) => r.flags.includes("MENTIONS LOADING")).length}`);
console.log(`Cost: $${cost.toFixed(4)}`);
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
