// [sunshine:stable-cache] Does the model's prompt cache hold from one message to the next? Runs the
// real AgentRuntime (real system prompt, core tools, the owner's chat thread) against Sonnet 5.5 and
// sends a few messages in a row, once with stableCache on and once off, then prints what each model
// call read from the cache, wrote to it, and cost. Also checks the clock reaches the model. Nothing
// is sent anywhere. Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):
//   node scenarios/cache.mjs
import {
  AgentRuntime, ApprovalStore, AuditLog, ContactStore, DEFAULT_PERSONA, MemoryStore, PolicyEngine, Scheduler, StateDir,
  ToolRegistry, coreTools, defaultConfig, defaultPolicy, resolveModel,
} from "@open-instinct/core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const MESSAGES = ["hi!", "what's 17 times 23?", "thanks", "what time is it right now?"];

async function play(stableCache) {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  const state = new StateDir(dir); state.ensure();
  writeFileSync(join(dir, "PERSONA.md"), DEFAULT_PERSONA);
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  config.features = { ...config.features, stableCache };
  const memory = new MemoryStore(state);
  memory.writeDurable?.("Torstein lives in Oslo. Follows XRP and Norwegian startups. Loves Tine iskaffe.");
  const scheduler = new Scheduler(state), approvals = new ApprovalStore(state), audit = new AuditLog(state), contacts = new ContactStore(state);
  const outbox = { send: async () => {} };
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox }));
  const runtime = new AgentRuntime({
    state, config, policy: new PolicyEngine(defaultPolicy()), approvals, audit, scheduler, contacts, memory, registry,
    model: resolveModel("anthropic/claude-sonnet-5-5"), outbox, streamFn: streamSimple, getApiKey: () => apiKey, replyBudgetMs: 120_000,
  });
  const rows = [];
  for (const [i, text] of MESSAGES.entries()) {
    const res = await runtime.handleInbound({ id: `m${stableCache}${i}`, channel: "chat", from: "owner", conversationKey: "chat:main", text, replyRef: {}, receivedAt: new Date().toISOString() });
    const conv = runtime.conversation("chat:main", runtime.ownerPrincipal());
    const calls = conv.agent.state.messages.filter((m) => m.role === "assistant" && m.usage);
    rows.push({ text, reply: String(res.reply ?? "").replace(/\n/g, " / ").slice(0, 90), usage: calls.slice(rows.reduce((n, r) => n + r.calls, 0)).map((m) => m.usage), get calls() { return this.usage.length; } });
    await new Promise((r) => setTimeout(r, 3000));
  }
  rmSync(dir, { recursive: true, force: true });
  return rows;
}

let total = 0;
for (const stable of [true, false]) {
  const rows = await play(stable);
  console.log(`\n===== stableCache ${stable ? "ON (new)" : "OFF (old)"}`);
  let sum = 0;
  for (const r of rows) {
    for (const u of r.usage) {
      sum += u.cost?.total ?? 0;
      console.log(`  ${r.text.padEnd(28)} read ${String(u.cacheRead).padStart(6)}  written ${String(u.cacheWrite).padStart(6)}  uncached ${String(u.input).padStart(5)}  out ${String(u.output).padStart(4)}  $${(u.cost?.total ?? 0).toFixed(4)}`);
    }
    console.log(`      reply: "${r.reply}"`);
  }
  console.log(`  total $${sum.toFixed(4)}`);
  total += sum;
}
console.log(`\nNow in Oslo: ${new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" })}. Cost: $${total.toFixed(4)}`);
