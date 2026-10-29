// [sunshine:look-before-ask] Paid. The live failure of 2026-10-29 10:41Z, replayed: Torstein texted "Anything
// happening next week for me"; Sunshine read his calendar (empty), then answered "The 3 Nov event you mentioned isn't
// in it. Want me to add it if you give me the details?" though the details were in his email (the Founders Story
// guestlist email of 17 Oct). The question: why does it ask instead of finding out, and what changes that?
//
// Real conditions kept: the real server and prompt at this version, booted on a LOCAL COPY of his agent's chat state
// (snapshot-chat.sh: thread, persona, config, memory notes, journal, chat archive, kept items; the thread cut just
// before that text), the live settings (watcher, desktop, Composio router with the real tool definitions shown as
// connected, meaning search), Sonnet 5.5 at the live thinking level. Stand-ins: every tool except load_tools and
// load_skill answers from a script. The calendar answers as his did (empty 2-8 Nov; J. Cole on 12 Nov); the inbox
// finds the Founders Story email only when a search would match it (as Gmail would; its time and place are made up),
// and a plain "newest emails" list does not reach back to 17 Oct. Nothing reaches Gmail, the web or anyone's phone; no
// scheduled job runs.
//
// Pass: the reply names Founders Story and does not ask him for the event's details.
//
// Usage (from packages/server, after `pnpm build`; ANTHROPIC_API_KEY and COMPOSIO_API_KEY set):
//   SNAPSHOT=~/sunshine-memory/repro-2026-10-29/data RUNS=3 MAX_USD=0.22 node scenarios/look-before-ask.mjs
//   THINKING=high          a different thinking level than the live one (config.model.thinking)
//   NO_OLD_QUESTIONS=1     its two earlier "What is the 3 Nov event?" questions taken out of the thread (diagnostic)
//   GROUND=off             without the grounding step ([sunshine:grounding], 2026-10-29); on by default in a version
//                          that has it, with the same stand-in email and calendar
//   DRY=1                  checks the check on known answers (the live reply among them); no model call
// The first run cuts the snapshot once into <SNAPSHOT>-cut and stores its chats and kept items for meaning search there
// (as the live agent has them stored); later runs copy that.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- the check -----------------------------------------------------------------------------------------------------
const questions = (t) => t.split(/(?<=[.?!])\s+/).filter((s) => /\?\s*$/.test(s));
const ASKS_DETAILS = /\b(what|which)\b[^?]*\b(event|it)\b|\bdetails\b|\bwhat time\b|\bwhen is\b|\bwhere is\b/i;
function check(r) {
  const reply = r.texts.join("\n");
  const found = /founders/i.test(reply);
  const asked = questions(reply).some((q) => /3 nov|third|event|it\b/i.test(q) && ASKS_DETAILS.test(q));
  return { pass: found && !asked, notes: [r.searchedEmail ? "searched email" : "did NOT search email", found ? "named Founders Story" : "did not name it", asked ? "asked for the details" : "did not ask"] };
}

if (process.env.DRY) {
  const known = [
    [{ texts: ["Your calendar is empty for next week (2 to 8 Nov). The 3 Nov event you mentioned isn't in it. Want me to add it if you give me the details?"], searchedEmail: false }, false], // live, 10:41Z
    [{ texts: ["Next week: Founders Story Oslo on Tue 3 Nov at 18:00, Startup Lab (from your guestlist email of 17 Oct). It isn't in your calendar yet. Want me to add it?"], searchedEmail: true }, true],
    [{ texts: ["Added Founders Story Oslo (Tue 3 Nov, 18:00, Startup Lab) to your calendar from the guestlist email. Nothing else next week."], searchedEmail: true }, true],
    [{ texts: ["I found Founders Story Oslo on 3 Nov in your email, but no time. What time does it start?"], searchedEmail: true }, false],
    [{ texts: ["Nothing in your calendar next week. What's the event on 3 Nov?"], searchedEmail: false }, false],
  ];
  let ok = 0;
  for (const [r, want] of known) {
    const got = check(r);
    ok += got.pass === want;
    console.log(`${got.pass === want ? "ok   " : "WRONG"} ${got.pass ? "pass" : "fail"} (${got.notes.join("; ")}) <- ${r.texts[0].slice(0, 80)}`);
  }
  console.log(`${ok}/${known.length} known answers checked right`);
  process.exit(ok === known.length ? 0 : 1);
}

