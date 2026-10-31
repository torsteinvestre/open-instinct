// [sunshine:flowing-in] The Composio route: app events checked, matched to a person by handle and forwarded.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeEvent } from "@open-instinct/core";
import { composioDeliveryOf, verifyComposioSignature } from "../src/composio.js";
import { silentLogger } from "../src/logger.js";
import { createGateway } from "../src/server.js";
import { UserStore } from "../src/store.js";
import { fakeMaritime, readyUser, tempDir } from "./helpers.js";

const SECRET = "cmp_whsec_test";

function composioHeaders(raw: string, secret = SECRET, opts: { id?: string; timestamp?: number } = {}): Record<string, string> {
  const id = opts.id ?? "msg_2m4kQ9";
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${sig}`, "content-type": "application/json" };
}

/** A V3 trigger event as Composio sends it: the event's own id on top, the trigger's in metadata. */
function gmailEvent(id = "evt_01JB7Q", userId = "maria"): Record<string, unknown> {
  return {
    id,
    timestamp: "2026-10-31T09:15:02.118Z",
    type: "composio.trigger.message",
    metadata: { log_id: "log_x1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti_gmail_1", connected_account_id: "ca_1", auth_config_id: "ac_1", user_id: userId },
    data: { message_id: "19a3f0c2", sender: "Anna <anna@example.com>", subject: "Thursday", message_text: "See you at 14:00.", label_ids: ["INBOX", "UNREAD"] },
  };
}

describe("verifyComposioSignature", () => {
  const raw = JSON.stringify(gmailEvent());
  it("passes Composio's signature and nothing else", () => {
    expect(verifyComposioSignature(raw, composioHeaders(raw), SECRET)).toBe(true);
    expect(verifyComposioSignature(raw, composioHeaders(raw, "other"), SECRET)).toBe(false);
    expect(verifyComposioSignature(`${raw} `, composioHeaders(raw), SECRET)).toBe(false);
    expect(verifyComposioSignature(raw, composioHeaders(raw), "")).toBe(false);
    const { "webhook-id": _id, ...noId } = composioHeaders(raw);
    expect(verifyComposioSignature(raw, noId, SECRET)).toBe(false);
  });

  it("refuses an old delivery, takes any listed v1 signature (a secret being rotated)", () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(verifyComposioSignature(raw, composioHeaders(raw, SECRET, { timestamp: old }), SECRET)).toBe(false);
    expect(verifyComposioSignature(raw, composioHeaders(raw, SECRET, { timestamp: old }), SECRET, { toleranceSeconds: 600 })).toBe(true);
    const good = composioHeaders(raw);
    const both = { ...good, "webhook-signature": `v1,AAAA ${good["webhook-signature"]}` };
    expect(verifyComposioSignature(raw, both, SECRET)).toBe(true);
    expect(verifyComposioSignature(raw, { ...good, "webhook-signature": good["webhook-signature"]!.replace("v1,", "v2,") }, SECRET)).toBe(false);
  });
});

describe("composioDeliveryOf", () => {
  it("makes a trigger event an app.event with the event's own id, not the trigger's", () => {
    expect(composioDeliveryOf(gmailEvent())).toEqual({
      kind: "trigger",
      userId: "maria",
      event: { type: "app.event", id: "evt_01JB7Q", trigger: "GMAIL_NEW_GMAIL_MESSAGE", at: "2026-10-31T09:15:02.118Z", data: gmailEvent().data },
    });
  });

  it("gives an id the agent would refuse a stable stand-in", () => {
    const a = composioDeliveryOf(gmailEvent("evt with spaces/1"));
    const b = composioDeliveryOf(gmailEvent("evt with spaces/1"));
    expect(a?.kind === "trigger" && a.event.id).toMatch(/^composio-[0-9a-f]{32}$/);
    expect(a).toEqual(b);
  });

  it("reads the flow's own notices; refuses what is not a V3 event", () => {
    expect(composioDeliveryOf({ id: "e1", timestamp: "2026-10-31T09:00:00Z", type: "composio.connected_account.expired", metadata: {}, data: { user_id: "maria", toolkit: "gmail" } }))
      .toEqual({ kind: "notice", type: "composio.connected_account.expired", userId: "maria" });
    // V2 puts the trigger slug in `type`; V1 has none.
    expect(composioDeliveryOf({ type: "gmail_new_gmail_message", data: { user_id: "maria" } })).toBeUndefined();
    expect(composioDeliveryOf({ trigger_name: "GMAIL_NEW_GMAIL_MESSAGE", payload: {} })).toBeUndefined();
    const { user_id: _u, ...noUser } = gmailEvent().metadata as Record<string, unknown>;
    expect(composioDeliveryOf({ ...gmailEvent(), metadata: noUser })).toBeUndefined();
    expect(composioDeliveryOf({ ...gmailEvent(), data: undefined })).toBeUndefined();
  });
});

const servers: Array<ReturnType<typeof createGateway>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function boot(opts: { secret?: string; fetchImpl?: typeof fetch } = {}) {
  const store = new UserStore(tempDir());
  const user = store.save(readyUser());
  const mar = fakeMaritime();
  const server = createGateway({
    store, publicUrl: "https://gw.example.com", logger: silentLogger, fetchImpl: opts.fetchImpl ?? mar.fetch,
    maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1" },
    composioWebhookSecret: "secret" in opts ? opts.secret : SECRET,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, user, mar };
}

const post = (base: string, raw: string, headers: Record<string, string>) => fetch(`${base}/webhooks/composio`, { method: "POST", body: raw, headers });

describe("POST /webhooks/composio", () => {
  it("forwards a person's app event to their agent once, as an app.event", async () => {
    const { base, mar, user } = await boot();
    const raw = JSON.stringify(gmailEvent());
    expect((await post(base, raw, composioHeaders(raw))).status).toBe(204);
    await vi.waitFor(() => expect(mar.calls).toHaveLength(1));
    expect(mar.calls[0]?.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    const body = mar.calls[0]?.body as { message: string; conversation_id: string };
    expect(body.conversation_id).toBe(`flow-in:${user.id}`);
    expect(decodeEvent(body.message)).toEqual({ type: "app.event", id: "evt_01JB7Q", trigger: "GMAIL_NEW_GMAIL_MESSAGE", at: "2026-10-31T09:15:02.118Z", data: gmailEvent().data });

    // Composio sends it again (no 2xx seen in time): answered, not forwarded twice.
    expect((await post(base, raw, composioHeaders(raw))).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mar.calls).toHaveLength(1);
  });

  it("keeps the event while the agent cannot take it", async () => {
    let calls = 0;
    const { base, store } = await boot({ fetchImpl: async () => { calls++; return new Response("{}", { status: 503 }); } });
    const raw = JSON.stringify(gmailEvent("evt_kept"));
    expect((await post(base, raw, composioHeaders(raw))).status).toBe(204);
    const receipt = () => JSON.parse(readFileSync(join(store.dir, "webhook-inbox.json"), "utf8")).receipts[0];
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 4000 });
    await vi.waitFor(() => expect(receipt().status).toBe("queued"));
    expect(receipt().payload.event).toMatchObject({ type: "app.event", id: "evt_kept" });
  });

  it("refuses a bad signature and an unreadable body; answers what can reach nobody without forwarding", async () => {
    const { base, mar } = await boot();
    const raw = JSON.stringify(gmailEvent());
    expect((await post(base, raw, composioHeaders(raw, "wrong"))).status).toBe(401);
    expect((await fetch(`${base}/webhooks/composio`)).status).toBe(405);
    const v2 = JSON.stringify({ type: "gmail_new_gmail_message", data: { user_id: "maria" } });
    expect((await post(base, v2, composioHeaders(v2))).status).toBe(400);
    const stranger = JSON.stringify(gmailEvent("evt_2", "someone-else"));
    expect((await post(base, stranger, composioHeaders(stranger))).status).toBe(204);
    const notice = JSON.stringify({ id: "evt_3", timestamp: "2026-10-31T09:00:00Z", type: "composio.trigger.disabled", metadata: { user_id: "maria" }, data: {} });
    expect((await post(base, notice, composioHeaders(notice))).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mar.calls).toHaveLength(0);
  });

  it("is off without the secret, and health says which", async () => {
    const off = await boot({ secret: undefined });
    const raw = JSON.stringify(gmailEvent());
    expect((await post(off.base, raw, composioHeaders(raw))).status).toBe(404);
    expect(await (await fetch(`${off.base}/health`)).json()).toMatchObject({ appEvents: false });
    const on = await boot();
    expect(await (await fetch(`${on.base}/health`)).json()).toMatchObject({ appEvents: true });
  });
});
