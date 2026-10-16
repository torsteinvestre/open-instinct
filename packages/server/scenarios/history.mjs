// [sunshine:history] Does Sunshine look up what it can no longer see, answer from what it finds, and
// not invent what was never said? Runs the real AgentRuntime (real system prompt, core tools with the
// history tools) against Sonnet 5.5. The live conversation is empty, as after a trim; older talk
// exists only in the kept history: a bike lock code from Monday and the fund-vs-apartment answer from
// Thursday. Asks for both, and for something never said. Prints each reply, the tools used, and
// whether the answer has what the history holds (or, for the last, no made-up date). Nothing is sent
// anywhere. Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/history.mjs   (about 5 cents)
import {
  AgentRuntime, ApprovalStore, AuditLog, ContactStore, DEFAULT_PERSONA, HistoryArchive, MemoryStore, PolicyEngine, Scheduler,
  StateDir, ToolRegistry, coreTools, defaultConfig, defaultPolicy, resolveModel,
} from "@open-instinct/core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const NOW = new Date("2026-10-16T10:00:00Z"); // Friday 12:00 in Oslo
const KEY = "imessage:c1";

const dir = mkdtempSync(join(tmpdir(), "history-"));
const state = new StateDir(dir); state.ensure();
writeFileSync(join(dir, "PERSONA.md"), DEFAULT_PERSONA);
const config = defaultConfig();
config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
config.agent = { ...config.agent, name: "Sunshine" };
const memory = new MemoryStore(state);
memory.replaceDurable("# Memory\n## About Torstein\n- Lives in Oslo.\n- Has about 1.5M NOK in an aksjesparekonto (fund).\n## Lately\n- Weighing buying in Oslo against keeping money in the fund.");
const history = new HistoryArchive(state, { now: () => NOW });
const msg = (role, text, iso) => (role === "user"
  ? { role, content: [{ type: "text", text }], timestamp: Date.parse(iso) }
  : { role, content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: Date.parse(iso) });
history.record(KEY, [
  msg("user", "btw my new bike lock code is 4471, dont let me forget it", "2026-10-12T16:20:00Z"),
  msg("assistant", "Got it, 4471. I'll remember.", "2026-10-12T16:20:05Z"),
  msg("user", "I have a fund, what should be considered in the fund vs apartment", "2026-10-15T08:47:00Z"),
  msg("assistant", "Four things decide it for you. 1) Equity: banks need at least 10% of the price, and your 1.5M covers that for most Oslo flats. 2) Rates: Norges Bank is at 4.5% and may go higher, so test the monthly cost at 7.5%. 3) Tax: the ASK is only taxed when you take money out, while a home you live in for a year is tax-free on sale. 4) Costs: fees, upkeep and common costs usually add 1-2% a year.", "2026-10-15T08:47:20Z"),
  msg("user", "About 1,5 million NOK and yeah aksjesparekonto", "2026-10-15T08:52:00Z"),
  msg("assistant", "Then the ASK keeps working for you until you find a flat you really want.", "2026-10-15T08:52:10Z"),
]);

const scheduler = new Scheduler(state), approvals = new ApprovalStore(state), audit = new AuditLog(state), contacts = new ContactStore(state);
const outbox = { send: async () => {} };
const registry = new ToolRegistry();
registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox, history }));
const runtime = new AgentRuntime({
  state, config, policy: new PolicyEngine(defaultPolicy()), approvals, audit, scheduler, contacts, memory, registry, history,
  model: resolveModel("anthropic/claude-sonnet-5-5"), outbox, streamFn: streamSimple, getApiKey: () => apiKey, replyBudgetMs: 120_000,
  now: () => NOW,
});

const QUESTIONS = [
  { text: "what was my bike lock code again?", check: (r) => r.includes("4471") ? "has 4471" : "MISSING 4471" },
  { text: "what were the main points you gave me about fund vs apartment on thursday?", check: (r) => (/10 ?%/.test(r) && /tax|skatt/i.test(r) ? "has the 10% equity and the tax point" : "MISSING points") },
  // Any date but the ones the kept history really has (it starts on Monday 12 Oct; a first run's
  // "they only go back to Monday 12 Oct" was flagged as made up).
  { text: "did I ever tell you when my mom's birthday is?", check: (r) => (/\b\d{1,2}(\.|st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b/i.test(r.replace(/\b(12|15|16)\s+oct(ober)?\b|\boct(ober)?\s+(12|15|16)\b/gi, "")) ? "MADE UP A DATE" : "no date made up") },
];
let cost = 0;
for (const [i, q] of QUESTIONS.entries()) {
  const res = await runtime.handleInbound({ id: `h${i}`, channel: "imessage", from: "+4790000000", conversationKey: KEY, text: q.text, replyRef: {}, receivedAt: NOW.toISOString() });
  const conv = runtime.conversation(KEY, runtime.ownerPrincipal());
  const msgs = conv.agent.state.messages;
  const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
  const turn = msgs.slice(lastUser);
  const tools = turn.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall").map((c) => `${c.name}(${JSON.stringify(c.arguments)})`) : []));
  for (const m of turn) if (m.role === "assistant") cost += m.usage?.cost?.total ?? 0;
  const reply = String(res.reply ?? "");
  console.log(`\n> ${q.text}\n  tools: ${tools.join(", ") || "none"}\n  reply: ${reply.replace(/\n/g, " / ")}\n  check: ${q.check(reply)}`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\nCost: $${cost.toFixed(4)}`);