// ---- the stand-in inbox, calendar and other tools -----------------------------------------------------------------
const day = (s) => Date.parse(s);
const INBOX = [
  // The one that answers it. Subject as in his real inbox (2026-10-29 probe); time and place in the text made up.
  { id: "m_founders", from: "Google Events <no-reply-eventsatgoogle@google.com>", at: "2026-10-17T09:12:00Z", subject: "It’s official! You’re on the guestlist for Founders Story Oslo at Startup Lab", body: "Founders Story Oslo. Tuesday 3 November 2026, 18:00-21:00. Startup Lab, Gaustadalléen 21, Oslo. Show this email at the door.", labels: ["CATEGORY_UPDATES"] },
  { id: "m_pending", from: "Google Events <no-reply-eventsatgoogle@google.com>", at: "2026-10-17T08:40:00Z", subject: "Your registration is pending approval", body: "Founders Story Oslo at Startup Lab: the host will review your registration.", labels: ["CATEGORY_UPDATES"] },
  { id: "m_jcole", from: "noreply@ticketmaster.no", at: "2026-02-25T18:03:00Z", subject: "Ordrebekreftelse til J. Cole: The Fall-Off Tour, ordrenr 036574171", body: "Takk for ditt kjøp! J. Cole: The Fall-Off Tour, Unity Arena, torsdag 12. november 2026 kl. 19:00.", labels: ["CATEGORY_UPDATES"] },
  // Newer mail, so a plain "newest emails" list does not reach back to 17 Oct.
  ...[
    ["2026-10-29T07:10:00Z", "Nordnet <info@nordnet.no>", "Månedsoversikt oktober", "Din portefølje steg 2,1 % i oktober."],
    ["2026-10-29T06:00:00Z", "SATS <noreply@sats.no>", "Your week at SATS", "You trained 3 times this week."],
    ["2026-10-28T19:30:00Z", "LinkedIn <messages-noreply@linkedin.com>", "Zanyar shared a post", "See what your network is talking about."],
    ["2026-10-28T12:00:00Z", "GitHub <noreply@github.com>", "[torsteinvestre/open-instinct] Run succeeded: build-images", "Your workflow run succeeded."],
    ["2026-10-27T15:00:00Z", "OVHcloud <noreply@ovh.com>", "Your AI Deploy app is queued", "Your app is waiting for an available host."],
    ["2026-10-27T09:00:00Z", "Anthropic <billing@anthropic.com>", "Your receipt", "Thanks for adding credits."],
    ["2026-10-26T18:00:00Z", "Composio <hello@composio.dev>", "New: triggers for Gmail", "Get events pushed to your webhook."],
    ["2026-10-25T08:00:00Z", "DNB <noreply@dnb.no>", "Ny e-faktura", "Du har fått en ny e-faktura."],
    ["2026-10-24T10:00:00Z", "Spotify <no-reply@spotify.com>", "Your weekly mix", "New music for you."],
    ["2026-10-22T16:00:00Z", "Railway <team@railway.app>", "Usage update", "Your trial renews on 12 Nov."],
    ["2026-10-20T08:00:00Z", "Vy <noreply@vy.no>", "Reisekvittering", "Takk for at du reiste med oss."],
    ["2026-10-19T12:00:00Z", "Komplett <noreply@komplett.no>", "Ukens tilbud", "Ladere og kabler -20 %.", ["CATEGORY_PROMOTIONS"]],
  ].map(([at, from, subject, body, labels], i) => ({ id: `m_${i}`, from, at, subject, body, labels: labels ?? ["CATEGORY_UPDATES"] })),
].sort((a, b) => day(b.at) - day(a.at));

