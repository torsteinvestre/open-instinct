// [sunshine:delivery-mirror] Does Sunshine know what it texted the owner from elsewhere? Runs the
// real AgentRuntime against Sonnet 5.5 in the owner's iMessage thread, with the outbox wired as boot
// wires the Inkbox channel (every successful send goes to runtime.mirrorToOwner). A reminder fires
// from its scheduled job, then the owner thanks Sunshine; a news text goes out, then the owner asks
// about it. Once with the mirror on, once off. Nothing is sent anywhere.
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY set):  node scenarios/mirror.mjs
import {
  AgentRuntime, ApprovalStore, AuditLog, ContactStore, MemoryStore, PolicyEngine, Scheduler, StateDir,
  ToolRegistry, coreTools, defaultConfig, defaultPolicy, resolveModel,
} from "@open-instinct/core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const PHONE = "+4790000000";
const THREAD = "imessage:conv_owner";
const NEWS = "Norwegian startup Sanna raised 30 million kroner for its AI accounting software (Shifter).";

async function play(mirror) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  const state = new StateDir(dir); state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", phones: [PHONE], timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  config.features = { ...config.features, deliveryMirror: mirror };
  const memory = new MemoryStore(state), scheduler = new Scheduler(state), approvals = new ApprovalStore(state), audit = new AuditLog(state);
  let runtime;
  const phone = []; // what reached the owner's phone
  const outbox = { send: async (msg, ctx) => { phone.push(msg.text); runtime?.mirrorToOwner(msg, ctx); } }; // as boot wires the channel
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox }));
  runtime = new AgentRuntime({
    state, config, policy: new PolicyEngine(defaultPolicy()), approvals, audit, scheduler, contacts: new ContactStore(state), memory, registry,
    model: resolveModel("anthropic/claude-sonnet-5-5"), outbox, streamFn: streamSimple, getApiKey: () => apiKey, replyBudgetMs: 120_000,
  });
  let n = 0;
  const say = async (text) => {
    const r = await runtime.handleInbound({ id: `m${++n}`, channel: "imessage", from: PHONE, conversationKey: THREAD, text, replyRef: {}, receivedAt: new Date().toISOString() });
    return String(r.reply ?? phone.at(-1) ?? "").replace(/\n/g, " / ");
  };
  const toolsUsed = () => {
    const msgs = runtime.conversation(THREAD, runtime.ownerPrincipal()).agent.state.messages;
    return msgs.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c) => c.type === "toolCall").map((c) => c.name));
  };
  const out = [];
  out.push(`owner: remind me in 1 minute to stretch -> "${await say("remind me in 1 minute to stretch")}"`);
  const entry = scheduler.list()[0];
  if (entry) {
    // Fire at the reminder's own time, as the scheduler would.
    const wait = Date.parse(entry.nextRunAt ?? "") - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1500));
    await runtime.runScheduled(entry);
  }
  out.push(`(phone got: "${phone.at(-1)}")`);
  const toolsBefore = toolsUsed().length;
  out.push(`owner: preciate the reminder -> "${await say("preciate the reminder")}"`);
  await outbox.send({ channel: "imessage", to: PHONE, text: NEWS }, { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein" }, conversationKey: "scheduled:watcher" });
  out.push(`(news text: "${NEWS}")`);
  const before = toolsUsed().length;
  out.push(`owner: whats sanna? -> "${await say("whats sanna?")}"  [tools used for it: ${toolsUsed().slice(before).join(", ") || "none"}]`);
  const thread = runtime.conversation(THREAD, runtime.ownerPrincipal()).agent.state.messages.filter((m) => m.role !== "system");
  const copies = (t) => thread.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "text" && c.text.includes(t))).length;
  out.push(`in the owner's thread: stretch reminder x${copies("stretch")} (counting Sunshine's own "I'll remind you" too), news text x${copies("Sanna raised")}; tools before the thanks: ${toolsBefore}`);
  const cost = thread.reduce((s, m) => s + (m.usage?.cost?.total ?? 0), 0);
  rmSync(dir, { recursive: true, force: true });
  return { out, cost };
}

let total = 0;
for (const mirror of [true, false]) {
  const { out, cost } = await play(mirror);
  total += cost;
  console.log(`\n===== delivery mirror ${mirror ? "ON (new)" : "OFF (as before)"}`);
  for (const line of out) console.log("  " + line);
}
console.log(`\nCost (owner's thread only): $${total.toFixed(4)}`);
