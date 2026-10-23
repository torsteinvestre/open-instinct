// [sunshine:app-permissions] Free end-to-end check: another person's agent reaches the owner's apps in router
// mode through the real permission check. Boots the real server on a temporary data folder with the real
// Composio router for USER_ID (the owner's own connected Google account), makes "Sam" a friend, and lets a
// stand-in model (no model costs) play Sam's request: look up the free/busy action's inputs, run it, then
// try the inbox and the search. Free/busy must run (a real read of the owner's free/busy); the inbox must be
// refused before anything reaches Composio; the search must not even be offered. Prints outcomes only:
// counts, not calendar details. Usage (from packages/server, after `pnpm build`; COMPOSIO_API_KEY set):
//   USER_ID=<composio user id> node scenarios/app-permissions.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { boot } from "../dist/boot.js";

const composioKey = process.env.COMPOSIO_API_KEY?.trim();
if (!composioKey || !process.env.USER_ID) throw new Error("COMPOSIO_API_KEY and USER_ID must be set");
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";
const SAM = "+4790000001";

const dir = mkdtempSync(join(tmpdir(), "app-permissions-"));
mkdirSync(join(dir, "memory"), { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(dir, "contacts.json"), JSON.stringify([{ id: "sam", name: "Sam", tier: "friend", phones: [SAM], emails: [], createdAt: now, updatedAt: now }]));
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_MODEL: "faux/faux-1", INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: process.env.USER_ID, INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
};
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (/composio/.test(url)) return realFetch(input, init);
  throw new Error(`offline: ${url}`);
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
const streamFn = (m, context, opts) => models.streamSimple(m, context, opts);
const sent = [];
const logs = [];
const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {} }, logger: (m) => logs.push(m) });
console.log(logs.filter((l) => /^apps:/.test(l)).join("\n"));

const day = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("app_composio_get_tool_schemas", { tool_slugs: ["GOOGLECALENDAR_FIND_FREE_SLOTS"] })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GOOGLECALENDAR_FIND_FREE_SLOTS", arguments: { time_min: `${day}T12:00:00+02:00`, time_max: `${day}T17:00:00+02:00`, timezone: "Europe/Oslo" } }], sync_response_to_workbench: false, thought: "check when Torstein is free" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }], sync_response_to_workbench: false })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("app_composio_search_tools", { queries: [{ use_case: "list calendar events" }], session: { generate_id: true } })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Torstein has some free time tomorrow afternoon."),
]);
const key = "imessage:sam";
await app.runtime.handleInbound({ id: "evt_sam_1", channel: "imessage", from: SAM, conversationKey: key, text: "Is Torstein free tomorrow afternoon?", replyRef: {}, receivedAt: now }, { waitForCompletion: true });

const conv = app.runtime.conversation(key, { kind: "contact", id: "contact:sam", contactId: "sam", tier: "friend", displayName: "Sam" });
const appToolsSeen = conv.agent.state.tools.map((t) => t.name).filter((n) => n.startsWith("app"));
console.log(`\nSam (friend) is offered: ${appToolsSeen.join(", ") || "no app tools"}`);
const section = conv.agent.state.systemPrompt.split("\n## ").find((s) => s.startsWith("Torstein's apps"));
console.log(`Sam's prompt has the apps section: ${section ? `yes\n  ${section.replace(/\n/g, "\n  ")}` : "NO"}`);
const ownerConv = app.runtime.conversation("imessage:owner_check", app.runtime.ownerPrincipal());
console.log(`owner's prompt has the section for others: ${ownerConv.agent.state.systemPrompt.includes("Torstein's apps") ? "YES (wrong)" : "no (right)"}`);

console.log("\nSam's conversation, step by step:");
for (const m of conv.agent.state.messages) {
  if (m.role === "assistant") for (const c of m.content.filter((x) => x.type === "toolCall")) {
    const slugs = [...new Set(JSON.stringify(c.arguments ?? {}).match(/\b(GMAIL|GOOGLECALENDAR|COMPOSIO)_[A-Z_]+\b/g) ?? [])];
    console.log(`  call ${c.name}${slugs.length ? ` (${slugs.join(", ")})` : ""}`);
  }
  if (m.role === "toolResult") {
    const text = (m.content ?? []).map((c) => c.text ?? "").join(" ");
    let summary = `${text.length} chars`;
    try {
      const j = JSON.parse(text);
      const d = j.data ?? j;
      if (m.toolName === "app_composio_multi_execute_tool") {
        const r = d.results?.[0];
        const resp = r?.response ?? r;
        const slots = JSON.stringify(resp ?? {}).match(/"start"/g)?.length ?? 0;
        summary = `Composio successful: ${j.successful ?? r?.successful ?? "?"}, about ${slots} time ranges in the answer${r?.error ? `, error: ${String(r.error).slice(0, 120)}` : ""}`;
      } else if (m.toolName === "app_composio_get_tool_schemas") {
        summary = `schemas for: ${Object.keys(d.tool_schemas ?? {}).join(", ") || "none"}`;
      }
    } catch {
      summary = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>").slice(0, 200);
    }
    console.log(`    -> ${m.toolName}: ${m.isError ? "BLOCKED/ERROR: " : ""}${summary}`);
  }
}
const decisions = app.runtime.deps.audit.read({ kinds: ["policy"] }).filter((e) => String(e.detail.tool ?? "").startsWith("app_"));
console.log(`\npermission check: ${decisions.map((e) => `${e.detail.tool} ${e.detail.outcome}`).join("; ")}`);
console.log(`texts sent: ${sent.map((m) => `to ${m.to === OWNER || m.conversationKey === key ? (m.to === OWNER ? "owner" : "Sam") : m.conversationKey ?? m.to}: "${m.text.slice(0, 90)}"`).join(" | ")}`);
await app.close?.();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