// Gmail's search, closely enough: one OR-alternative matches when each of its quoted phrases or words is in the email;
// operators (newer_than:, after:, category:...) are honoured roughly or ignored.
function gmailMatch(query, m) {
  let q = String(query ?? "");
  if (/-category:promotions/i.test(q) && m.labels.includes("CATEGORY_PROMOTIONS")) return false;
  const after = /\bafter:(\d{4})[/-](\d{1,2})[/-](\d{1,2})/i.exec(q);
  if (after && day(m.at) < Date.UTC(+after[1], +after[2] - 1, +after[3])) return false;
  const newer = /\bnewer_than:(\d+)([dmy])/i.exec(q);
  if (newer && day(m.at) < Date.parse("2026-10-29T12:00:00Z") - Number(newer[1]) * { d: 1, m: 30, y: 365 }[newer[2].toLowerCase()] * 86_400_000) return false;
  q = q.replace(/-?\b[a-z_]+:\S+/gi, " ").replace(/[()]/g, " ").trim();
  if (!q) return true;
  const hay = `${m.subject} ${m.body} ${m.from}`.toLowerCase();
  return q.split(/\s+OR\s+/).some((alt) => {
    const parts = [...alt.matchAll(/"([^"]+)"|(\S+)/g)].map((x) => (x[1] ?? x[2]).toLowerCase());
    return parts.length > 0 && parts.every((p) => hay.includes(p));
  });
}
const EVENTS = [{ summary: "J. Cole: The Fall-Off Tour", start: { dateTime: "2026-11-12T19:00:00+01:00" }, end: { dateTime: "2026-11-12T20:00:00+01:00" }, location: "Unity Arena, John Strandrupsvei 16, FORNEBU" }];
const record = { calls: [], searchedEmail: false, ground: [] };
// The same inbox and calendar for the grounding step's look-up (lookup.ts plugs), as Composio's plugs would answer.
const liveSources = {
  searchEmail: async (query, max) => {
    record.ground.push(`email ${query}`);
    return INBOX.filter((m) => gmailMatch(`(${query}) -category:promotions`, m)).slice(0, max).map((m) => ({ at: day(m.at), from: m.from, subject: m.subject, preview: m.body }));
  },
  events: async (from, to, max) => {
    record.ground.push(`calendar ${from.slice(0, 10)}..${to.slice(0, 10)}`);
    return EVENTS.filter((e) => day(e.start.dateTime) < day(to) && day(e.end.dateTime) > day(from)).slice(0, max).map((e) => ({ title: e.summary, start: e.start.dateTime, end: e.end.dateTime, location: e.location }));
  },
};
function runSlug(slug, args) {
  const s = String(slug).toUpperCase();
  if (s.startsWith("GMAIL_")) {
    record.searchedEmail = true;
    if (/MESSAGE_BY|THREAD_BY|FETCH_MESSAGE/.test(s)) {
      const m = INBOX.find((x) => JSON.stringify(args).includes(x.id)) ?? INBOX[0];
      return { messageId: m.id, sender: m.from, subject: m.subject, messageText: m.body, messageTimestamp: m.at, labelIds: m.labels };
    }
    const max = Math.min(Number(args?.max_results ?? args?.maxResults ?? 10) || 10, 50);
    const hits = INBOX.filter((m) => gmailMatch(args?.query ?? args?.q, m)).slice(0, max);
    return { messages: hits.map((m) => ({ messageId: m.id, threadId: `t_${m.id}`, sender: m.from, subject: m.subject, preview: { body: m.body.slice(0, 160), subject: m.subject }, messageTimestamp: m.at, labelIds: m.labels })), resultSizeEstimate: hits.length };
  }
  if (s.startsWith("GOOGLECALENDAR_") && /LIST|FIND|EVENTS/.test(s)) {
    const from = day(args?.timeMin ?? args?.time_min ?? "2000-01-01T00:00:00Z");
    const to = day(args?.timeMax ?? args?.time_max ?? "2100-01-01T00:00:00Z");
    const items = EVENTS.filter((e) => day(e.start.dateTime) < to && day(e.end.dateTime) > from);
    return { accessRole: "owner", items, kind: "calendar#events", summary: "owner", timeZone: "Europe/Oslo" };
  }
  return { ok: true };
}
const HISTORY = "[Tue 27 Oct 2026] Torstein's agent project update (recorded on their phone)\n  [04:12] Torstein: In the coming weeks, I have two things happening. I got an event uh which I think is at uh the third of November, and then uh I got the concert on uh 11th or something, I'm not sure. I don't think I have this in my calendar either.";
function scripted(name, args) {
  if (name === "app_composio_search_tools") return "GMAIL_FETCH_EMAILS: search or list emails (query in Gmail search syntax, max_results)\nGMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: one email in full (message_id)\nGMAIL_CREATE_EMAIL_DRAFT: draft an email\nGMAIL_SEND_EMAIL: send an email\nGOOGLECALENDAR_EVENTS_LIST: events in a time range (calendarId, timeMin, timeMax)\nGOOGLECALENDAR_CREATE_EVENT: add an event";
  if (name === "app_composio_get_tool_schemas") return "Schemas as listed; all arguments are strings unless noted.";
  if (name === "app_composio_multi_execute_tool") {
    const tools = Array.isArray(args?.tools) ? args.tools : [];
    const results = tools.map((t, index) => {
      record.calls.push(`${t.tool_slug}${t.arguments?.query ? ` "${t.arguments.query}"` : ""}`);
      return { response: { successful: true, data: runSlug(t.tool_slug, t.arguments ?? {}) }, tool_slug: t.tool_slug, index };
    });
    return JSON.stringify({ successful: true, data: { results, total_count: results.length, success_count: results.length, error_count: 0 }, error: null });
  }
  if (name === "app_composio_manage_connections" || name === "apps_list") return "Connected: gmail, googlecalendar.";
  if (name === "history_search") return /nov|event|third|3\b|week|calendar/i.test(JSON.stringify(args ?? {})) ? HISTORY : "No matches.";
  if (name === "web_search" || name === "web_fetch") return "No useful results.";
  if (name.startsWith("memory_") || name === "journal_append") return "Saved.";
  if (name === "react") return "Reacted.";
  if (name === "schedule_create") return "Scheduled.";
  return "Done.";
}

