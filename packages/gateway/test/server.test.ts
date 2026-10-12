import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEvent } from "@open-instinct/core";
import { silentLogger } from "../src/logger.js";
import type { RouterInfo } from "../src/pages.js";
import { type GatewayOptions, createGateway } from "../src/server.js";
import { type UserRecord, UserStore } from "../src/store.js";
import { fakeInkbox, fakeMaritime, imessageEvent, readyUser, signHeaders, tempDir } from "./helpers.js";

const servers: Array<ReturnType<typeof createGateway>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface BootOpts {
  signupSecret?: string;
  withInkbox?: boolean;
  routerInfoFor?: GatewayOptions["routerInfoFor"];
  signupLimits?: GatewayOptions["signupLimits"];
  trustProxy?: boolean;
  link?: GatewayOptions["link"];
  notifyExisting?: GatewayOptions["notifyExisting"];
  seed?: UserRecord[];
  now?: () => number;
  brand?: GatewayOptions["brand"];
  handlePrefix?: string;
  desktop?: boolean;
}

async function boot(opts: BootOpts = {}) {
  const store = new UserStore(tempDir());
  for (const u of opts.seed ?? []) store.save(u);
  const ink = fakeInkbox();
  const mar = fakeMaritime();
  const server = createGateway({
    store,
    publicUrl: "https://gw.example.com",
    inkbox: opts.withInkbox === false ? undefined : ink.provisioner,
    maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1", desktop: opts.desktop },
    signupSecret: opts.signupSecret,
    brand: opts.brand,
    handlePrefix: opts.handlePrefix,
    logger: silentLogger,
    fetchImpl: mar.fetch,
    routerInfoFor: opts.routerInfoFor,
    signupLimits: opts.signupLimits,
    trustProxy: opts.trustProxy,
    link: opts.link,
    notifyExisting: opts.notifyExisting,
    now: opts.now,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, ink, mar, base, server };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

function signup(base: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/signup`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("gateway http", () => {
  it("serves health and the landing page", async () => {
    const { base } = await boot();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, users: 0, signup: true });
    const page = await fetch(base);
    expect(page.headers.get("content-type")).toContain("text/html");
    const text = await page.text();
    expect(text).toContain("Open Instinct");
    expect(text).toContain('action="/api/signup"');
    expect(text).not.toContain("inviteCode");
    expect(text).toContain("github.com");
  });

  it("signs up over json, provisions in the background and serves the connect page", async () => {
    const { base, store, ink, mar } = await boot();
    const res = await signup(base, { name: "Maria", phone: "415 555 0123", handle: "Maria" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { userId: string; connectUrl: string };
    expect(body.connectUrl).toBe(`https://gw.example.com/connect/${body.userId}`);
    await waitFor(() => store.get(body.userId)?.status === "ready");
    expect(ink.calls[3]).toBe(`subscribeWebhooks https://gw.example.com/webhooks/inkbox/${body.userId}`);
    expect(mar.calls.some((c) => c.method === "POST")).toBe(true);

    const status = await fetch(`${base}/api/users/${body.userId}`);
    const pub = (await status.json()) as Record<string, unknown>;
    expect(pub["status"]).toBe("ready");
    expect(pub["name"]).toBeUndefined();
    expect(pub["error"]).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("ik_");
    expect(JSON.stringify(pub)).not.toContain("whsec_");

    const connect = await fetch(`${base}/connect/${body.userId}`);
    const page = await connect.text();
    expect(connect.status).toBe(200);
    expect(page).toContain("connect @maria");
    expect(page).toContain("+14155550199");
    // The sms: button is built for this handle, never from the org-wide placeholder link.
    expect(page).toContain('href="sms:+14155550199&amp;body=connect%20%40maria"');
    expect(page).not.toContain("connect%20%40handle");
    // The shared QR encodes the placeholder handle, so it is not shown.
    expect(page).not.toContain("data:image/png;base64,");
    // A ready agent needs no status line and no refresh.
    expect(page).not.toContain("Setting up");
    expect(page).not.toContain('http-equiv="refresh"');
    // Router info is cached, so a second page view does not call Inkbox again.
    await fetch(`${base}/connect/${body.userId}`);
    expect(ink.calls.filter((c) => c === "routerInfo")).toHaveLength(1);
  });

  it("shows a QR only when per-user router info names this handle", async () => {
    const asked: string[] = [];
    const perUser = async (u: UserRecord): Promise<RouterInfo> => {
      asked.push(u.identityApiKey);
      return { number: "+14155550199", connectCommand: `connect @${u.handle}`, smsLink: `sms:+14155550199&body=connect%20%40${u.handle}`, qrPngDataUrl: "data:image/png;base64,QUJD" };
    };
    const { base } = await boot({ routerInfoFor: perUser, seed: [readyUser({ id: "usr_q", handle: "maria" })] });
    const page = await (await fetch(`${base}/connect/usr_q`)).text();
    expect(asked).toEqual(["ik_secret"]);
    expect(page).toContain('src="data:image/png;base64,QUJD"');
    expect(page).toContain("connect%20%40maria");

    const wrong = async (): Promise<RouterInfo> => ({ number: "+14155550199", connectCommand: "connect @bob", smsLink: "sms:+14155550199&body=connect%20%40bob", qrPngDataUrl: "data:image/png;base64,Qk9C" });
    const other = await boot({ routerInfoFor: wrong, seed: [readyUser({ id: "usr_w", handle: "maria" })] });
    const wrongPage = await (await fetch(`${other.base}/connect/usr_w`)).text();
    expect(wrongPage).not.toContain("Qk9C");
    expect(wrongPage).toContain("connect%20%40maria");
  });

  it("handles form posts with a redirect and shows field errors inline", async () => {
    const { base } = await boot({ signupSecret: "secret-code" });
    const landing = await (await fetch(base)).text();
    expect(landing).toContain('name="inviteCode"');

    const bad = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Maria", phone: "123", handle: "maria", inviteCode: "nope" }).toString(),
      redirect: "manual",
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain("Invite code is not valid.");
    expect(text).toContain("country code");
    expect(text).toContain('value="Maria"');

    const good = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Maria", phone: "+14155550123", handle: "maria", inviteCode: "secret-code" }).toString(),
      redirect: "manual",
    });
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toMatch(/^\/connect\/usr_/);
  });

  it("answers a repeat phone with a neutral response and never reveals the existing record", async () => {
    const notified: string[] = [];
    const { base, store } = await boot({ notifyExisting: async (u, url) => void notified.push(`${u.id} ${url}`) });
    store.save(readyUser({ id: "usr_a", name: "Maria Secret", handle: "maria", phone: "+14155550123" }));

    const samePhone = await signup(base, { name: "x", phone: "+14155550123", handle: "zzz-random" });
    expect(samePhone.status).toBe(202);
    const body = (await samePhone.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "pending" });
    expect(JSON.stringify(body)).not.toContain("usr_a");

    const asHtml = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "x", phone: "+14155550123", handle: "zzz-random" }).toString(),
      redirect: "manual",
    });
    expect(asHtml.status).toBe(202);
    const page = await asHtml.text();
    expect(page).toContain("Check your phone");
    expect(page).toContain("connect @zzz-random");
    expect(page).not.toContain("usr_a");
    expect(page).not.toContain("Maria Secret");
    expect(page).not.toContain("@maria<");

    // The existing person can still be reached out of band.
    expect(notified).toEqual(["usr_a https://gw.example.com/connect/usr_a", "usr_a https://gw.example.com/connect/usr_a"]);
    // No second record was created.
    expect(store.all()).toHaveLength(1);
  });

  it("hides handle conflicts behind a generic error unless an invite code gates the form", async () => {
    const open = await boot();
    open.store.save(readyUser({ id: "usr_a", handle: "maria", phone: "+14155550123" }));
    const taken = await signup(open.base, { name: "Other", phone: "+14155550999", handle: "maria" });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toEqual({ error: "could not create" });

    const gated = await boot({ signupSecret: "s" });
    gated.store.save(readyUser({ id: "usr_a", handle: "maria", phone: "+14155550123" }));
    const taken2 = await signup(gated.base, { name: "Other", phone: "+14155550999", handle: "maria", inviteCode: "s" });
    expect(taken2.status).toBe(409);
    expect(await taken2.json()).toMatchObject({ error: "handle taken" });
  });

  it("re-submitting for a record stuck in provisioning restarts provisioning with a neutral reply", async () => {
    const stuck = readyUser({ id: "usr_stuck", handle: "maria", phone: "+14155550123", status: "provisioning", identityId: "", identityApiKey: "", signingKey: "", maritimeAgentId: undefined });
    const { base, store, ink } = await boot({ seed: [stuck] });
    const retry = await signup(base, { name: "Maria", phone: "+14155550123", handle: "maria" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ status: "pending" });
    await waitFor(() => store.get("usr_stuck")?.status === "ready");
    expect(ink.calls[0]).toBe("provisionIdentity");
    expect(store.all()).toHaveLength(1);

    // A ready record is left alone.
    const again = await signup(base, { name: "Maria", phone: "+14155550123", handle: "maria" });
    expect(again.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(ink.calls.filter((c) => c === "provisionIdentity")).toHaveLength(1);
  });

  it("with a brand and picked handles, asks for no handle and knows a repeat by phone alone", async () => {
    const { base, store, ink, mar } = await boot({ brand: { product: "Sunshine", agent: "Sunshine" }, handlePrefix: "sunshine", desktop: false });
    const landing = await (await fetch(base)).text();
    expect(landing).toContain("<title>Sunshine</title>");
    expect(landing).toContain("Create my Sunshine");
    expect(landing).not.toContain('name="handle"');
    expect(landing).toContain("built on <a");

    const res = await signup(base, { name: "Bjørn Ås", country: "NO", phone: "457 75 184" });
    expect(res.status).toBe(202);
    const { userId } = (await res.json()) as { userId: string };
    await waitFor(() => store.get(userId)?.status === "ready");
    const user = store.get(userId)!;
    expect(user.phone).toBe("+4745775184");
    expect(user.handle).toMatch(/^sunshine-bjorn-[a-z0-9]{4}$/);
    expect((mar.calls.find((c) => c.method === "POST")?.body as Record<string, unknown>)["desktop"]).toBe(false);
    const connect = await (await fetch(`${base}/connect/${userId}`)).text();
    expect(connect).toContain(`connect @${user.handle}`);
    expect(connect).toContain("Open Messages");

    // The same phone, written another way: no second agent, and nothing about the first one.
    const again = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Someone", country: "NO", phone: "+47 457 75 184" }).toString(),
      redirect: "manual",
    });
    expect(again.status).toBe(202);
    const page = await again.text();
    expect(page).toContain("Check your phone");
    expect(page).not.toContain(user.handle);
    expect(page).not.toContain("connect @");
    expect(store.all()).toHaveLength(1);
    expect(ink.calls.filter((c) => c === "provisionIdentity")).toHaveLength(1);
  });

  it("with picked handles, signing up again restarts a setup that failed", async () => {
    const failed = readyUser({ id: "usr_failed", handle: "sunshine-maria-abcd", phone: "+14155550123", status: "error", identityId: "", identityApiKey: "", signingKey: "", maritimeAgentId: undefined });
    const { base, store } = await boot({ handlePrefix: "sunshine", seed: [failed] });
    const retry = await signup(base, { name: "Maria", phone: "+14155550123" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ status: "pending" });
    await waitFor(() => store.get("usr_failed")?.status === "ready");
    expect(store.get("usr_failed")?.handle).toBe("sunshine-maria-abcd");
    expect(store.all()).toHaveLength(1);
  });

  it("resumePending restarts every record a crash left in provisioning", async () => {
    const seed = [
      readyUser({ id: "usr_p1", handle: "p-one", phone: "+14155550001", status: "provisioning", identityId: "", identityApiKey: "", signingKey: "", maritimeAgentId: undefined }),
      readyUser({ id: "usr_p2", handle: "p-two", phone: "+14155550002", status: "provisioning", identityId: "idn_p2", identityApiKey: "ik_p2", signingKey: "whsec_p2", maritimeAgentId: undefined }),
      readyUser({ id: "usr_ok", handle: "fine", phone: "+14155550003" }),
      readyUser({ id: "usr_err", handle: "broken", phone: "+14155550004", status: "error" }),
    ];
    const { store, server, ink } = await boot({ seed });
    expect(server.resumePending()).toBe(2);
    await waitFor(() => store.get("usr_p1")?.status === "ready" && store.get("usr_p2")?.status === "ready");
    // p2 already had its identity and keys, so only the webhook and the agent were created for it.
    expect(ink.calls.filter((c) => c === "provisionIdentity")).toHaveLength(1);
    expect(store.get("usr_err")?.status).toBe("error");
    expect(store.get("usr_ok")?.maritimeAgentId).toBe("agt_42");
  });

  it("rate-limits signups per address and caps pending signups globally", async () => {
    const { base, store } = await boot({ signupLimits: { perIp: 2, windowMs: 60_000, maxPending: 3, pendingWindowMs: 3_600_000 } });
    const a = await signup(base, { name: "A", phone: "+14155550001", handle: "aaa-one" });
    const b = await signup(base, { name: "B", phone: "+14155550002", handle: "bbb-two" });
    const c = await signup(base, { name: "C", phone: "+14155550003", handle: "ccc-three" });
    expect([a.status, b.status, c.status]).toEqual([202, 202, 429]);
    expect(await c.json()).toMatchObject({ error: expect.stringContaining("too many") });
    expect(store.all()).toHaveLength(2);

    // X-Forwarded-For is ignored unless the gateway is told to trust it.
    const spoofed = await signup(base, { name: "D", phone: "+14155550004", handle: "ddd-four" }, { "x-forwarded-for": "203.0.113.9" });
    expect(spoofed.status).toBe(429);

    const trusted = await boot({ trustProxy: true, signupLimits: { perIp: 1, windowMs: 60_000, maxPending: 2, pendingWindowMs: 3_600_000 } });
    expect((await signup(trusted.base, { name: "A", phone: "+14155550011", handle: "aaa-eleven" }, { "x-forwarded-for": "203.0.113.1" })).status).toBe(202);
    expect((await signup(trusted.base, { name: "B", phone: "+14155550012", handle: "bbb-twelve" }, { "x-forwarded-for": "203.0.113.2, 10.0.0.1" })).status).toBe(202);
    // Third address is under its own per-IP budget but the pending cap is reached.
    const capped = await signup(trusted.base, { name: "C", phone: "+14155550013", handle: "ccc-thirteen" }, { "x-forwarded-for": "203.0.113.3" });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: expect.stringContaining("paused") });
    expect(trusted.store.all()).toHaveLength(2);
  });

  it("disables signup without a provisioner", async () => {
    const { base } = await boot({ withInkbox: false });
    const page = await (await fetch(base)).text();
    expect(page).toContain("Signups are closed");
    const res = await fetch(`${base}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
  });

  it("relays webhooks: 404 unknown user, 401 bad signature, 204 then forward", async () => {
    const { base, store, mar } = await boot();
    const user = store.save(readyUser());
    const raw = JSON.stringify(imessageEvent("evt_http", "conv_http"));

    expect((await fetch(`${base}/webhooks/inkbox/usr_nobody`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, "whsec_wrong") })).status).toBe(401);
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "GET" })).status).toBe(405);

    const ok = await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) });
    expect(ok.status).toBe(204);
    await waitFor(() => mar.calls.length === 1);
    expect(mar.calls[0]?.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    expect((mar.calls[0]?.body as { conversation_id: string }).conversation_id).toBe("conv_http");

    // Same event id again: accepted on the wire, dropped before Maritime.
    const dup = await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) });
    expect(dup.status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mar.calls).toHaveLength(1);
  });

  it("relays the Link OAuth callback to the user's agent as an envelope and shows a done page", async () => {
    const { base, store, mar } = await boot();
    store.save(readyUser({ id: "usr_link" }));
    const res = await fetch(`${base}/oauth/link/callback/usr_link?code=ac_123&state=st_abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Go back to your messages");
    expect(mar.calls).toHaveLength(1);
    expect(mar.calls[0]?.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    const body = mar.calls[0]?.body as { message: string; conversation_id: string };
    expect(body.conversation_id).toBe("link:usr_link");
    expect(decodeEvent(body.message)).toMatchObject({ type: "link.oauth_callback", code: "ac_123", state: "st_abc" });

    expect((await fetch(`${base}/oauth/link/callback/usr_nobody?code=x&state=y`)).status).toBe(404);
    expect((await fetch(`${base}/oauth/link/callback/usr_link`)).status).toBe(400);

    // An agent that is not provisioned yet cannot take the code; the page says so.
    store.save(readyUser({ id: "usr_new", status: "provisioning", maritimeAgentId: undefined }));
    const early = await fetch(`${base}/oauth/link/callback/usr_new?code=ac&state=st`);
    expect(early.status).toBe(502);
    expect(await early.text()).toContain("Not connected");
  });

  it("returns json 404 for unknown routes and html 404 for unknown connect ids", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const connect = await fetch(`${base}/connect/usr_missing`);
    expect(connect.status).toBe(404);
    expect(await connect.text()).toContain("No Instinct with that id");
  });
});
