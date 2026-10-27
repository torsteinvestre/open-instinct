// [sunshine:recordings] The wording test (2026-10-27): what Sunshine says around recordings and learning the owner's
// voice. Live (2026-10-26) it answered "I'll tell you if it doesn't work" and passed on the internal label
// "Speaker N", both echoing this fork's tool texts. Real server, real model (Sonnet 5.5), a stand-in transcription
// service; nothing reaches anyone (the outbox only records). Cases, in this order:
//   hint   a recording sent before the owner's voice is known: the reply to recording_add's result (the stand-in
//          never answers, so no further model call)
//   voice  a voice memo: the reply when learning starts, and the reply to the note when it is learned
// Each reply is checked for a conditional promise, an internal label and machine talk (CHECKS).
//
// Usage (from packages/server, after `pnpm build`): CASES=hint[,voice] MAX_USD=0.10 node scenarios/voice-wording.mjs
//   DRY=1   checks the checks on known answers (Torstein's real replies of 2026-10-26); no model call
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKS = {
  "conditional promise": /\b(?:i'll|i will|i'd|will)\s+(?:let you know|tell you|text you|update you)\b[^.!?]*\bif\b|\bif (?:it|that|this) (?:doesn't|does not|didn't|fails|failed)\b/i,
  "internal label": /\bspeaker\s*(?:n\b|\d)/i,
  "machine talk": /\b(?:voice_mine|recording_add|history_search|tool|background (?:job|task)|503|\d+(?:\.\d+)? ?MB)\b/i,
};
const flags = (text) => Object.entries(CHECKS).filter(([, re]) => re.test(text)).map(([name]) => name);

if (process.env.DRY) {
  const known = [
    ["Got it, I'm learning your voice now. I'll tell you if it doesn't work.", ["conditional promise"]],
    ['Your voice is saved. From now on, your lines in recordings will show as you, not "Speaker N".', ["internal label"]],
    ["Transcribing it now (17.6 MB); the summary reaches you when it is done.", ["machine talk"]],
    ["Got it, learning your voice now. I'll let you know when it's done.", []],
    ["Done, I can now tell your voice apart from other people in recordings.", []],
    ["On it. I'll send you the summary in a few minutes.", []],
    ["Got it. I don't know your voice yet, so send me 30 seconds of just you talking and I'll learn it.", []],
  ];
  let ok = 0;
  for (const [text, want] of known) {
    const got = flags(text);
    const right = JSON.stringify(got) === JSON.stringify(want);
    ok += right;
    console.log(`${right ? "ok   " : "WRONG"} ${JSON.stringify(got)} <- ${text}`);
  }
  console.log(`${ok}/${known.length} known answers checked right`);
  process.exit(ok === known.length ? 0 : 1);
}

const { boot } = await import("../dist/boot.js");
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");
const CASES = (process.env.CASES ?? "hint,voice").split(",").map((c) => c.trim());
const MAX_USD = Number(process.env.MAX_USD ?? 0.1);
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";
const STUB = "https://transcribe.stub";
const dir = mkdtempSync(join(tmpdir(), "voice-wording-"));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-torstein-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  MEMORY_PASS_MODEL: "off", INTAKE_MODEL: "off",
  TRANSCRIBE_URL: STUB, TRANSCRIBE_KEY: "stub",
};
// The stand-in service: an enrolment succeeds; a transcription never answers (the hint case needs no further call).
const fetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith(STUB)) throw new Error(`offline: ${url}`);
  const job = JSON.parse(init.body).job;
  if (job === "enrol") return new Response(JSON.stringify({ status: "ok", seconds: 34, vector: "AAAAAA==", model: "stub" }), { status: 200 });
  return new Promise(() => {});
};
const sent = [];
const app = await boot(env, { fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {}, markRead: async () => {} }, logger: () => {} });

function spent() {
  let total = 0;
  const sessions = join(dir, "sessions");
  if (!existsSync(sessions)) return 0;
  for (const f of readdirSync(sessions)) for (const m of readFileSync(join(sessions, f), "utf8").matchAll(/"cost":\{[^{}]*?"total":([0-9.eE-]+)/g)) total += Number(m[1]);
  return total;
}
const inbound = join(dir, "workspace", "inbound");
mkdirSync(inbound, { recursive: true });
const attach = (name) => {
  const path = join(inbound, `${name}.bin`);
  writeFileSync(path, Buffer.alloc(4000, 7));
  return [{ mimeType: "audio/mp4", path }];
};
const say = async (id, text, attachments) => {
  const before = sent.length;
  await app.runtime.handleInbound({ id, channel: "imessage", from: OWNER, conversationKey: "imessage:torstein", text, attachments, replyRef: {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
  return sent.slice(before).map((m) => m.text);
};
const report = (label, texts) => {
  if (texts.length === 0) console.log(`  ${label}: (nothing sent)`);
  for (const t of texts) console.log(`  ${label}: ${JSON.stringify(t)}  flags: ${JSON.stringify(flags(t))}`);
};

for (const c of CASES) {
  if (spent() >= MAX_USD) {
    console.log(`stopping before "${c}": spent $${spent().toFixed(3)} of MAX_USD ${MAX_USD}`);
    break;
  }
  if (c === "hint") {
    console.log("=== hint: a recording, the owner's voice not known yet");
    report("reply", await say("evt_rec", "Here's the meeting from earlier", attach("meeting")));
  } else if (c === "voice") {
    console.log("=== voice: a voice memo to learn the owner's voice");
    report("reply", await say("evt_voice", "This is my voice, just so you know and can learn it", attach("voice")));
    const before = sent.length;
    for (let i = 0; i < 120 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 1000));
    report("note reply", sent.slice(before).map((m) => m.text));
  }
  console.log(`  spent so far: $${spent().toFixed(3)}`);
}
console.log(`total: $${spent().toFixed(3)}`);
await app.close?.();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