// ---- one run on a fresh copy of the snapshot -----------------------------------------------------------------------
const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const SNAPSHOT = resolve(need("SNAPSHOT").replace(/^~/, homedir()));
const apiKey = need("ANTHROPIC_API_KEY");
const composioKey = need("COMPOSIO_API_KEY");
const RUNS = Number(process.env.RUNS ?? 3);
const MAX_USD = Number(process.env.MAX_USD ?? 0.22);
const LABEL = [process.env.GROUND === "off" ? "no-grounding" : "grounded", process.env.THINKING ? `thinking-${process.env.THINKING}` : "", process.env.NO_OLD_QUESTIONS ? "no-old-questions" : ""].filter(Boolean).join("+");
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const CUT_AT = Date.parse("2026-10-29T10:41:00Z"); // the replayed text came at 10:41:12Z
// TEXTS="hi|what's the weather in Oslo tomorrow?" replays other texts instead (each once per run; not graded): does the
// grounding stay out of the way of everyday messages (nothing gathered, little time added)?
const TEXTS = process.env.TEXTS ? process.env.TEXTS.split("|").map((t) => t.trim()).filter(Boolean) : ["Anything happening next week for me"];

const { ComposioApps } = await import("@open-instinct/apps");
ComposioApps.prototype.connectedToolkits = async function () {
  return [{ slug: "gmail", connected: true }, { slug: "googlecalendar", connected: true }];
};
const { AuditLog, HistoryArchive, ItemArchive, MeaningSearch, StateDir, defaultConfig } = await import("@open-instinct/core");
const { boot } = await import("../dist/boot.js");
const { createLocalEmbedder } = await import("../dist/embedder.js");
const embedder = createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: 8, log: () => {} });
const CUT = await cutSnapshot();

