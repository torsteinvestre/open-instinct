// [sunshine:hindsight] Step 1(b) of the memory design (~/sunshine-ops/DESIGN-memory-in-the-flow.md, "Hindsight as the
// engine"). The question: on Torstein's real data, does Sunshine answer what he would ask about his own life better with
// Hindsight as its memory engine than with today's meaning search, and does nothing get worse? The 20 questions and what a
// right answer holds were written before any run (hindsight-real/key.json, 30 Oct). Unlike the 30 Oct test (its own
// answerer and search tool), each question goes through the real path: the real server at this version on a local copy
// of his agent's chat state (thread, notes, persona, settings), the grounding step (Haiku: recall + the email and calendar
// look-up), then Sonnet 5.5 at the live thinking level with its real tools; the agent's own search (history_search) is real.
//
//   A  today: meaning search with the agent's own search model (as live)
//   B  Hindsight: a bank stored from the same archive through the agent's own HindsightMemory (the input policy)
//
// The data (hindsight-real/, git-ignored): the copy of his agent (snapshot-chat.sh) cut at the key's "now" (30 Oct, 13:00
// Oslo); his 4 kept recordings, his chats and his 117 exported emails as kept items, as if email had already been
// flowing in (the email door is not built; with no catch-up the Feb and Sep ticket orders would only be found live: kept
// in, as on 30 Oct, to compare). He asked two of the key's questions live that morning and Sunshine answered them; left
// in, those old answers would hand both arms the answer (29 Oct: a replay passed 3/3 on a hint in its own old reply), so
// those two exchanges are taken out of the thread and the archive.
// Stand-ins: Gmail searches his same exported emails (as look-before-ask.mjs: a search finds an email when its words are
// in it); the calendar holds what his held on 27-29 Oct for these weeks (J. Cole on 12 Nov, the 1 Nov holiday), not his
// past meetings. Every other tool that would reach the world (sending, calendar writes, web, reminders) answers from a
// script and is recorded. Nothing reaches anyone. In answer runs nothing is written to Hindsight (a guard refuses it).
//
// Usage (from packages/server, after `pnpm build`; the local Hindsight server: ~/sunshine-memory/hindsight-real.sh):
//   DRY=1 STORE=1 node scenarios/memory-real.mjs          free: what would be stored in bank B, and an estimate
//   STORE=1 MAX_USD=0.40 node scenarios/memory-real.mjs   PAID: bank B stored; a watcher on its own clock stops the
//                                                         Hindsight server if the spend passes MAX_USD
//   DRY=1 ARM=A|B node scenarios/memory-real.mjs          free: each question through the real path with a stand-in model
//                                                         and no grounding (no model call): the wiring, and what the
//                                                         agent's search returns; B reads DRY_BANK (default the 30 Oct bank)
//   ARM=A|B MAX_USD=1.40 node scenarios/memory-real.mjs   PAID: the questions (IDS=d1,p2 picks some); a rerun skips the
//                                                         ones already answered
//   SHEET=1 node scenarios/memory-real.mjs                free: blind grading sheet of both arms, and where each answer's
//                                                         facts were (what grounding handed over, the search, neither)
// The first run cuts the copy once into <SNAPSHOT>-cut (and <SNAPSHOT>-cut-A with arm A's search pieces stored, free).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const home = (p) => resolve(p.replace(/^~/, homedir()));
const REAL = home(process.env.REAL ?? "~/sunshine-memory/hindsight-real");
const SNAPSHOT = home(process.env.SNAPSHOT ?? join(REAL, "live-1b/data"));
const RESULTS = join(REAL, "results");
const KEY = JSON.parse(readFileSync(join(REAL, "key.json"), "utf8"));
const DOCS = JSON.parse(readFileSync(join(REAL, "docs.json"), "utf8"));
const HS = (process.env.HINDSIGHT_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");
const BANK = process.env.BANK ?? "torstein-1b";
const DRY_BANK = process.env.DRY_BANK ?? "torstein-real";
const ARM = process.env.ARM;
const DRY = Boolean(process.env.DRY);
const MAX_USD = Number(process.env.MAX_USD ?? (process.env.STORE ? 0.4 : 1.4));
const CUT_AT = Date.parse(KEY.now); // 30 Oct, 13:00 in Oslo
const DROP = [Date.parse("2026-10-30T10:12:00Z"), Date.parse("2026-10-30T10:14:00Z")]; // the two live exchanges (above)
const kept = (ts) => ts < CUT_AT && !(ts >= DROP[0] && ts < DROP[1]);
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeJsonl = (f, rows) => writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const words = (s) => s.split(/\s+/).filter(Boolean).length;

const { AuditLog, HistoryArchive, ItemArchive, MeaningSearch, StateDir, defaultConfig } = await import("@open-instinct/core");

function ownerThread(dir) {
  const conversations = JSON.parse(readFileSync(join(dir, "conversations.json"), "utf8"));
  const key = Object.keys(conversations).find((k) => k.startsWith("imessage:") && conversations[k].principal?.kind === "owner");
  return { key, record: conversations[key], sessionFile: join(dir, "sessions", `${encodeURIComponent(key)}.jsonl`) };
}

function configOf(dir) {
  const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const config = defaultConfig();
  config.owner = { ...config.owner, ...saved.owner };
  config.agent = { ...config.agent, ...saved.agent };
  return config;
}

// ---- the data, cut once ----------------------------------------------------------------------------------------------
function cut() {
  const dir = `${SNAPSHOT}-cut`;
  if (existsSync(join(dir, "PREP.json"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  cpSync(SNAPSHOT, dir, { recursive: true });
  const thread = readJsonl(ownerThread(dir).sessionFile);
  const threadKept = thread.filter((m) => kept(m.timestamp ?? 0));
  writeJsonl(ownerThread(dir).sessionFile, threadKept);
  const chats = readJsonl(join(dir, "history/owner.jsonl"));
  const chatsKept = chats.filter((e) => kept(e.ts));
  writeJsonl(join(dir, "history/owner.jsonl"), chatsKept);
  // His kept recordings as the agent has them, and his emails as kept items (no summary: the email door is not built).
  const recordings = readJsonl(join(dir, "history/items.jsonl")).filter((it) => it.receivedAt < CUT_AT);
  const emails = DOCS.filter((d) => d.source === "email" && Date.parse(d.at) < CUT_AT)
    .map((d) => ({ id: d.id, source: "email", title: d.title, startedAt: Date.parse(d.at), receivedAt: Date.parse(d.at), people: d.people, text: d.text }));
  writeJsonl(join(dir, "history/items.jsonl"), [...recordings, ...emails]);
  for (const f of ["history/hindsight.json", "history/meaning.json", "audit.jsonl"]) rmSync(join(dir, f), { force: true });
  const prep = { cutAt: KEY.now, dropped: { thread: thread.length - threadKept.length, chats: chats.length - chatsKept.length }, recordings: recordings.length, emails: emails.length, chats: chatsKept.length, thread: threadKept.length };
  writeFileSync(join(dir, "PREP.json"), JSON.stringify(prep, null, 1));
  console.log(`cut the copy: ${JSON.stringify(prep)}`);
  return dir;
}

// Arm A: the same archive, its pieces stored for meaning search with the agent's own search model (free, local).
async function cutA(embedder) {
  const dir = `${cut()}-A`;
  if (existsSync(join(dir, "history/meaning.json"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  cpSync(cut(), dir, { recursive: true });
  const state = new StateDir(dir);
  const config = configOf(dir);
  const started = Date.now();
  const res = await new MeaningSearch({ state, embedder, config, history: new HistoryArchive(state), items: new ItemArchive(state), audit: new AuditLog(state) }).sync();
  console.log(`arm A: ${res.added} pieces stored for meaning search in ${Math.round((Date.now() - started) / 1000)} s`);
  return dir;
}

// ---- Hindsight's own model use, read from its metrics (Haiku 5.5: $0.10 / $0.50 per million, watcher models.ts) -------
async function llmTotals() {
  const text = await (await fetch(`${HS}/metrics`)).text();
  const t = { calls: 0, input: 0, cached: 0, output: 0 };
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.includes("hindsight_llm_")) continue;
    const name = line.split(/[{ ]/)[0];
    if (!name.endsWith("_total")) continue;
    const v = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (name.includes("calls")) t.calls += v;
    else if (name.includes("cached_input")) t.cached += v;
    else if (name.includes("tokens_input")) t.input += v;
    else if (name.includes("tokens_output") || name.includes("thoughts")) t.output += v;
  }
  return t;
}
const costOf = (a, b) => (((b.input - a.input) - (b.cached - a.cached)) * 0.1 + (b.cached - a.cached) * 0.01 + (b.output - a.output) * 0.5) / 1e6;

// ---- STORE: bank B through the agent's own layer -----------------------------------------------------------------------
if (process.env.STORE) {
  const { HindsightClient } = await import("@vectorize-io/hindsight-client");
  const { HindsightMemory } = await import("../dist/hindsight.js");
  const dir = `${cut()}-B`;
  if (!existsSync(dir)) cpSync(cut(), dir, { recursive: true });
  const state = new StateDir(dir);
  const config = configOf(dir);
  const api = new HindsightClient({ baseUrl: HS, userAgent: "sunshine-memory-real" });
  const memory = new HindsightMemory({ api, bank: BANK, state, config, history: new HistoryArchive(state), items: new ItemArchive(state), audit: new AuditLog(state) });
  const docs = memory.documents().docs;
  const kinds = {};
  for (const d of docs) {
    const k = d.id.startsWith("said:") ? "said (text only, no model)" : d.id.startsWith("chat:") ? "his texts (spells)" : `item ${d.metadata.source}`;
    kinds[k] = kinds[k] ?? { docs: 0, words: 0 };
    kinds[k].docs++;
    kinds[k].words += words(d.content);
  }
  const modelWords = Object.entries(kinds).filter(([k]) => !k.startsWith("said")).reduce((n, [, v]) => n + v.words, 0);
  // 30 Oct: the same emails and recordings plus both sides of the chat, 128 documents, stored for about $0.24.
  const oct30Words = DOCS.reduce((n, d) => n + words(d.text), 0);
  console.log(`bank ${BANK}: ${docs.length} documents`);
  for (const [k, v] of Object.entries(kinds)) console.log(`  ${k}: ${v.docs} documents, ${v.words} words`);
  console.log(`estimate: ${modelWords} words read by Hindsight's model; 30 Oct ${oct30Words} words cost about $0.24 -> about $${(0.24 * modelWords / oct30Words).toFixed(2)}`);
  if (DRY) {
    const first = (re) => docs.find((d) => re.test(d.id));
    for (const d of [first(/^item:email/), first(/^item:rec/), first(/^chat:/), first(/^said:/)].filter(Boolean)) {
      console.log(`\n--- ${d.id} | ${d.timestamp}\n    context: ${d.context}\n    ${d.content.slice(0, 400).split("\n").join("\n    ")}`);
    }
    process.exit(0);
  }
  const before = await llmTotals();
  let spent = 0;
  // On its own clock, not between steps: Hindsight keeps working after a call returns (24 Oct overspend).
  const watcher = setInterval(async () => {
    try {
      spent = costOf(before, await llmTotals());
    } catch {
      return;
    }
    if (spent > MAX_USD) {
      console.log(`STOPPING: about $${spent.toFixed(3)} spent, over MAX_USD ${MAX_USD}; stopping the Hindsight server`);
      spawnSync("pkill", ["-f", "hindsight-api"]);
      process.exit(2);
    }
  }, 5_000);
  const t0 = Date.now();
  const synced = await memory.sync();
  console.log(`stored ${JSON.stringify(synced)} in ${Math.round((Date.now() - t0) / 1000)} s, about $${costOf(before, await llmTotals()).toFixed(4)} so far; waiting for Hindsight's background work`);
  let last = -1;
  for (let still = 0, i = 0; still < 45 && i < 180; i++) {
    const c = (await llmTotals()).calls;
    still = c === last ? still + 5 : 0;
    last = c;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  clearInterval(watcher);
  const after = await llmTotals();
  spent = costOf(before, after);
  const stats = await (await fetch(`${HS}/v1/default/banks/${BANK}/stats`)).json();
  const out = { bank: BANK, synced, costUsd: spent, seconds: Math.round((Date.now() - t0) / 1000), tokens: { calls: after.calls - before.calls, input: after.input - before.input, cached: after.cached - before.cached, output: after.output - before.output }, stats };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `store-${BANK}.json`), JSON.stringify(out, null, 2));
  console.log(`bank ${BANK}: about $${spent.toFixed(4)} (${out.tokens.calls} model calls), ${out.seconds} s; ${stats.total_documents} documents, ${JSON.stringify(stats.nodes_by_fact_type)}`);
  process.exit(0);
}

// ---- SHEET: blind grading, then where each answer's facts were ---------------------------------------------------------
if (process.env.SHEET) {
  const tag = DRY ? "-dry" : ""; // DRY=1 SHEET=1: the sheet checked on the dry runs' answers
  const answers = Object.fromEntries(["A", "B"].map((a) => [a, join(RESULTS, `real-path-${a}${tag}.json`)]).filter(([, f]) => existsSync(f)).map(([a, f]) => [a, JSON.parse(readFileSync(f, "utf8"))]));
  let seed = 20261030;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const blind = {};
  const lines = ["# Grading sheet, step 1(b) (blind: the arms are shuffled per question)", ""];
  for (const q of KEY.questions) {
    const arms = Object.keys(answers).filter((a) => answers[a][q.id]);
    if (rand() < 0.5) arms.reverse();
    blind[q.id] = Object.fromEntries(arms.map((a, i) => [String(i + 1), a]));
    lines.push(`## ${q.id} (${q.kind}): ${q.q}`, `Must: ${JSON.stringify(q.must)}`, `Nice: ${JSON.stringify(q.nice ?? [])}`, `Wrong: ${JSON.stringify(q.wrong ?? [])}`, "");
    arms.forEach((a, i) => lines.push(`**${i + 1}.** ${answers[a][q.id].texts.join("\n\n") || "(no reply)"}`, ""));
  }
  writeFileSync(join(RESULTS, `real-path-sheet${tag}.md`), lines.join("\n"));
  writeFileSync(join(RESULTS, `real-path-blind${tag}.json`), JSON.stringify(blind, null, 2));
  console.log(`wrote ${join(RESULTS, `real-path-sheet${tag}.md`)}`);
  // Not blind (read after grading): which of the must-have words were in what grounding handed over, in the search results.
  for (const q of KEY.questions) {
    for (const [a, rs] of Object.entries(answers)) {
      const r = rs[q.id];
      if (!r) continue;
      const handed = r.handed.filter(Boolean).join("\n").toLowerCase();
      const searched = r.searches.map((s) => s.result).join("\n").toLowerCase();
      const marks = q.must.map((m) => {
        const w = (m.match(/[\p{L}\d][\p{L}\d.'’-]{3,}/gu) ?? []).map((x) => x.toLowerCase());
        const inIt = (t) => w.length > 0 && w.filter((x) => t.includes(x)).length >= Math.ceil(w.length / 2);
        return `${inIt(handed) ? "H" : "-"}${inIt(searched) ? "S" : "-"}`;
      });
      console.log(`${q.id.padEnd(4)} ${a}: ${marks.join(" ")}  (H = in what grounding handed over, S = in the search results; per must-have)`);
    }
  }
  process.exit(0);
}

// ---- the answer runs ---------------------------------------------------------------------------------------------------
if (ARM !== "A" && ARM !== "B") throw new Error("ARM=A or ARM=B (or STORE=1, SHEET=1)");
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const { createLocalEmbedder } = await import("../dist/embedder.js");
const embedder = ARM === "A" ? createLocalEmbedder({ cacheDir: process.env.MODELS ?? join(homedir(), "sunshine-memory/node-embed/models"), threads: 8, log: () => {} }) : undefined;
const PREPARED = ARM === "A" ? await cutA(embedder) : DRY ? cut() : `${cut()}-B`;
const bank = ARM === "B" ? (DRY ? DRY_BANK : BANK) : undefined;
// Arm A's search model loaded before the first question: cold, word search answers after 8 s (live it is warm while he
// is texting); arm B's search models load with the Hindsight server.
if (embedder) {
  const st = new StateDir(PREPARED);
  await new MeaningSearch({ state: st, embedder, config: configOf(PREPARED), history: new HistoryArchive(st), items: new ItemArchive(st) }).searchScored("warm up");
}
if (ARM === "B" && !DRY) {
  const stored = JSON.parse(readFileSync(join(PREPARED, "history/hindsight.json"), "utf8"));
  if (stored.bank !== BANK || Object.keys(stored.docs ?? {}).length === 0) throw new Error(`bank ${BANK} is not stored yet: run STORE=1 first`);
}

// In answer runs Hindsight is read, never written: a store started by the run (its question going quiet, a retry) is refused.
const blocked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(HS)) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && !(method === "POST" && /\/memories\/recall$/.test(new URL(url).pathname))) {
      blocked.push(`${method} ${new URL(url).pathname}`);
      throw new Error(`refused in an answer run: ${method} ${url}`);
    }
  }
  return realFetch(input, init);
};

// The stand-in inbox: his exported emails, found as Gmail would find them (closely enough; as look-before-ask.mjs).
const day = (s) => Date.parse(s);
const INBOX = DOCS.filter((d) => d.source === "email" && day(d.at) < CUT_AT).map((d) => {
  const [head, ...rest] = d.text.split("\n\n");
  return { id: d.id, from: String(d.people?.[0] ?? ""), at: d.at, subject: String(d.title ?? ""), head, body: rest.join("\n\n"), labels: [] };
}).sort((a, b) => day(b.at) - day(a.at));
function gmailMatch(query, m) {
  let q = String(query ?? "");
  if (/-category:promotions/i.test(q) && m.labels.includes("CATEGORY_PROMOTIONS")) return false;
  const after = /\bafter:(\d{4})[/-](\d{1,2})[/-](\d{1,2})/i.exec(q);
  if (after && day(m.at) < Date.UTC(+after[1], +after[2] - 1, +after[3])) return false;
  const before = /\bbefore:(\d{4})[/-](\d{1,2})[/-](\d{1,2})/i.exec(q);
  if (before && day(m.at) >= Date.UTC(+before[1], +before[2] - 1, +before[3])) return false;
  const newer = /\bnewer_than:(\d+)([dmy])/i.exec(q);
  if (newer && day(m.at) < CUT_AT - Number(newer[1]) * { d: 1, m: 30, y: 365 }[newer[2].toLowerCase()] * 86_400_000) return false;
  q = q.replace(/-?\b[a-z_]+:\S+/gi, " ").replace(/[()]/g, " ").trim();
  if (!q) return true;
  const hay = `${m.subject} ${m.head} ${m.body}`.toLowerCase();
  return q.split(/\s+OR\s+/).some((alt) => {
    const parts = [...alt.matchAll(/"([^"]+)"|(\S+)/g)].map((x) => (x[1] ?? x[2]).toLowerCase());
    return parts.length > 0 && parts.every((p) => hay.includes(p));
  });
}
// His calendar for these weeks, as the live checks of 27 and 29 Oct read it.
const EVENTS = [
  { summary: "Allehelgensdag", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
  { summary: "J. Cole: The Fall-Off Tour", start: { dateTime: "2026-11-12T19:00:00+01:00" }, end: { dateTime: "2026-11-12T20:00:00+01:00" }, location: "Unity Arena, John Strandrupsvei 16, FORNEBU" },
];
const startOf = (e) => day(e.start.dateTime ?? `${e.start.date}T00:00:00+01:00`);
const endOf = (e) => day(e.end.dateTime ?? `${e.end.date}T00:00:00+01:00`);
const record = {};
const liveSources = {
  searchEmail: async (query, max) => {
    record.ground.push(`email ${query}`);
    return INBOX.filter((m) => gmailMatch(`(${query}) -category:promotions`, m)).slice(0, max).map((m) => ({ at: day(m.at), from: m.from, subject: m.subject, preview: m.body.replace(/\s+/g, " ").slice(0, 200) }));
  },
  events: async (from, to, max) => {
    record.ground.push(`calendar ${from.slice(0, 10)}..${to.slice(0, 10)}`);
    return EVENTS.filter((e) => startOf(e) < day(to) && endOf(e) > day(from)).slice(0, max).map((e) => ({ title: e.summary, start: e.start.dateTime ?? e.start.date, end: e.end.dateTime ?? e.end.date, ...(e.location ? { location: e.location } : {}) }));
  },
};
function runSlug(slug, args) {
  const s = String(slug).toUpperCase();
  if (s.startsWith("GMAIL_")) {
    if (/MESSAGE_BY|THREAD_BY|FETCH_MESSAGE/.test(s)) {
      const m = INBOX.find((x) => JSON.stringify(args).includes(x.id)) ?? INBOX[0];
      return { messageId: m.id, sender: m.from, subject: m.subject, messageText: m.body, messageTimestamp: m.at, labelIds: m.labels };
    }
    const max = Math.min(Number(args?.max_results ?? args?.maxResults ?? 10) || 10, 50);
    const hits = INBOX.filter((m) => gmailMatch(args?.query ?? args?.q, m)).slice(0, max);
    return { messages: hits.map((m) => ({ messageId: m.id, threadId: `t_${m.id}`, sender: m.from, subject: m.subject, preview: { body: m.body.replace(/\s+/g, " ").slice(0, 160), subject: m.subject }, messageTimestamp: m.at, labelIds: m.labels })), resultSizeEstimate: hits.length };
  }
  if (s.startsWith("GOOGLECALENDAR_") && /LIST|FIND|EVENTS/.test(s)) {
    const from = day(args?.timeMin ?? args?.time_min ?? "2000-01-01T00:00:00Z");
    const to = day(args?.timeMax ?? args?.time_max ?? "2100-01-01T00:00:00Z");
    return { accessRole: "owner", items: EVENTS.filter((e) => startOf(e) < to && endOf(e) > from), kind: "calendar#events", summary: "owner", timeZone: "Europe/Oslo" };
  }
  return { ok: true };
}
// What answers from a script: everything that would reach the world. Real: loading tools and skills, his notes, the search.
const REAL_TOOLS = new Set(["load_tools", "load_skill", "memory_read", "history_search"]);
function scripted(name, args) {
  if (name === "app_composio_search_tools") return "GMAIL_FETCH_EMAILS: search or list emails (query in Gmail search syntax, max_results)\nGMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: one email in full (message_id)\nGMAIL_CREATE_EMAIL_DRAFT: draft an email\nGMAIL_SEND_EMAIL: send an email\nGOOGLECALENDAR_EVENTS_LIST: events in a time range (calendarId, timeMin, timeMax)\nGOOGLECALENDAR_CREATE_EVENT: add an event";
  if (name === "app_composio_get_tool_schemas") return "Schemas as listed; all arguments are strings unless noted.";
  if (name === "app_composio_multi_execute_tool") {
    const tools = Array.isArray(args?.tools) ? args.tools : [];
    const results = tools.map((t, index) => {
      record.calls.push(`${t.tool_slug}${t.arguments?.query ? ` "${t.arguments.query}"` : ""}`);
      if (/CALENDAR_.*(CREATE|QUICK_ADD|INSERT)/i.test(t.tool_slug)) record.adds.push(JSON.stringify(t.arguments ?? {}));
      if (/GMAIL_(SEND|REPLY)/i.test(t.tool_slug)) record.sends.push(t.tool_slug);
      return { response: { successful: true, data: runSlug(t.tool_slug, t.arguments ?? {}) }, tool_slug: t.tool_slug, index };
    });
    return JSON.stringify({ successful: true, data: { results, total_count: results.length, success_count: results.length, error_count: 0 }, error: null });
  }
  if (name === "app_composio_manage_connections" || name === "apps_list") return "Connected: gmail, googlecalendar.";
  if (name === "web_search" || name === "web_fetch") return "No useful results.";
  if (name.startsWith("memory_") || name === "journal_append") return "Saved.";
  if (name === "react") return "Reacted.";
  if (name === "schedule_create") {
    record.schedules.push(String(args?.name ?? args?.text ?? args?.prompt ?? ""));
    return "Scheduled.";
  }
  if (name === "send_message" && args?.to && !/owner|torstein|^\+?47/i.test(String(args.to))) record.sends.push(`send_message to ${args.to}`);
  if (name === "ask_instinct") record.sends.push("ask_instinct");
  return "Done.";
}

const { ComposioApps } = await import("@open-instinct/apps");
ComposioApps.prototype.connectedToolkits = async function () {
  return [{ slug: "gmail", connected: true }, { slug: "googlecalendar", connected: true }];
};
const { boot } = await import("../dist/boot.js");
let faux;
let fauxStream;
if (DRY) {
  const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import("@earendil-works/pi-ai");
  faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  fauxStream = (m, context, opts) => models.streamSimple(m, context, opts);
  faux.next = (q) => faux.setResponses([fauxAssistantMessage([fauxToolCall("history_search", { query: q })], { stopReason: "toolUse" }), fauxAssistantMessage("DRY reply")]);
}
const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const apiKey = DRY ? "dummy" : need("ANTHROPIC_API_KEY");
const composioKey = need("COMPOSIO_API_KEY");

async function once(q) {
  const runsDir = join(REAL, "real-path-runs");
  mkdirSync(runsDir, { recursive: true });
  const dir = mkdtempSync(join(runsDir, `${ARM}${DRY ? "-dry" : ""}-${q.id}-`));
  cpSync(PREPARED, dir, { recursive: true });
  const { key, record: conv } = ownerThread(dir);
  Object.assign(record, { calls: [], ground: [], adds: [], schedules: [], sends: [] });
  const blockedBefore = blocked.length;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
    INSTINCT_WATCHER: "1", TYPESAFE_API_KEY: "dummy", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1",
    INSTINCT_MODEL: DRY ? "faux/faux-1" : "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
    INSTINCT_OWNER_NAME: conv.principal.displayName, INSTINCT_OWNER_PHONE: conv.principal.phone, INSTINCT_OWNER_EMAIL: conv.principal.email ?? "", INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
    INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-memory-real-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
    BRAVE_SEARCH_API_KEY: "dummy", COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
    TRANSCRIBE_URL: "https://transcribe.stub", TRANSCRIBE_KEY: "stub", MEMORY_PASS_MODEL: "off",
    ...(ARM === "A" ? { INSTINCT_MEANING_SEARCH: "1" } : { HINDSIGHT_URL: HS, HINDSIGHT_BANK: bank }),
    ...(DRY ? { GROUND_MODEL: "off" } : {}),
  };
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
    if (/composio/.test(url)) return realFetch(input, init); // the router's tool definitions only (a test user, no account)
    throw new Error(`offline: ${url}`);
  };
  const sent = [];
  const app = await boot(env, { ...(embedder ? { embedder } : {}), ...(DRY ? { model: faux.getModel("faux-1"), streamFn: fauxStream } : {}), fetchImpl, liveSources, outbox: { send: async (m) => void sent.push(m), typing: async () => {}, markRead: async () => {} }, logger: () => {} });
  app.runtime.runScheduled = async () => undefined;
  const handed = [];
  const groundFor = app.runtime.groundFor?.bind(app.runtime);
  if (groundFor) app.runtime.groundFor = async (...args) => { const g = await groundFor(...args); handed.push(g ?? null); return g; };
  const searches = [];
  for (const t of app.runtime.deps.registry.all()) {
    const name = t.spec.name;
    if (name === "history_search") {
      const real = t.spec.execute;
      t.spec.execute = async (args, ctx) => {
        const res = await real(args, ctx);
        searches.push({ args, result: (res?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("") });
        return res;
      };
    } else if (!REAL_TOOLS.has(name)) t.spec.execute = async (args) => ({ content: [{ type: "text", text: scripted(name, args) }], details: {} });
  }
  if (DRY) faux.next(q.q);
  const principal = app.runtime.ownerPrincipal();
  const before = app.runtime.conversation(key, principal).agent.state.messages.length;
  const t0 = Date.now();
  await app.runtime.handleInbound({ id: `evt_memory_real_${Date.now()}`, channel: "imessage", from: conv.principal.phone, conversationKey: key, text: q.q, replyRef: conv.replyRef ?? {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
  const replyMs = Date.now() - t0;
  const msgs = app.runtime.conversation(key, principal).agent.state.messages.slice(before);
  const assistant = msgs.filter((m) => m.role === "assistant");
  const cost = assistant.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0);
  const thinking = assistant.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "thinking").length : 0), 0);
  const tools = assistant.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "toolCall").map((p) => p.name) : []));
  await app.close();
  // What grounding decided, which engine answered recall and the search (Hindsight, or the word search when it failed).
  const entries = new AuditLog(new StateDir(dir)).read({});
  const grounding = entries.map((e) => e.detail?.grounding).filter(Boolean);
  const engine = entries.filter((e) => e.detail?.recall || e.detail?.memorySearch || (e.kind === "error" && !e.detail?.hindsight)).map((e) => ({ kind: e.kind, ...e.detail }));
  const groundCost = grounding.reduce((s, g) => s + (g.costUsd ?? 0), 0);
  const r = { id: q.id, q: q.q, texts: sent.map((m) => m.text ?? "").filter(Boolean), tools, thinking, searches, handed, grounding, engine, lookedUp: [...record.ground], slugs: [...record.calls], adds: [...record.adds], schedules: [...record.schedules], sends: [...record.sends], blocked: blocked.slice(blockedBefore), cost: cost + groundCost, groundCost, replyMs, dir };
  writeFileSync(join(dir, "result.json"), JSON.stringify(r, null, 1));
  return r;
}

