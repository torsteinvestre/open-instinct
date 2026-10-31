// [sunshine:flowing-in] The gate on the owner's REAL email (paid: the small model's reading only, Claude Haiku 5.5;
// about 10 cents for 112 emails; Torstein's OK each run). The question: of what arrives by itself, does the reading's
// "needs" send to the agent what it should act on or tell (an event he goes to or is invited to, a request or deadline
// for him, a change to his plans) and keep the rest quiet? Each email goes through the real path: the flow's email rule
// (flowing-in.ts) -> the intake's reading (intake.ts) with the real small model, his saved notes, read as of the email's
// own date. Only the hand-off is replaced: the agent is not run, nothing is texted. Graded against a key written before
// the paid run (KEY: { "<email id>": { "want": "hand" | "quiet" | "either", "why": "..." } }).
// Deliberate differences from live: the notes are one later snapshot (an email from February is read with October's
// notes); no recall or live look-up (they only shape the hand-off, not the gate).
//
// Usage (from packages/server, after `pnpm build`):
//   OWNER_NAME=... OWNER_EMAIL=... DRY=1 node scenarios/gate-real.mjs   free: the real path with a stand-in reader;
//       writes the listing to key from, counts the reading's input tokens (Anthropic's free count_tokens) for the
//       estimate, checks the grader on known answers
//   OWNER_NAME=... OWNER_EMAIL=... ANTHROPIC_API_KEY=... MAX_USD=0.3 node scenarios/gate-real.mjs   the paid run
//   COMPARE=<an earlier results-*.json>   also lists every email whose outcome changed since that run
// Files (defaults): EMAILS ~/sunshine-memory/hindsight-real/emails.json, NOTES ~/sunshine-memory/hindsight-real/MEMORY.md,
// OUT ~/sunshine-memory/gate-real (KEY defaults to OUT/key.json; results-<time>.json written there).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, ItemArchive, MemoryStore, StateDir, defaultConfig } from "@open-instinct/core";
import { modelCall, resolveWatcherModel } from "@open-instinct/watcher";
import { TRIGGERS, createFlowIn } from "../dist/flowing-in.js";
import { DEFAULT_INTAKE_SMALL_MODEL, GATED_SUMMARY_SCHEMA, INTAKE_SMALL_REASONING, createIntake, parseNeeds } from "../dist/intake.js";

const TZ = "Europe/Oslo";
const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const home = (p) => p.replace(/^~/, homedir());
const EMAILS = home(process.env.EMAILS ?? "~/sunshine-memory/hindsight-real/emails.json");
const NOTES = home(process.env.NOTES ?? "~/sunshine-memory/hindsight-real/MEMORY.md");
const OUT = home(process.env.OUT ?? "~/sunshine-memory/gate-real");
const KEY = home(process.env.KEY ?? join(OUT, "key.json"));
const DRY = Boolean(process.env.DRY);
const MAX_USD = Number(process.env.MAX_USD ?? 0.3);
const OWNER = need("OWNER_NAME");
const OWNER_EMAIL = need("OWNER_EMAIL");

const when = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** "hand" when the reading sent it to the agent, "quiet" when it was kept with nothing to act on. */
const gotOf = (r) => (r.intake === "handed over" ? "hand" : r.intake === "kept, nothing to act on" ? "quiet" : undefined);

/** Every email taken in against the key. A miss: the key says hand, it stayed quiet. Noise: the key says quiet, it was handed. */
export function grade(results, key) {
  const g = { hand: 0, quiet: 0, either: 0, missed: [], noise: [], unkeyed: [], unread: [] };
  for (const r of results) {
    if (r.flow !== "taken in") continue;
    const got = gotOf(r);
    if (!got) { g.unread.push(r); continue; }
    const want = key[r.id]?.want;
    if (!want) { g.unkeyed.push(r); continue; }
    g[want]++;
    if (want === "hand" && got === "quiet") g.missed.push(r);
    if (want === "quiet" && got === "hand") g.noise.push(r);
  }
  return g;
}