function ownerThread(dir) {
  const conversations = JSON.parse(readFileSync(join(dir, "conversations.json"), "utf8"));
  const key = Object.keys(conversations).find((k) => k.startsWith("imessage:") && conversations[k].principal?.kind === "owner");
  return { key, record: conversations[key], sessionFile: join(dir, "sessions", `${encodeURIComponent(key)}.jsonl`) };
}
function keepBefore(file, at) {
  writeFileSync(file, readFileSync(file, "utf8").trim().split("\n").filter((l) => { const j = JSON.parse(l); return (j.timestamp ?? j.ts ?? 0) < at; }).join("\n") + "\n");
}

// Once: the snapshot cut just before the replayed text, its chats and kept items stored for meaning search.
async function cutSnapshot() {
  const cut = `${SNAPSHOT}-cut`;
  if (existsSync(join(cut, "history", "meaning.json"))) return cut;
  rmSync(cut, { recursive: true, force: true });
  cpSync(SNAPSHOT, cut, { recursive: true });
  keepBefore(ownerThread(cut).sessionFile, CUT_AT);
  keepBefore(join(cut, "history", "owner.jsonl"), CUT_AT);
  const state = new StateDir(cut);
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const started = Date.now();
  const res = await new MeaningSearch({ state, embedder, config, history: new HistoryArchive(state), items: new ItemArchive(state), audit: new AuditLog(state) }).sync();
  console.log(`cut the snapshot; ${res.added} pieces stored for meaning search in ${Math.round((Date.now() - started) / 1000)} s`);
  return cut;
}

function prepare(cut, dir) {
  cpSync(cut, dir, { recursive: true });
  const { key, record: conv, sessionFile } = ownerThread(dir);
  if (process.env.NO_OLD_QUESTIONS) {
    writeFileSync(sessionFile, readFileSync(sessionFile, "utf8").replace(" What's the event on 3 Nov, and what time? I'll add it once you tell me.", "").replace(" What is the 3 Nov event?", ""));
  }
  if (process.env.THINKING) {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    config.model = { ...config.model, thinking: process.env.THINKING };
    writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  }
  return { key, record: conv };
}

