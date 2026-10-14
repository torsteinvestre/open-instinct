// [sunshine:relative-time] Does Sunshine set reminders at the right time? Builds the real system
// prompt for the owner's iMessage thread (Europe/Oslo), offers the real schedule_create tool, plays
// varied requests through Sonnet 5.5 and checks the time each reminder was set for, and the clock
// time the reply states. "new" is the current tool (inMinutes, local time in the result); "old" is
// the tool as it was (an ISO `at` only), so the model does the sum itself. The clock is frozen per
// round (prompt, tool and expectations agree), so bash is left out: its `date` would disagree.
// Nothing is sent.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/reminders.mjs [rounds=2] [new|old|both=both]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ALL_CAPABILITIES, ApprovalStore, AuditLog, DEFAULT_PERSONA, MemoryStore, Scheduler, StateDir, buildSystemPrompt, coreTools, defaultConfig, resolveModel, timeStamp } from "@open-instinct/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] ?? 2);
const which = process.argv[3] ?? "both";
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const model = resolveModel("anthropic/claude-sonnet-5-5");
const TZ = "Europe/Oslo";

const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: TZ };
config.agent = { ...config.agent, name: "Sunshine" };
const owner = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4790000000" };
const systemAt = (now) => buildSystemPrompt({
  config, principal: owner, channel: "imessage", now,
  capabilities: [...ALL_CAPABILITIES], toolGroups: ["messaging", "owner", "memory", "schedule", "web", "files"],
  memoryDigest: "Torstein lives in Oslo. Follows XRP and Norwegian startups. Loves Tine iskaffe.", persona: DEFAULT_PERSONA,
});

// The real schedule_create, on a throwaway scheduler.
const dir = mkdtempSync(join(tmpdir(), "reminders-"));
const state = new StateDir(dir); state.ensure();
const scheduler = new Scheduler(state);
const core = coreTools({ memory: new MemoryStore(state), scheduler, approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} } });
const schedule = core.find((t) => t.spec.name === "schedule_create").spec;
const OLD = {
  description: "Schedule a prompt to run later. Give cron (5 fields, in tz) for repeating jobs or at (ISO timestamp) for one-shot. The prompt runs as the owner and the result is texted to them.",
  parameters: (() => {
    const p = structuredClone(schedule.parameters);
    delete p.properties.inMinutes;
    p.properties.at = { ...p.properties.at, description: "ISO timestamp for a one-shot run" };
    return p;
  })(),
};

// Wall-clock time in Oslo -> UTC ms, with the offset of that date (winter time from 25 October).
const parts = (ms, extra = {}) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...extra }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const offsetMin = (ms) => { const p = parts(ms); return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000; };
const oslo = (y, mo, d, h, mi) => { const wall = Date.UTC(y, mo - 1, d, h, mi); return wall - offsetMin(wall - offsetMin(wall) * 60000) * 60000; };
const hhmm = (ms) => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
/** h:mi in Oslo, `days` days after today; with days = 0, tomorrow if that time has passed. */
function nextAt(now, h, mi, days = 0) {
  const p = parts(now);
  const t = oslo(+p.year, +p.month, +p.day + days, h, mi);
  return days === 0 && t <= now ? oslo(+p.year, +p.month, +p.day + 1, h, mi) : t;
}
function nextWeekday(now, weekday, h, mi) {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let ahead = (names.indexOf(weekday) - names.indexOf(parts(now, { weekday: "short" }).weekday) + 7) % 7;
  if (ahead === 0) { const p = parts(now); if (oslo(+p.year, +p.month, +p.day, h, mi) <= now) ahead = 7; }
  return nextAt(now, h, mi, ahead);
}

// rel: minutes from now; abs: an exact Oslo clock time. One minute of leeway either way.
const S = [
  { name: "in 5 minutes", msg: "remind me in 5 minutes to drink water", rel: 5 },
  { name: "in 3 min", msg: "in 3 min text me TEST", rel: 3 },
  { name: "in an hour", msg: "remind me to stretch in an hour", rel: 60 },
  { name: "in 90 minutes", msg: "remind me in 90 minutes to check the oven", rel: 90 },
  { name: "in 2 hours", msg: "in 2 hours remind me to call mom", rel: 120 },
  { name: "in half an hour", msg: "remind me in half an hour to move the car", rel: 30 },
  { name: "om 10 minutter (Norwegian)", msg: "om 10 minutter, minn meg på å ta ut klesvasken", rel: 10 },
  { name: "in 2 days", msg: "remind me in 2 days to pay rent", rel: 2 * 24 * 60 },
  { name: "at 18:00", msg: "remind me at 18:00 to buy iskaffe", abs: (now) => nextAt(now, 18, 0) },
  { name: "tomorrow at 9", msg: "remind me tomorrow at 9 to call the dentist", abs: (now) => nextAt(now, 9, 0, 1) },
  { name: "friday at 15:00", msg: "remind me on friday at 15:00 to submit the report", abs: (now) => nextWeekday(now, "Fri", 15, 0) },
  { name: "27 October 10:00 (winter time)", msg: "remind me on 27 October at 10:00 to renew my passport", abs: () => oslo(2026, 10, 27, 10, 0) },
  { name: "7:30 tomorrow morning", msg: "remind me at 7:30 tomorrow morning to go running", abs: (now) => nextAt(now, 7, 30, 1) },
  { name: "23:15 tonight", msg: "set a reminder for 23:15 tonight to go to bed", abs: (now) => nextAt(now, 23, 15) },
];
// A little earlier chat that never touched the clock, as in a real thread.
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const HISTORY = [
  user("what's a good name for a grey cat?"), asst("Smoke, Ash or Pepper. If it's a bit grumpy: Gandalf."),
  user("haha Gandalf it is"), asst("Good choice. He'll live up to it."),
];