if (DRY && process.env.DRY === "grader") {
  const r = (id, intake) => ({ id, flow: "taken in", intake });
  const key = { a: { want: "hand" }, b: { want: "quiet" }, c: { want: "either" }, d: { want: "hand" }, e: { want: "quiet" } };
  const g = grade([r("a", "handed over"), r("b", "handed over"), r("c", "kept, nothing to act on"), r("d", "kept, nothing to act on"), r("e", "kept, nothing to act on"), r("f", "handed over"), r("g", "failed"), { id: "h", flow: "left out" }], key);
  const ok = g.missed.map((x) => x.id).join() === "d" && g.noise.map((x) => x.id).join() === "b" && g.unkeyed.map((x) => x.id).join() === "f" && g.unread.map((x) => x.id).join() === "g" && g.hand === 2 && g.quiet === 2 && g.either === 1;
  console.log(ok ? "grader: known answers right" : `grader WRONG: ${JSON.stringify(g)}`);
  process.exit(ok ? 0 : 1);
}

const emails = JSON.parse(readFileSync(EMAILS, "utf8")).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const notes = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
const key = existsSync(KEY) ? JSON.parse(readFileSync(KEY, "utf8")) : {};
mkdirSync(OUT, { recursive: true });

// The reader: the real small model, or (DRY) a stand-in that keeps what it was asked, for counting.
const asked = [];
const model = DRY
  ? async (req) => (asked.push(req), { text: JSON.stringify({ title: "t", summary: "s.", decisions: [], owner_tasks: [], others_tasks: [], open: [], to_settle: [], searches: [], days: [], needs: [] }), costUsd: 0 })
  : modelCall(resolveWatcherModel(process.env.INTAKE_SMALL_MODEL?.trim() || DEFAULT_INTAKE_SMALL_MODEL, process.env), { reasoning: INTAKE_SMALL_REASONING, apiKey: need("ANTHROPIC_API_KEY") });
// Every need the reading wrote, with its kind (the hand-off shows only those that call for the agent).
let lastNeeds = [];
const call = async (req) => {
  const reply = await model(req);
  lastNeeds = parseNeeds(reply.text);
  return reply;
};

const dir = mkdtempSync(join(tmpdir(), "gate-real-"));
const results = [];
let spent = 0;
try {
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: OWNER, timezone: TZ, emails: [OWNER_EMAIL] };
  config.agent = { ...config.agent, name: "Sunshine" };
  const memory = new MemoryStore(state);
  if (notes.trim()) memory.replaceDurable(notes);
  const audit = new AuditLog(state);
  const items = new ItemArchive(state, { now: () => new Date(emails.at(-1).at) });
  const handed = new Map();
  const intake = createIntake({ items, memory, config, audit, smallCall: call, runTask: async (t) => (handed.set(t.id, t.prompt), "NO_REPLY") });
  // The flow starts at the first email, so none is left out as catch-up.
  const flow = createFlowIn({ intake, items, state, config, audit, now: () => Date.parse(emails[0].at) });

  for (const e of emails) {
    if (spent >= MAX_USD) { console.log(`stopped: $${spent.toFixed(4)} spent (cap $${MAX_USD})`); break; }
    lastNeeds = [];
    const r = await flow.receive({ type: "app.event", id: `gate-${e.id}`, trigger: TRIGGERS.emailReceived, data: { id: e.id, thread_id: e.thread, label_ids: e.labels, sender: e.from, to: e.to, subject: e.subject, message_timestamp: e.at, message_text: e.text } });
    const cost = r.intake?.costUsd ?? 0;
    spent += cost;
    const kept = r.itemId ? items.get(r.itemId) : undefined;
    const prompt = r.itemId ? handed.get(`intake-${r.itemId}`) : undefined;
    const needs = /May need you now:\n((?:- .*\n?)+)/.exec(prompt ?? "")?.[1]?.trim().split("\n").map((l) => l.replace(/^- /, "")) ?? [];
    results.push({ id: e.id, at: e.at, from: e.from, subject: e.subject, labels: e.labels, flow: r.outcome, why: r.why, intake: r.intake?.outcome, needs, kinds: lastNeeds, title: kept?.summary?.title, summary: kept?.summary?.summary, costUsd: cost, text: DRY ? kept?.text : undefined });
    if (!DRY) {
      const g = gotOf(results.at(-1));
      const want = key[e.id]?.want ?? "?";
      const all = lastNeeds.map((n) => `${n.kind || "?"}: ${n.what}`).join(" | ");
      console.log(`${String(results.length).padStart(3)} ${g === "hand" ? "HAND " : g === "quiet" ? "quiet" : (r.intake?.outcome ?? r.outcome).padEnd(5)} key=${want.padEnd(6)} ${when(Date.parse(e.at))} ${e.subject.slice(0, 70)}${all ? `\n      needs: ${all.slice(0, 220)}` : ""}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (DRY) {
  // The listing to write the key from: what the reader sees, before any model output exists.
  const lines = results.map((r, i) => {
    const body = (r.text ?? "").split("\n\n").slice(1).join(" ").replace(/\s+/g, " ").slice(0, 280);
    return `#${i + 1} ${r.id} | ${when(Date.parse(r.at))} | ${r.flow}${r.flow === "taken in" ? "" : ` (${r.why})`} | ${(r.labels ?? []).filter((l) => /CATEGORY|IMPORTANT/.test(l)).join(",")}\n  From: ${r.from}\n  Subject: ${r.subject}\n  ${body}`;
  });
  writeFileSync(join(OUT, "listing.txt"), lines.join("\n\n") + "\n");
  console.log(`taken in ${results.filter((r) => r.flow === "taken in").length}, left out ${results.filter((r) => r.flow !== "taken in").length}; listing: ${join(OUT, "listing.txt")}`);
  console.log(`keyed: ${results.filter((r) => key[r.id]).length} of ${results.length}`);
  // The estimate: Anthropic's count_tokens (free) on each reading's input; the answer's form and thinking come on top.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    let tokens = 0;
    for (const req of asked) {
      const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-5-5", system: req.system, messages: [{ role: "user", content: req.user }] }),
      });
      const j = await res.json();
      if (!res.ok) { console.log("count_tokens failed:", res.status, JSON.stringify(j).slice(0, 200)); break; }
      tokens += j.input_tokens;
    }
    const schemaChars = JSON.stringify(GATED_SUMMARY_SCHEMA).length;
    const out = Number(process.env.EST_OUTPUT_TOKENS ?? 600);
    const usd = (tokens * 0.1 + asked.length * out * 0.5) / 1e6;
    console.log(`readings ${asked.length}: input ${tokens} tokens (avg ${Math.round(tokens / Math.max(1, asked.length))}; the form's ${schemaChars} characters come on top); output assumed ${out} each incl. thinking`);
    console.log(`estimate: $${usd.toFixed(3)} for this run (Haiku 5.5: $0.10 in / $0.50 out per million)`);
  } else console.log("no ANTHROPIC_API_KEY: no token count");
  process.exit(0);
}

