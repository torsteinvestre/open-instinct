// [sunshine:prune] After old tool results are shortened, does Sunshine still answer follow-ups right?
// Runs the real AgentRuntime (real system prompt, core tools, the owner's chat thread) against Sonnet 5.5
// with a canned email search (8 emails, about 12,000 characters, like a real Gmail result). The owner
// asks for emails, says thanks, then after a 10-minute pause (the clock is moved; the cache lapses) asks
// about details of that list, which by then has been shortened. Prints per message: tools used, the
// reply, whether results were shortened, and each call's cache use and cost; then whether the follow-ups
// were right (from its own earlier reply or by searching again) and not made up. Once with pruning on,
// once off for comparison. Nothing is sent anywhere. Usage (from packages/server, after `pnpm build`,
// ANTHROPIC_API_KEY set): node scenarios/prune.mjs [on|off|both]
import {
  AgentRuntime, ApprovalStore, AuditLog, ContactStore, DEFAULT_PERSONA, MemoryStore, PolicyEngine, Scheduler, StateDir,
  ToolRegistry, coreTools, defaultConfig, defaultPolicy, defineTool, resolveModel, textResult,
} from "@open-instinct/core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const which = process.argv[2] ?? "both";

const EMAILS = [
  ["msg_18f2a01", "DNB <noreply@dnb.no>", "Your card statement for September is ready", "Mon 12 Oct 08:14"],
  ["msg_18f2a7c", "Skatteetaten <ikke-svar@skatteetaten.no>", "Skattemelding 2025: endelig skatteoppgjør", "Mon 12 Oct 11:02"],
  ["msg_18f2b33", "Ingrid Haugen <ingrid.haugen@gmail.com>", "Hytta i november?", "Tue 13 Oct 19:47"],
  ["msg_18f2c90", "Ticketmaster <noreply@ticketmaster.no>", "Your J. Cole tickets: venue update", "Wed 14 Oct 09:30"],
  ["msg_18f2d15", "Norwegian <noreply@norwegian.no>", "Booking confirmation OSL-BCN, 6 Nov", "Wed 14 Oct 14:05"],
  ["msg_18f2e02", "Startup Norway <hello@startupnorway.com>", "Pitch night 22 Oct: final speaker list", "Thu 15 Oct 07:55"],
  ["msg_18f2e4b", "Nordnet <kundeservice@nordnet.no>", "Endringer i vilkår for Aksjesparekonto", "Thu 15 Oct 10:20"],
  ["msg_18f2f11", "Martin Lie <martin@lie-consulting.no>", "Re: Fundraising deck feedback", "Thu 15 Oct 13:41"],
];
const filler = (i) => `Hei Torstein, ${"dette er en lengre e-post med detaljer, lenker og vilkår som en ekte innboks har. ".repeat(17)}(#${i})`;
const INBOX = EMAILS.map(([id, from, subject, date], i) => `{"id":"${id}","from":"${from}","subject":"${subject}","date":"${date}","snippet":"${filler(i)}","labels":["INBOX","UNREAD"]}`).join(",\n");
const SEARCH_RESULT = `{"data":{"messages":[\n${INBOX}\n],"resultSizeEstimate":8},"successful":true}`;

const STEPS = [
  { text: "what emails did I get this week?", pauseMin: 0 },
  { text: "thanks!", pauseMin: 1 },
  { text: "what was the exact subject of the one from Nordnet?", pauseMin: 10, expect: "Endringer i vilkår for Aksjesparekonto" },
  { text: "and what's the message id of the Norwegian booking one? need it for something", pauseMin: 1, expect: "msg_18f2d15" },
];

async function play(prune) {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  const state = new StateDir(dir); state.ensure();
  writeFileSync(join(dir, "PERSONA.md"), DEFAULT_PERSONA);
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  config.features = { ...config.features, pruneToolResults: prune };
  const memory = new MemoryStore(state);
  const scheduler = new Scheduler(state), approvals = new ApprovalStore(state), audit = new AuditLog(state), contacts = new ContactStore(state);
  const outbox = { send: async () => {} };
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox }));
  let searches = 0;
  registry.registerMany([defineTool({
    name: "gmail_fetch_emails",
    label: "Fetch emails",
    description: "Fetch emails from the owner's Gmail inbox. Returns id, sender, subject, date and a snippet for each.",
    parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Gmail search query, e.g. newer_than:7d" })) }),
    meta: { capabilities: ["converse"], group: "apps" },
    execute: async () => { searches++; return textResult(SEARCH_RESULT); },
  })]);
  let offset = 0;
  const runtime = new AgentRuntime({
    state, config, policy: new PolicyEngine(defaultPolicy()), approvals, audit, scheduler, contacts, memory, registry,
    model: resolveModel("anthropic/claude-sonnet-5-5"), outbox, streamFn: streamSimple, getApiKey: () => apiKey, replyBudgetMs: 180_000,
    now: () => new Date(Date.now() + offset),
  });
  const rows = [];
  let seenCalls = 0;
  for (const [i, step] of STEPS.entries()) {
    offset += step.pauseMin * 60_000;
    const searchesBefore = searches;
    const auditBefore = audit.read({ limit: 1000 }).length;
    const res = await runtime.handleInbound({ id: `m${prune}${i}`, channel: "chat", from: "owner", conversationKey: "chat:main", text: step.text, replyRef: {}, receivedAt: new Date().toISOString() });
    const conv = runtime.conversation("chat:main", runtime.ownerPrincipal());
    const calls = conv.agent.state.messages.filter((m) => m.role === "assistant" && m.usage && m.usage.totalTokens > 0);
    const pruned = audit.read({ limit: 1000 }).slice(auditBefore).find((e) => e.detail?.prunedToolResults);
    const reply = String(res.reply ?? "");
    rows.push({
      step, reply, searchedAgain: searches > searchesBefore, usage: calls.slice(seenCalls).map((m) => m.usage),
      pruned: pruned ? `${pruned.detail.prunedToolResults} result(s), ${pruned.detail.prunedChars} chars` : "",
      right: step.expect ? reply.includes(step.expect) : undefined,
    });
    seenCalls = calls.length;
  }
  rmSync(dir, { recursive: true, force: true });
  return rows;
}

let total = 0;
for (const prune of which === "both" ? [true, false] : [which === "on"]) {
  const rows = await play(prune);
  console.log(`\n===== pruning ${prune ? "ON (new)" : "OFF (old)"}`);
  let sum = 0;
  for (const r of rows) {
    console.log(`\n  > ${r.step.text}${r.step.pauseMin >= 5 ? `   (after ${r.step.pauseMin} min)` : ""}`);
    if (r.pruned) console.log(`    shortened before the call: ${r.pruned}`);
    for (const u of r.usage) {
      sum += u.cost?.total ?? 0;
      console.log(`    read ${String(u.cacheRead).padStart(6)}  written ${String(u.cacheWrite).padStart(6)}  uncached ${String(u.input).padStart(5)}  out ${String(u.output).padStart(4)}  $${(u.cost?.total ?? 0).toFixed(4)}`);
    }
    console.log(`    reply: "${r.reply.replace(/\n/g, " / ").slice(0, 260)}"`);
    if (r.right !== undefined) console.log(`    right answer: ${r.right ? "YES" : "NO"}   searched again: ${r.searchedAgain ? "yes" : "no"}`);
  }
  console.log(`  total $${sum.toFixed(4)}`);
  total += sum;
}
console.log(`\nCost: $${total.toFixed(4)}`);