let cost = 0;
const results = Object.fromEntries((which === "both" ? ["new", "old"] : [which]).map((v) => [v, []]));
for (const variant of Object.keys(results)) {
  const tool = variant === "new" ? { name: schedule.name, description: schedule.description, parameters: schedule.parameters } : { name: schedule.name, ...OLD };
  for (let r = 0; r < rounds; r++) {
    const now = Date.now(); // frozen for the round: prompt, tool and expectations agree
    const systemPrompt = systemAt(new Date(now));
    const ctx = { principal: owner, conversationKey: "imessage:test", channel: "imessage", now: () => new Date(now) };
    for (const s of S) {
      const expected = s.rel !== undefined ? now + s.rel * 60000 : s.abs(now);
      // [sunshine:stable-cache] The clock rides on the message, as the runtime sends it.
      const messages = [...HISTORY, user(`${timeStamp(new Date(now), TZ)}\n${s.msg}`)];
      let set, finalText = "";
      const how = [];
      for (let turn = 0; turn < 6; turn++) {
        const reply = await completeSimple(model, { systemPrompt, messages, tools: [tool] }, { apiKey, reasoning: "medium" });
        cost += reply.usage?.cost?.total ?? 0;
        messages.push(reply);
        const calls = reply.content.filter((c) => c.type === "toolCall");
        finalText = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
        if (calls.length === 0) break;
        for (const c of calls) {
          const a = c.arguments ?? {};
          how.push(a.inMinutes !== undefined ? `inMinutes=${a.inMinutes}` : a.at ? `at=${a.at}` : a.cron ? `cron=${a.cron}` : "?");
          const res = await schedule.execute(variant === "new" ? a : { ...a, inMinutes: undefined }, ctx);
          let text = typeof res === "string" ? res : res.content.map((x) => x.text ?? "").join("");
          const isError = typeof res !== "string" && res.isError === true;
          if (variant === "old") text = text.replace(/ \([^)]*\)\.$/, ".");
          const m = /Next run: (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(text);
          if (m && !isError) set = Date.parse(m[1]);
          messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text }], isError, timestamp: Date.now() });
        }
      }
      const offBy = set === undefined ? undefined : Math.round((set - expected) / 60000);
      const ok = set !== undefined && Math.abs(set - expected) <= 60000;
      // What the reply says: the right clock time, a wrong one, or none.
      const times = [...finalText.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)].map((x) => `${x[1].padStart(2, "0")}:${x[2]}`);
      const near = [-1, 0, 1].map((d) => hhmm(expected + d * 60000));
      const says = times.length === 0 ? "none" : times.some((t) => near.includes(t)) ? "right" : "WRONG";
      results[variant].push({ round: r + 1, name: s.name, ok, offBy, how: how.join(" > "), says, expected: hhmm(expected), reply: finalText.slice(0, 100).replace(/\n/g, " / ") });
      for (const e of scheduler.list()) scheduler.delete(e.id);
    }
  }
}
rmSync(dir, { recursive: true, force: true });

for (const [variant, rows] of Object.entries(results)) {
  console.log(`\n===== ${variant.toUpperCase()}: right time ${rows.filter((x) => x.ok).length}/${rows.length}; reply states a wrong time: ${rows.filter((x) => x.says === "WRONG").length}`);
  console.log(`  used inMinutes ${rows.filter((x) => x.how.includes("inMinutes")).length}, at ${rows.filter((x) => x.how.includes("at=")).length}`);
  for (const x of rows) console.log(`  ${x.ok ? "ok  " : "MISS"} r${x.round} ${x.name.padEnd(30)} want ${x.expected} ${x.offBy === undefined ? "NOT SET" : `off ${x.offBy} min`}  [${x.how}]  says:${x.says}  "${x.reply}"`);
}
console.log(`\nCost: $${cost.toFixed(4)}`);