const want = process.env.IDS ? process.env.IDS.split(",").map((s) => s.trim()) : KEY.questions.map((q) => q.id);
const outFile = join(RESULTS, `real-path-${ARM}${DRY ? "-dry" : ""}.json`);
mkdirSync(RESULTS, { recursive: true });
const done = existsSync(outFile) && !DRY ? JSON.parse(readFileSync(outFile, "utf8")) : {};
let spent = 0;
let last = 0;
for (const q of KEY.questions.filter((x) => want.includes(x.id) && !done[x.id])) {
  // The cap holds before a run starts: the next one is assumed to cost what the last one did.
  if (spent + last > MAX_USD) {
    console.log(`stopped before ${q.id}: $${spent.toFixed(3)} spent, the next would pass MAX_USD ${MAX_USD}`);
    break;
  }
  const r = await once(q);
  spent += r.cost;
  last = r.cost;
  done[q.id] = r;
  writeFileSync(outFile, JSON.stringify(done, null, 1));
  const g = r.grounding[0];
  const label = (e) => (e.kind === "error" ? `error: ${e.recall ?? e.memorySearch ?? e.message ?? ""}`.slice(0, 90) : e.recall ? (e.recall.engine ? "hindsight recall" : "meaning recall") : e.memorySearch ? "hindsight search" : "?");
  const engines = [...new Set(r.engine.map(label))];
  console.log(`${ARM} ${q.id} $${r.cost.toFixed(3)} ${(r.replyMs / 1000).toFixed(1)} s | tools ${r.tools.join(", ") || "-"} | engine ${engines.join("; ") || "-"}${r.blocked.length ? ` | refused writes ${r.blocked.length}` : ""}`);
  if (g) console.log(`    grounding: ${g.outcome}${g.outcome === "grounded" ? ` (about ${g.about}, days ${g.days}, searches ${g.searches}; kept: ${g.known}; email/calendar: ${g.live})` : ""}, ${g.ms} ms`);
  for (const s of r.searches) console.log(`    search "${String(s.args?.query ?? "").slice(0, 80)}": ${s.result.replace(/\s+/g, " ").slice(0, DRY ? 400 : 160)}`);
  for (const t of r.texts) console.log(`    Sunshine: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
}
console.log(`\narm ${ARM}${DRY ? " (dry)" : ""}: ${Object.keys(done).length} answers in ${outFile}, $${spent.toFixed(3)} this run${blocked.length ? `; Hindsight writes refused: ${blocked.length} (${[...new Set(blocked)].join(", ")})` : ""}`);
await embedder?.close?.();
process.exit(0);