async function once(i, text) {
  const runsDir = join(homedir(), "sunshine-memory/look-before-ask-runs");
  mkdirSync(runsDir, { recursive: true });
  const dir = mkdtempSync(join(runsDir, `${LABEL}-${i}-`));
  const { key, record: conv } = prepare(CUT, dir);
  record.calls = [];
  record.searchedEmail = false;
  record.ground = [];
  const owner = conv.principal.phone;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
    INSTINCT_WATCHER: "1", TYPESAFE_API_KEY: "dummy", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1", INSTINCT_MEANING_SEARCH: "1",
    INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
    INSTINCT_OWNER_NAME: conv.principal.displayName, INSTINCT_OWNER_PHONE: owner, INSTINCT_OWNER_EMAIL: conv.principal.email ?? "", INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
    INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-look-before-ask-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
    BRAVE_SEARCH_API_KEY: "dummy", COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
    TRANSCRIBE_URL: "https://transcribe.stub", TRANSCRIBE_KEY: "stub", MEMORY_PASS_MODEL: "off",
    ...(process.env.GROUND === "off" ? { GROUND_MODEL: "off" } : {}),
  };
  const realFetch = globalThis.fetch;
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
    if (/composio/.test(url)) return realFetch(input, init); // the router's tool definitions only (a test user, no account)
    throw new Error(`offline: ${url}`);
  };
  const sent = [];
  const app = await boot(env, { embedder, fetchImpl, liveSources, outbox: { send: async (m) => void sent.push(m), typing: async () => {}, markRead: async () => {} }, logger: () => {} });
  app.runtime.runScheduled = async () => undefined; // no news check or memory pass during the replay
  // What the grounding handed the agent (never saved in the thread), kept with the run for reading afterwards.
  const handed = [];
  const groundFor = app.runtime.groundFor?.bind(app.runtime);
  if (groundFor) app.runtime.groundFor = async (...args) => { const g = await groundFor(...args); handed.push(g ?? null); return g; };
  for (const t of app.runtime.deps.registry.all()) {
    if (t.spec.name === "load_tools" || t.spec.name === "load_skill") continue;
    const name = t.spec.name;
    t.spec.execute = async (args) => ({ content: [{ type: "text", text: scripted(name, args) }], details: {} });
  }
  const principal = app.runtime.ownerPrincipal();
  const before = app.runtime.conversation(key, principal).agent.state.messages.length;
  const t0 = Date.now();
  await app.runtime.handleInbound({ id: `evt_repro_${Date.now()}`, channel: "imessage", from: owner, conversationKey: key, text, replyRef: conv.replyRef ?? {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
  const replyMs = Date.now() - t0;
  const msgs = app.runtime.conversation(key, principal).agent.state.messages.slice(before);
  const assistant = msgs.filter((m) => m.role === "assistant");
  const cost = assistant.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0);
  const thinking = assistant.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "thinking").length : 0), 0);
  const tools = assistant.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "toolCall").map((p) => p.name) : []));
  const texts = sent.map((m) => m.text ?? "").filter(Boolean);
  await app.close();
  // [sunshine:grounding] What the grounding step decided and spent (its own small model call).
  const grounding = new AuditLog(new StateDir(dir)).read({}).map((e) => e.detail?.grounding).filter(Boolean);
  const groundCost = grounding.reduce((s, g) => s + (g.costUsd ?? 0), 0);
  const r = { run: i, text, texts, searchedEmail: record.searchedEmail, slugs: [...record.calls], tools, thinking, cost: cost + groundCost, groundCost, grounding, lookedUp: [...record.ground], handed, replyMs, dir };
  writeFileSync(join(dir, "result.json"), JSON.stringify(r, null, 1));
  return { ...r, ...check(r) };
}

const results = [];
const graded = !process.env.TEXTS;
let spent = 0;
let last = 0;
outer: for (let i = 1; i <= RUNS; i++) {
  for (const text of TEXTS) {
    // The cap holds before a run starts: the next one is assumed to cost what the last one did.
    if (spent + last > MAX_USD) {
      console.log(`stopped before run ${i} ("${text}"): $${spent.toFixed(3)} spent, the next would pass MAX_USD ${MAX_USD}`);
      break outer;
    }
    const r = await once(i, text);
    spent += r.cost;
    last = r.cost;
    results.push(r);
    console.log(`${LABEL} #${i}${graded ? "" : ` "${text}"`}: ${graded ? `${r.pass ? "PASS" : "FAIL"} (${r.notes.join("; ")})` : "ran"} $${r.cost.toFixed(3)}, reply in ${(r.replyMs / 1000).toFixed(1)} s | thinking blocks ${r.thinking} | tools ${r.tools.join(", ") || "-"}${r.slugs.length ? ` | ${r.slugs.join("; ")}` : ""}`);
    for (const g of r.grounding) console.log(`    grounding: ${g.outcome}${g.outcome === "grounded" ? ` (about ${g.about}, days ${g.days}, searches ${g.searches}; kept: ${g.known}; email/calendar: ${g.live})` : ""}${g.start ? ` began "${g.start}"` : ""}, $${(g.costUsd ?? 0).toFixed(4)}, ${g.ms} ms`);
    if (r.lookedUp.length) console.log(`    looked up by code: ${r.lookedUp.join(" ; ")}`);
    for (const t of r.texts) console.log(`    Sunshine: ${t.replace(/\s+/g, " ")}`);
  }
}
console.log(`\n${LABEL}: ${graded ? `${results.filter((r) => r.pass).length}/${results.length} passed` : `${results.length} replies`}, $${spent.toFixed(3)}`);
await embedder.close?.();
process.exit(0);
