// [sunshine:meeting] Checklist #3: does the agent turn a meeting it "heard" into what its person wants? Boots the
// real server (prompt, tools, Sonnet 5.5) for a person on a temporary data folder, hands it a named meeting
// transcript as a system task (the way the audio backend would, through upstream's runSystemTask), then has the
// person ask a question about the meeting in their own thread. Prints what the agent did: tool calls, texts,
// reminders, memory, the answer, the cost. Nothing reaches anyone: the outbox only records.
//
// Usage (from packages/server, after `pnpm build`; ANTHROPIC_API_KEY set):
//   TRANSCRIPT=<named transcript.txt> node scenarios/meeting-transcript.mjs
//   DRY=1 ...   boots, builds the task, prints its size: free
// Defaults: the AMI ES2004b meeting from ~/sunshine-audio (Maya = the marketing expert), MAX_USD 0.2 before the question.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");
const TRANSCRIPT = process.env.TRANSCRIPT ?? join(homedir(), "sunshine-audio/out/ES2004b.named.txt");
const MAX_USD = Number(process.env.MAX_USD ?? 0.2);
const QUESTION = process.env.QUESTION ?? "hey what did we decide about who the remote is for?";
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";
const transcript = readFileSync(TRANSCRIPT, "utf8").trim();

const dir = mkdtempSync(join(tmpdir(), "meeting-"));
mkdirSync(join(dir, "memory"), { recursive: true });
writeFileSync(join(dir, "memory", "MEMORY.md"), [
  "## About",
  "- Maya is the marketing expert in a team designing a new TV remote control.",
  "",
  "## People",
  "- Sarah: project manager on Maya's team.",
  "- Ian: industrial designer on Maya's team.",
  "- Una: interface designer on Maya's team.",
  "",
].join("\n"));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
  INSTINCT_OWNER_NAME: "Maya", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-maya-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  MEMORY_PASS_MODEL: "off",
};
const fetchImpl = async (input) => { throw new Error(`offline: ${typeof input === "string" ? input : input.url}`); };
const sent = [];
const app = await boot(env, { fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {}, markRead: async () => {} }, logger: () => {} });

const fmt = (d) => d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo" });
const end = new Date(Date.now() - 10 * 60 * 1000);
const start = new Date(end.getTime() - 39 * 60 * 1000);
// What the audio backend would send: the data, the job and when it is done, nothing about how.
const prompt = [
  `A transcript arrived from Maya's band: a meeting Maya was in, ${fmt(start)} to ${fmt(end)} (Oslo time).`,
  "Names come from voice recognition (\"Unknown speaker\" is a voice Maya has not connected with), and the words can contain recognition mistakes.",
  "",
  "Handle it the way a great personal assistant would: keep what Maya will want to know later, and follow up on what needs following up. Text her only if something needs her attention; otherwise end with exactly NO_REPLY.",
  "",
  "<transcript>",
  transcript,
  "</transcript>",
].join("\n");
console.log(`transcript: ${transcript.split("\n").length} lines, ${transcript.split(/\s+/).length} words; task ${prompt.length} characters`);
if (process.env.DRY) { await app.close?.(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }

function spent() {
  let total = 0;
  const sessions = join(dir, "sessions");
  if (!existsSync(sessions)) return 0;
  for (const f of readdirSync(sessions)) for (const m of readFileSync(join(sessions, f), "utf8").matchAll(/"cost":\{[^{}]*?"total":([0-9.eE-]+)/g)) total += Number(m[1]);
  return total;
}
function toolCalls(key, principal) {
  const msgs = app.runtime.conversation(key, principal).agent.state.messages;
  return msgs.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c) => c.type === "toolCall")).map((c) => `${c.name} ${JSON.stringify(c.arguments).slice(0, 400)}`);
}

const owner = app.runtime.ownerPrincipal();
const t0 = Date.now();
const final = await app.runtime.runSystemTask({ id: "meeting-es2004b", name: "meeting transcript", prompt });
console.log(`\n=== the agent's work on the transcript (${((Date.now() - t0) / 1000).toFixed(0)}s, $${spent().toFixed(3)} so far)`);
for (const c of toolCalls("system:meeting-es2004b", owner)) console.log(`  tool: ${c}`);
console.log(`  final reply: ${final.slice(0, 600)}`);
console.log("\n=== texts to Maya");
for (const m of sent) console.log(`  ${m.text}`);
console.log("\n=== reminders and jobs");
const schedules = existsSync(join(dir, "schedules.json")) ? JSON.parse(readFileSync(join(dir, "schedules.json"), "utf8")) : [];
for (const s of (Array.isArray(schedules) ? schedules : schedules.entries ?? schedules.jobs ?? [])) if (!s.gate) console.log(`  ${s.name}: ${s.text ?? s.prompt} | next ${s.nextRunAt} ${s.cron ? `cron ${s.cron}` : ""}`);
console.log("\n=== MEMORY.md after");
console.log(readFileSync(join(dir, "memory", "MEMORY.md"), "utf8"));

if (spent() > MAX_USD) {
  console.log(`\nNot asking the question: spent $${spent().toFixed(3)}, over MAX_USD ${MAX_USD}.`);
} else {
  const before = sent.length;
  await app.runtime.handleInbound({ id: "evt_q1", channel: "imessage", from: OWNER, conversationKey: "imessage:maya", text: QUESTION, replyRef: {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
  console.log(`\n=== Maya asks: ${QUESTION}`);
  for (const c of toolCalls("imessage:maya", owner)) console.log(`  tool: ${c}`);
  for (const m of sent.slice(before)) console.log(`  answer: ${m.text}`);
}
console.log(`\ntotal: $${spent().toFixed(3)}`);
await app.close?.();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
