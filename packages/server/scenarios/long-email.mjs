// [sunshine:apps] Can Sunshine read a long email in full? Composio moves large results (a verbose Gmail
// fetch easily passes them) to its remote workbench and hands back a preview plus a note; reading the rest
// needs the workbench tool. Boots the real server in a throwaway folder with the owner's live settings and
// the REAL Composio router for one connected account (nothing is sent: the outbox is captured, Inkbox is a
// dummy), plays one text through Sonnet 5.5 and checks the reply against the email's real ending.
// Usage (from packages/server, after `pnpm build`; ANTHROPIC_API_KEY and COMPOSIO_API_KEY set):
//   TRUTH=<file.json {from, subject, text}> USER_ID=<composio user id> node scenarios/long-email.mjs [after|before]
//   after (default): the workbench tools are offered; before: they are left out, as before the fix.
//   TEXT=... replaces the request. DRY=1 lists the apps tools and stops: free. About 6-12 cents per run.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComposioApps } from "@open-instinct/apps";
import { boot } from "../dist/boot.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const composioKey = process.env.COMPOSIO_API_KEY?.trim();
if (!apiKey || !composioKey) throw new Error("ANTHROPIC_API_KEY and COMPOSIO_API_KEY must be set");
if (!process.env.TRUTH || !process.env.USER_ID) throw new Error("TRUTH and USER_ID must be set");
const truth = JSON.parse(readFileSync(process.env.TRUTH, "utf8"));
const VARIANT = process.argv[2] ?? "after";
if (VARIANT === "before") {
  const WORKBENCH = new Set(["app_composio_remote_workbench", "app_composio_remote_bash_tool"]);
  const tools = ComposioApps.prototype.tools;
  ComposioApps.prototype.tools = async function (opts) { return (await tools.call(this, opts)).filter((t) => !WORKBENCH.has(t.spec.name)); };
}
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";
const TEXT = process.env.TEXT ?? `can you read the newest ${truth.from} email in my inbox ("${truth.subject}") and tell me exactly how it ends? quote the last two or three sentences word for word`;

const dir = mkdtempSync(join(tmpdir(), "long-email-"));
mkdirSync(join(dir, "memory"), { recursive: true });
writeFileSync(join(dir, "memory", "MEMORY.md"), "## About\n- Torstein lives in Oslo.\n\n## People\n- Sanna: girlfriend.\n");
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_WATCHER: "1", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1",
  INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  // The Composio user is the agent's handle: this one is the connected account being read.
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: process.env.USER_ID, INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  BRAVE_SEARCH_API_KEY: "dummy", COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
};
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
  if (/composio/.test(url)) return realFetch(input, init);
  throw new Error(`offline: ${url}`);
};
const sent = [];
const app = await boot(env, { fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {} }, logger: () => {} });
const appTools = app.runtime.deps.registry.all().filter((t) => t.spec.meta.group === "apps").map((t) => t.spec.name);
console.log(`variant ${VARIANT}: apps tools ${appTools.join(", ")}`);
if (process.env.DRY) { await app.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }

const key = "imessage:long_email";
await app.runtime.handleInbound({ id: "evt_long_email", channel: "imessage", from: OWNER, conversationKey: key, text: TEXT, replyRef: {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
const msgs = app.runtime.conversation(key, app.runtime.ownerPrincipal()).agent.state.messages;

// The path taken: tool calls, and whether a result was moved to the workbench.
const OFFLOAD = /remote_file|workbench|file_path|saved to/i;
for (const m of msgs) {
  if (m.role === "assistant") for (const c of m.content.filter((x) => x.type === "toolCall")) {
    const a = JSON.stringify(c.arguments ?? {});
    const slugs = [...new Set(a.match(/\b(GMAIL|GOOGLECALENDAR)_[A-Z_]+\b/g) ?? [])];
    const opts = a.match(/"(sync_response_to_workbench|include_payload|verbose|format|max_results)":\s*("?\w+"?)/g) ?? [];
    console.log(`  call ${c.name}${slugs.length ? ` ${slugs.join(",")}` : ""}${opts.length ? ` ${opts.join(" ")}` : ""}`);
  }
  if (m.role === "toolResult") {
    const t = JSON.stringify(m.content ?? "");
    console.log(`    result ${m.toolName ?? ""}: ${t.length} chars${OFFLOAD.test(t) ? " | mentions the workbench / a remote file" : ""}${m.isError ? " | ERROR" : ""}`);
  }
}

// Graded against the real email: six-word runs from its last 1,500 characters that do not occur in its
// first 2,000 (which a preview could show). A hit means the reply quotes text only the full email has.
const norm = (s) => String(s).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const head = norm(truth.text.slice(0, 2000));
const tailWords = norm(truth.text.slice(-1500)).split(" ");
const windows = [];
for (let i = 0; i + 6 <= tailWords.length; i++) { const w = tailWords.slice(i, i + 6).join(" "); if (!head.includes(w)) windows.push(w); }
const reply = sent.map((m) => m.text).filter(Boolean).join(" / ") || "(nothing sent)";
const nr = norm(reply);
const hits = windows.filter((w) => nr.includes(w)).length;
const usage = msgs.filter((m) => m.role === "assistant" && m.usage).map((m) => m.usage);
const cost = usage.reduce((s, u) => s + (u.cost?.total ?? 0), 0);
const CANT = /\b(can't|cannot|can not|unable to|not able to|only (gives|shows|hands) me|only the first)\b/i;
console.log(`\nTorstein: ${TEXT}`);
console.log(`Sunshine: ${reply.replace(/\n/g, " / ")}`);
console.log(`\nquotes the real ending: ${hits > 0 ? "YES" : "NO"} (${hits} of ${windows.length} six-word runs)${CANT.test(reply) ? " | says it can't" : ""}`);
console.log(`model calls ${usage.length}, cost $${cost.toFixed(4)}`);
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
