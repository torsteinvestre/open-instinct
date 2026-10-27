// [sunshine:recordings] Free: the recording path with the real pieces and no model calls. Boots the real server for
// "Maya" (a stand-in model; INTAKE_MODEL=off, so items are kept without the paid summary) with TRANSCRIBE_URL pointing
// at a running transcription service (~/sunshine-audio service/http_host.py), learns her voice from a short sample
// (voice_mine), hands it a meeting file the way an iMessage attachment lands (recording_add), waits for the item, and
// checks: kept as a recording with her lines named, the people listed, both audio files deleted, the search finds it.
//
// Usage (from packages/server, after `pnpm build`; the service running):
//   TRANSCRIBE_URL=http://127.0.0.1:8765 TRANSCRIBE_KEY=... MEETING=<file.m4a> SAMPLE=<owner sample> node scenarios/recording.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { AuditLog, ItemArchive } from "@open-instinct/core";
import { boot } from "../dist/boot.js";

const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const dir = mkdtempSync(join(tmpdir(), "recording-"));
const env = {
  INSTINCT_DATA_DIR: dir,
  INSTINCT_OWNER_NAME: "Maya",
  INSTINCT_OWNER_PHONE: "+4790000000",
  INSTINCT_OWNER_TIMEZONE: "Europe/Oslo",
  INSTINCT_AGENT_NAME: "Sunshine",
  INSTINCT_MODEL: "faux/faux-1",
  INSTINCT_COMPUTER: "none",
  INSTINCT_SKILLS_DIR: join(dir, "no-skills"),
  INTAKE_MODEL: "off",
  TRANSCRIBE_URL: need("TRANSCRIBE_URL"),
  TRANSCRIBE_KEY: need("TRANSCRIBE_KEY"),
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
const logs = [];
const app = await boot(env, { model: faux.getModel("faux-1"), streamFn: models.streamSimple.bind(models), logger: (m) => logs.push(m) });
console.log("boot:", logs.filter((l) => /recordings|intake/.test(l)).join(" | "));
const registry = app.runtime.deps.registry;
const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maya" }, conversationKey: "imessage:test", channel: "imessage", ownerTurn: true, now: () => new Date() };
const text = (r) => (typeof r === "string" ? r : r.content.map((c) => c.text ?? "").join(""));
const inbound = join(dir, "workspace", "inbound");
mkdirSync(inbound, { recursive: true });

// Without SAMPLE the voice step is skipped: then the recording is the first request (the cold-start case).
let t = Date.now();
const sample = process.env.SAMPLE?.trim() ? join(inbound, basename(process.env.SAMPLE.trim())) : undefined;
if (sample) {
  copyFileSync(process.env.SAMPLE.trim(), sample);
  console.log("voice_mine:", text(await registry.get("voice_mine").spec.execute({ path: sample }, ctx)), `(${Date.now() - t} ms)`);
  // It learns in the background: wait for the print (the outcome also goes to the agent as a note).
  for (let i = 0; i < 600 && !app.state.exists("voice/owner.json"); i++) await new Promise((r) => setTimeout(r, 1000));
  console.log(`voice learned after ${((Date.now() - t) / 1000).toFixed(0)} s:`, app.state.exists("voice/owner.json"), "| sample deleted:", !existsSync(sample));
}

const meeting = join(inbound, basename(need("MEETING")));
copyFileSync(need("MEETING"), meeting);
t = Date.now();
console.log("recording_add:", text(await registry.get("recording_add").spec.execute({ path: meeting, title: "remote control design meeting" }, ctx)), `(${Date.now() - t} ms)`);

// WAIT_MINUTES (default 15): a long recording takes about a tenth of its length, plus the service's start.
const items = new ItemArchive(app.state);
const waitMs = Number(process.env.WAIT_MINUTES ?? 15) * 60_000;
const failed = () => new AuditLog(app.state).read({ kinds: ["error"] }).some((e) => e.detail?.recording);
let item;
let awakeSeen = false;
while (!item && Date.now() - t < waitMs && !failed()) {
  await new Promise((r) => setTimeout(r, 2000));
  item = items.all().find((it) => it.source === "recording");
  // The keep-awake schedule is there while the job is out.
  if (!awakeSeen && app.scheduler.list().some((e) => e.gate === "recordings")) {
    awakeSeen = true;
    console.log(`keep-awake schedule there after ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
}
if (!item) {
  console.log(`no recording item after ${((Date.now() - t) / 60_000).toFixed(1)} minutes; audit errors:`, JSON.stringify(new AuditLog(app.state).read({ kinds: ["error"] }).map((e) => e.detail)));
  process.exit(1);
}
console.log("keep-awake schedule gone after:", !app.scheduler.list().some((e) => e.gate === "recordings"));
console.log(`kept after ${((Date.now() - t) / 1000).toFixed(0)} s: ${item.id}, "${item.title}", people ${JSON.stringify(item.people)}, ${item.text.split("\n").length} lines`);
console.log("meeting file deleted:", !existsSync(meeting), "| owner print kept:", app.state.exists("voice/owner.json"));
console.log("calls to the service:", JSON.stringify(new AuditLog(app.state).read({}).filter((e) => e.detail?.recording).map((e) => e.detail.recording)));
const mine = item.text.split("\n").filter((l) => /^\[[\d:]+\] Maya:/.test(l)).length;
console.log(`lines named Maya: ${mine}; first lines:\n${item.text.split("\n").slice(0, 4).join("\n")}`);
const found = text(await registry.get("history_search").spec.execute({ query: "instruction manuals" }, ctx));
console.log("history_search 'instruction manuals':", found.split("\n").slice(0, 3).join(" / "));
await app.close();
