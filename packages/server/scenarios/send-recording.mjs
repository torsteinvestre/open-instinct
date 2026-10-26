// [sunshine:recordings] Hand a transcript made by the transcription service (~/sunshine-audio service/cli.py output) to
// a live agent as an intake.item, the way Sunshine's backend or the agent's own recording_add does: through Maritime's
// /chat, which the agent acknowledges at once and then keeps, summarizes and acts on in the background. Costs the
// agent's summary call and its turn on the summary (about 10 c); needs the owner's OK each time.
//
// Usage (MARITIME_API_KEY set): TRANSCRIPT=<service json> AGENT=<agent id> ID=<item id> STARTED_AT=<ISO> [TITLE=...] \
//   node scenarios/send-recording.mjs
import { readFileSync } from "node:fs";
import { encodeEvent } from "@open-instinct/core";

const need = (n) => process.env[n]?.trim() || (() => { throw new Error(`${n} must be set`); })();
const r = JSON.parse(readFileSync(need("TRANSCRIPT"), "utf8"));
if (r.status !== "ok" || !r.text?.trim()) throw new Error(`transcript status ${r.status}`);
const startedAt = new Date(need("STARTED_AT"));
const item = {
  type: "intake.item",
  id: need("ID"),
  source: "recording",
  ...(process.env.TITLE?.trim() ? { title: process.env.TITLE.trim() } : {}),
  startedAt: startedAt.toISOString(),
  endedAt: new Date(startedAt.getTime() + r.seconds * 1000).toISOString(),
  ...(r.people?.length ? { people: r.people } : {}),
  text: r.text,
};
const res = await fetch(`https://api.maritime.sh/api/agents/${encodeURIComponent(need("AGENT"))}/chat`, {
  method: "POST",
  headers: { Authorization: `Bearer ${need("MARITIME_API_KEY")}`, "Content-Type": "application/json" },
  body: JSON.stringify({ message: encodeEvent(item), conversation_id: `intake:${item.id}` }),
  signal: AbortSignal.timeout(120_000),
});
console.log(`sent ${item.id}: ${item.text.split("\n").length} lines, ${item.startedAt} to ${item.endedAt}; Maritime HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
