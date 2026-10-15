// [sunshine:reminders] Does Sunshine tell a plain reminder (sent as written, no model run) from a job
// that has to look something up or decide? Builds the real system prompt for the owner's iMessage
// thread, offers the real schedule_create tool on a throwaway scheduler (one per request), plays
// varied requests through Sonnet 5.5 and checks what it created: a plain reminder, a job, or nothing
// when the repeating one would use more than its share of the day's texts (and then that the reply
// says why). Nothing is sent. About 15 cents a round.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/reminder-kinds.mjs [rounds=1]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ALL_CAPABILITIES, ApprovalStore, AuditLog, DEFAULT_PERSONA, MemoryStore, Scheduler, StateDir, buildSystemPrompt, coreTools, defaultConfig, resolveModel, timeStamp } from "@open-instinct/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 1);
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");
const TZ = "Europe/Oslo";

const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: TZ };
config.agent = { ...config.agent, name: "Sunshine" };
const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4790000000" };

// plain: sent as written; job: the model runs when it fires; refused: too many texts a day.
const S = [
  { kind: "plain", msg: "remind me in 5 minutes to stretch" },
  { kind: "plain", msg: "remind me to call mom at 18" },
  { kind: "plain", msg: "every hour from 9 to 17 remind me to drink water" },
  { kind: "plain", msg: "every weekday at 8:55 remind me that standup is in 5 minutes" },
  { kind: "plain", msg: "remind me on friday at 12 to buy flowers for mom's birthday" },
  { kind: "job", msg: "every day at 8 text me the weather in oslo" },
  { kind: "job", msg: "in 2 hours check if it's raining in oslo and only tell me if it is" },
  { kind: "job", msg: "every morning at 7 send me the xrp price" },
  { kind: "refused", msg: "every 2 minutes text me PING" },
];

const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
let cost = 0;
const rows = [];
for (let r = 0; r < rounds; r++) {
  for (const s of S) {
    const dir = mkdtempSync(join(tmpdir(), "reminder-kinds-"));
    try {
      const state = new StateDir(dir);
      state.ensure();
      const now = Date.now();
      const scheduler = new Scheduler(state, { now: () => new Date(now) });
      const schedule = coreTools({ memory: new MemoryStore(state), scheduler, approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} } }).find((t) => t.spec.name === "schedule_create").spec;
      const systemPrompt = buildSystemPrompt({
        config, principal: owner, channel: "imessage", now: new Date(now),
        capabilities: [...ALL_CAPABILITIES], toolGroups: ["messaging", "owner", "memory", "schedule", "web", "files"],
        memoryDigest: "Torstein lives in Oslo. Follows XRP and Norwegian startups.", persona: DEFAULT_PERSONA,
      });
      const ctx = { principal: owner, conversationKey: "imessage:test", channel: "imessage", now: () => new Date(now) };
      const messages = [user(`${timeStamp(new Date(now), TZ)}\n${s.msg}`)];
      const calls = [];
      let finalText = "";
      for (let turn = 0; turn < 6; turn++) {
        const reply = await completeSimple(model, { systemPrompt, messages, tools: [{ name: schedule.name, description: schedule.description, parameters: schedule.parameters }] }, { apiKey, reasoning: "medium" });
        cost += reply.usage?.cost?.total ?? 0;
        messages.push(reply);
        const tc = reply.content.filter((c) => c.type === "toolCall");
        finalText = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (tc.length === 0) break;
        for (const c of tc) {
          const a = c.arguments ?? {};
          const res = await schedule.execute(a, ctx);
          const text = typeof res === "string" ? res : res.content.map((x) => x.text ?? "").join("");
          calls.push(`${a.text !== undefined ? `text="${a.text}"` : `prompt="${String(a.prompt ?? "").slice(0, 80)}"`} ${a.cron ? `cron=${a.cron}` : a.inMinutes !== undefined ? `inMinutes=${a.inMinutes}` : a.at ? `at=${a.at}` : ""} -> ${text.slice(0, 70)}`);
          messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text }], isError: typeof res !== "string" && res.isError === true, timestamp: Date.now() });
        }
      }
      const jobs = scheduler.list();
      const got = jobs.length === 0 ? "nothing" : jobs.every((j) => j.text) ? "plain" : jobs.every((j) => !j.text) ? "job" : "mixed";
      const pass = s.kind === "refused" ? got === "nothing" && /100|texts a day/i.test(finalText) : got === s.kind;
      rows.push({ round: r + 1, ...s, got, pass, calls, reply: finalText });
      process.stderr.write(".");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
process.stderr.write("\n");
console.log(`${rows.filter((x) => x.pass).length}/${rows.length} as expected`);
for (const x of rows) {
  console.log(`\n${x.pass ? "ok  " : "MISS"} r${x.round} [${x.kind} -> ${x.got}] "${x.msg}"`);
  for (const c of x.calls) console.log(`     ${c}`);
  console.log(`     reply: ${x.reply.replace(/\n/g, " / ")}`);
}
console.log(`\nCost: $${cost.toFixed(4)}`);