const file = join(OUT, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), spent, results }, null, 1));
const g = grade(results, key);
const taken = results.filter((r) => r.flow === "taken in");
console.log(`\nspent $${spent.toFixed(4)} for ${taken.length} readings ($${(spent / Math.max(1, taken.length)).toFixed(5)} each); results ${file}`);
console.log(`handed over ${taken.filter((r) => gotOf(r) === "hand").length} of ${taken.length}`);
console.log(`key: hand ${g.hand}, quiet ${g.quiet}, either ${g.either}; MISSED ${g.missed.length}, NOISE ${g.noise.length}, unkeyed ${g.unkeyed.length}, unread ${g.unread.length}`);
for (const r of g.missed) console.log(`  missed: ${when(Date.parse(r.at))} ${r.subject.slice(0, 80)} (key: ${key[r.id]?.why ?? ""}) -> ${(r.kinds ?? []).map((n) => `${n.kind}: ${n.what}`).join(" | ").slice(0, 160)}`);
for (const r of g.noise) console.log(`  noise:  ${when(Date.parse(r.at))} ${r.subject.slice(0, 80)} -> ${r.needs.join(" | ").slice(0, 160)}`);
for (const r of g.unread) console.log(`  unread: ${r.subject.slice(0, 80)} (${r.intake})`);

// The same emails in an earlier run: what changed, by what the key says.
if (process.env.COMPARE) {
  const before = new Map(JSON.parse(readFileSync(home(process.env.COMPARE), "utf8")).results.map((r) => [r.id, r]));
  const flips = results.filter((r) => before.has(r.id) && gotOf(before.get(r.id)) !== gotOf(r));
  const was = grade([...before.values()], key);
  console.log(`\ncompared with ${process.env.COMPARE}: before missed ${was.missed.length}, noise ${was.noise.length}, handed ${[...before.values()].filter((r) => gotOf(r) === "hand").length}; ${flips.length} emails changed`);
  for (const r of flips) console.log(`  ${gotOf(before.get(r.id))} -> ${gotOf(r)}  key=${key[r.id]?.want ?? "?"}  ${r.subject.slice(0, 70)}`);
}
