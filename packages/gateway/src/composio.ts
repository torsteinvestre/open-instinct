/**
 * [sunshine:flowing-in] What happens in a person's apps (an email arrives or is sent, a calendar event changes)
 * reaches their agent as an `app.event`. Composio sends every person's trigger events to one URL for the whole
 * project, signed the Standard Webhooks way with the project's secret; the event names the person by the user id
 * their agent gave Composio, its handle. The agent's flow decides what is kept (server flowing-in.ts); this side only
 * checks, finds whose it is and forwards.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { APP_EVENT, type AppEvent, appEventOf } from "@open-instinct/core";
import type { HeaderMap } from "./relay.js";

/** The event type that carries a trigger's data. Composio's others say the flow stopped or started again. */
export const COMPOSIO_TRIGGER_MESSAGE = "composio.trigger.message";

export interface ComposioVerifyOptions {
  /** Max age of `webhook-timestamp` in seconds. Default 300, as in Composio's SDK. */
  toleranceSeconds?: number;
  now?: () => number;
}

function header(headers: HeaderMap, name: string): string {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` keyed with the secret as it is (Composio does not decode
 * it), sent as `v1,<base64>`; several may come space-separated while a secret is being rotated.
 */
export function verifyComposioSignature(rawBody: Buffer | string, headers: HeaderMap, secret: string, opts: ComposioVerifyOptions = {}): boolean {
  if (!secret) return false;
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature")
    .split(" ")
    .map((s) => s.split(","))
    .filter(([version, sig]) => version === "v1" && Boolean(sig))
    .map(([, sig]) => Buffer.from(sig ?? "", "base64"));
  if (!id || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs((opts.now ?? Date.now)() - Number(timestamp) * 1000) > tolerance * 1000) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.some((received) => received.length === expected.length && timingSafeEqual(received, expected));
}

export type ComposioDelivery =
  | { kind: "trigger"; userId: string; event: AppEvent }
  /** A connection expired or came back, a trigger was disabled: not memory, but the flow stopping or starting. */
  | { kind: "notice"; type: string; userId?: string };

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Composio's V3 body: `{ id, timestamp, type, metadata: { trigger_slug, user_id, ... }, data }`. The event's own id
 * is the top-level `id`; `metadata.trigger_id` names the trigger and is the same for every email it reports.
 */
export function composioDeliveryOf(body: unknown): ComposioDelivery | undefined {
  const b = obj(body);
  const type = str(b?.["type"]);
  if (!b || !type) return undefined;
  const metadata = obj(b["metadata"]);
  const data = obj(b["data"]);
  // A V1 or V2 body (the subscription's version is chosen when it is made) has no `composio.` type: unreadable here.
  if (!type.startsWith("composio.")) return undefined;
  if (type !== COMPOSIO_TRIGGER_MESSAGE) {
    const userId = str(metadata?.["user_id"]) ?? str(data?.["user_id"]);
    return { kind: "notice", type, ...(userId ? { userId } : {}) };
  }
  const id = str(b["id"]);
  const userId = str(metadata?.["user_id"]);
  const event = appEventOf({ type: APP_EVENT, id: id && eventId(id), trigger: metadata?.["trigger_slug"], at: b["timestamp"], data });
  if (!event || !userId) return undefined;
  return { kind: "trigger", userId, event };
}

/** The agent takes ids of letters, digits and `_.:-`; any other id is replaced by a stable stand-in. */
function eventId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) ? id : `composio-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
