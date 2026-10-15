import { describe, expect, it } from "vitest";
import { InkboxProvisioner } from "@open-instinct/inkbox";
import { DEFAULT_MARITIME_LLM_MODEL, MARITIME_AGENT_PORT, agentEnvFor, linkRedirectUriFor, maritimeCreateBody, provisionUser, webhookUrlFor } from "../src/provision.js";
import { UserStore } from "../src/store.js";
import { fakeInkbox, fakeMaritime, readyUser, tempDir } from "./helpers.js";

const input = { name: "Maria", phone: "+14155550123", email: "maria@example.com", handle: "maria" };

function deps(ink = fakeInkbox(), mar = fakeMaritime(), store = new UserStore(tempDir())) {
  return {
    ink,
    mar,
    store,
    deps: {
      inkbox: ink.provisioner,
      maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "ghcr.io/x/agent:1", extraEnv: { INSTINCT_MODEL: "anthropic/claude-fable-5-1", EXTRA_TOKEN: "t" } },
      publicUrl: "https://gw.example.com/",
      store,
      anthropicApiKey: "sk-ant",
      composioApiKey: "cmp",
      fetchImpl: mar.fetch,
    },
  };
}

describe("provisionUser", () => {
  it("does not attach a new user to an existing readable identity", async () => {
    const d = deps();
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const inkbox = new InkboxProvisioner({ adminApiKey: "test_admin", baseUrl: "https://inkbox.example", fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, path, body });
      let value: unknown;
      if (path === "/api/v1/identities/maria") value = { id: "previous_identity", agent_handle: "maria", imessage_enabled: true };
      else if (path === "/api/v1/identities/") {
        if (body.agent_handle === "maria") return new Response("{}", { status: 409 });
        value = { id: "new_identity", agent_handle: body.agent_handle, imessage_enabled: true };
      } else if (path === "/api/v1/api-keys") value = { api_key: "test_scoped" };
      else if (path.endsWith("/signing-key")) value = method === "GET" ? { configured: false } : { signing_key: "test_signing" };
      else if (path === "/api/v1/webhooks/subscriptions") value = { id: "new_subscription" };
      else throw new Error(`Unexpected request: ${method} ${path}`);
      return new Response(JSON.stringify(value), { status: 200 });
    } });
    const user = await provisionUser(input, { ...d.deps, inkbox });
    expect(user).toMatchObject({ identityId: "new_identity", handle: "maria-2", phone: input.phone });
    expect(calls.some((call) => call.path === "/api/v1/identities/maria")).toBe(false);
    expect(calls.find((call) => call.path === "/api/v1/api-keys")?.body.scoped_identity_id).toBe("new_identity");
  });

  it("runs the steps in order and saves a ready record", async () => {
    const d = deps();
    const user = await provisionUser(input, d.deps);
    expect(d.ink.calls).toEqual([
      "provisionIdentity",
      "mintIdentityKey",
      "ensureSigningKey",
      `subscribeWebhooks https://gw.example.com/webhooks/inkbox/${user.id}`,
    ]);
    expect(d.mar.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/agents", "POST /api/agents"]);
    expect(d.mar.calls[1]?.headers["authorization"]).toBe("Bearer mk_test");
    expect(user.status).toBe("ready");
    expect(user.identityId).toBe("idn_maria");
    expect(user.identityApiKey).toBe("ik_idn_maria");
    expect(user.signingKey).toBe("whsec_maria");
    expect(user.webhookSubscriptionId).toBe("sub_idn_maria");
    expect(user.maritimeAgentId).toMatch(/^agt_/);
    expect(user.maritimeProjectId).toBe("prj_1");
    expect(d.store.get(user.id)?.status).toBe("ready");
  });

  it("sends the Maritime create body the BYO contract expects, with secrets marked", async () => {
    const d = deps();
    const user = await provisionUser(input, d.deps);
    const body = d.mar.calls[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "instinct-maria",
      framework: "custom",
      imageName: "ghcr.io/x/agent:1",
      exposedPort: MARITIME_AGENT_PORT,
      healthCheckPath: "/health",
      desktop: true,
      externalId: user.id,
      idleTtlSeconds: 900,
    });
    expect(body["exposedPort"]).toBe(18789);
    expect(body["useMaritimeLlm"]).toBeUndefined();
    expect(typeof body["instructions"]).toBe("string");
    const env = body["initialEnvVars"] as Array<{ key: string; value: string; isSecret: boolean }>;
    const byKey = Object.fromEntries(env.map((e) => [e.key, e]));
    // The bound port and the exposed port are the same number, stated once.
    expect(byKey["PORT"]).toEqual({ key: "PORT", value: "18789", isSecret: false });
    expect(env.filter((e) => e.key === "PORT")).toHaveLength(1);
    expect(byKey["INKBOX_API_KEY"]).toEqual({ key: "INKBOX_API_KEY", value: "ik_idn_maria", isSecret: true });
    expect(byKey["INKBOX_AGENT_HANDLE"]?.value).toBe("maria");
    expect(byKey["INKBOX_IDENTITY_ID"]?.value).toBe("idn_maria");
    expect(byKey["INSTINCT_OWNER_NAME"]?.value).toBe("Maria");
    expect(byKey["INSTINCT_OWNER_PHONE"]?.value).toBe("+14155550123");
    expect(byKey["INSTINCT_OWNER_EMAIL"]?.value).toBe("maria@example.com");
    expect(byKey["ANTHROPIC_API_KEY"]).toMatchObject({ isSecret: true });
    expect(byKey["COMPOSIO_API_KEY"]).toMatchObject({ isSecret: true });
    // Without COMPOSIO_TOOLKITS core keeps apps disabled, so the key alone would be useless.
    expect(byKey["COMPOSIO_TOOLKITS"]).toEqual({ key: "COMPOSIO_TOOLKITS", value: "gmail,googlecalendar,googlecontacts", isSecret: false });
    expect(byKey["INSTINCT_COMPUTER"]?.value).toBe("auto");
    expect(byKey["INSTINCT_MODEL"]).toMatchObject({ isSecret: false });
    expect(byKey["EXTRA_TOKEN"]).toMatchObject({ isSecret: true });
    // The signing key verifies webhooks in the gateway and must not travel to the agent.
    expect(env.some((e) => e.value === "whsec_maria")).toBe(false);
  });

  // [sunshine:gateway-settings]
  it("names every agent after the brand and can leave the desktop off", async () => {
    const d = deps();
    type IdentityInput = Parameters<InkboxProvisioner["provisionIdentity"]>[0];
    const seen: IdentityInput[] = [];
    const inkbox = {
      ...d.ink.provisioner,
      provisionIdentity: async (i: IdentityInput) => {
        seen.push(i);
        return d.ink.provisioner.provisionIdentity(i);
      },
    } as unknown as InkboxProvisioner;
    const brand = { product: "Sunshine", agent: "Sunshine" };
    await provisionUser(input, { ...d.deps, inkbox, brand, maritime: { ...d.deps.maritime, desktop: false } });
    expect(seen[0]).toMatchObject({ displayName: "Sunshine", description: "Sunshine for Maria" });
    const body = d.mar.calls[1]?.body as Record<string, unknown>;
    expect(body["desktop"]).toBe(false);
    expect(String(body["instructions"])).toMatch(/^You are Sunshine, Maria's personal agent \(@maria\), reached over/);
    const env = body["initialEnvVars"] as Array<{ key: string; value: string }>;
    expect(env.find((e) => e.key === "INSTINCT_AGENT_NAME")?.value).toBe("Sunshine");
  });

  // [sunshine:timezone]
  it("seeds the agent's clock with the signup's timezone", () => {
    const env = agentEnvFor(readyUser({ timezone: "Europe/Oslo" }), { maritime: { apiKey: "k", agentImage: "img" } });
    expect(env.find((e) => e.key === "INSTINCT_OWNER_TIMEZONE")).toEqual({ key: "INSTINCT_OWNER_TIMEZONE", value: "Europe/Oslo", isSecret: false });
  });

  it("omits optional env when not configured", () => {
    const env = agentEnvFor(readyUser({ email: undefined }), { maritime: { apiKey: "k", agentImage: "img" } });
    const keys = env.map((e) => e.key);
    expect(keys).not.toContain("INSTINCT_OWNER_EMAIL");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("COMPOSIO_API_KEY");
    expect(keys).not.toContain("COMPOSIO_TOOLKITS");
    expect(keys).not.toContain("INSTINCT_MODEL");
    expect(keys).not.toContain("LINK_CLIENT_ID");
    expect(keys).not.toContain("INSTINCT_AGENT_NAME");
    expect(keys).not.toContain("INSTINCT_OWNER_TIMEZONE"); // [sunshine:timezone]
    expect(maritimeCreateBody(readyUser(), { maritime: { apiKey: "k", agentImage: "img", idleTtlSeconds: 60 } })["idleTtlSeconds"]).toBe(60);
    expect(webhookUrlFor("https://gw.example.com///", "usr x")).toBe("https://gw.example.com/webhooks/inkbox/usr%20x");
  });

  it("keeps the selected Inkbox endpoint with each agent's credentials", () => {
    const env = agentEnvFor(readyUser(), {
      inkboxBaseUrl: "https://inkbox.example", maritime: { apiKey: "test", agentImage: "image" },
    });
    expect(env).toContainEqual({ key: "INKBOX_BASE_URL", value: "https://inkbox.example", isSecret: false });
  });

  it("sends the operator's toolkits with the Composio key and keeps an extraEnv PORT from duplicating", () => {
    const env = agentEnvFor(readyUser(), { composioApiKey: "cmp", composioToolkits: "gmail, slack", maritime: { apiKey: "k", agentImage: "img", extraEnv: { PORT: "8080", COMPOSIO_TOOLKITS: "ignored" } } });
    const byKey = Object.fromEntries(env.map((e) => [e.key, e.value]));
    expect(byKey["COMPOSIO_TOOLKITS"]).toBe("gmail, slack");
    expect(byKey["PORT"]).toBe("18789");
    expect(env.filter((e) => e.key === "PORT")).toHaveLength(1);
    expect(env.filter((e) => e.key === "COMPOSIO_TOOLKITS")).toHaveLength(1);
  });

  it("asks for Maritime's metered LLM and points INSTINCT_MODEL at it", () => {
    const deps = { maritime: { apiKey: "k", agentImage: "img", useMaritimeLlm: true } };
    const body = maritimeCreateBody(readyUser(), deps);
    expect(body["useMaritimeLlm"]).toBe(true);
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string; isSecret: boolean }>).map((e) => [e.key, e]));
    expect(byKey["INSTINCT_MODEL"]).toEqual({ key: "INSTINCT_MODEL", value: `openai-compatible/${DEFAULT_MARITIME_LLM_MODEL}`, isSecret: false });

    const custom = agentEnvFor(readyUser(), { maritime: { apiKey: "k", agentImage: "img", useMaritimeLlm: true, maritimeModel: "gpt-5.5", extraEnv: { INSTINCT_MODEL: "anthropic/x" } } });
    expect(custom.filter((e) => e.key === "INSTINCT_MODEL")).toEqual([{ key: "INSTINCT_MODEL", value: "openai-compatible/gpt-5.5", isSecret: false }]);
  });

  it("passes Link credentials through with a redirect URI on this gateway", () => {
    const env = agentEnvFor(readyUser({ id: "usr_l" }), {
      maritime: { apiKey: "k", agentImage: "img" },
      link: { clientId: "lc_1", clientSecret: "ls_1", stripePublishableKey: "pk_test_1" },
      publicUrl: "https://gw.example.com/",
    });
    const byKey = Object.fromEntries(env.map((e) => [e.key, e]));
    expect(byKey["LINK_CLIENT_ID"]).toEqual({ key: "LINK_CLIENT_ID", value: "lc_1", isSecret: false });
    expect(byKey["LINK_CLIENT_SECRET"]).toEqual({ key: "LINK_CLIENT_SECRET", value: "ls_1", isSecret: true });
    expect(byKey["STRIPE_PUBLISHABLE_KEY"]).toEqual({ key: "STRIPE_PUBLISHABLE_KEY", value: "pk_test_1", isSecret: false });
    expect(byKey["LINK_REDIRECT_URI"]).toEqual({ key: "LINK_REDIRECT_URI", value: "https://gw.example.com/oauth/link/callback/usr_l", isSecret: false });
    expect(linkRedirectUriFor("https://gw.example.com", "usr x")).toBe("https://gw.example.com/oauth/link/callback/usr%20x");
  });

  it("resumes after a failure without repeating finished steps", async () => {
    const d = deps();
    d.ink.fail.ensureSigningKey = 1;
    await expect(provisionUser(input, d.deps)).rejects.toThrow("ensureSigningKey failed");
    const partial = d.store.byHandle("maria")!;
    expect(partial.status).toBe("error");
    expect(partial.error).toContain("ensureSigningKey");
    expect(partial.identityId).toBe("idn_maria");
    expect(partial.identityApiKey).toBe("ik_idn_maria");
    expect(d.mar.calls).toHaveLength(0);

    const user = await provisionUser(input, d.deps);
    expect(user.id).toBe(partial.id);
    expect(user.status).toBe("ready");
    expect(d.ink.calls).toEqual([
      "provisionIdentity",
      "mintIdentityKey",
      "ensureSigningKey",
      "ensureSigningKey",
      `subscribeWebhooks https://gw.example.com/webhooks/inkbox/${user.id}`,
    ]);
  });

  it("reuses an existing Maritime agent for the same external id instead of creating another", async () => {
    const d = deps();
    d.mar.existingAgents.push({ id: "agt_old", externalId: "usr_pinned", projectId: "prj_old" });
    const user = await provisionUser(input, { ...d.deps, userId: "usr_pinned" });
    expect(user.id).toBe("usr_pinned");
    expect(user.maritimeAgentId).toBe("agt_old");
    expect(d.mar.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("recovers from a 409 on create by listing again", async () => {
    const d = deps();
    d.mar.queue.push({ body: [] }, 409, { body: [{ id: "agt_raced", externalId: "usr_r" }] });
    const user = await provisionUser(input, { ...d.deps, userId: "usr_r" });
    expect(user.maritimeAgentId).toBe("agt_raced");
  });

  it("keeps the identity's final handle when Inkbox renamed it", async () => {
    const d = deps();
    const renamed = fakeInkbox();
    const original = renamed.provisioner.provisionIdentity.bind(renamed.provisioner);
    renamed.provisioner.provisionIdentity = async (i) => ({ ...(await original(i)), handle: `${i.handle}-2` });
    const user = await provisionUser(input, { ...d.deps, inkbox: renamed.provisioner });
    expect(user.handle).toBe("maria-2");
    expect((d.mar.calls[1]?.body as { name: string }).name).toBe("instinct-maria-2");
  });

  it("stores the subscription signing key as a fallback", async () => {
    const d = deps(fakeInkbox({ subscriptionSigningKey: "whsec_sub" }));
    const user = await provisionUser(input, d.deps);
    expect(user.signingKey).toBe("whsec_maria");
    expect(user.webhookSigningKey).toBe("whsec_sub");
  });

  it("returns a ready record untouched", async () => {
    const d = deps();
    d.store.save(readyUser());
    const user = await provisionUser(input, d.deps);
    expect(user.maritimeAgentId).toBe("agt_42");
    expect(d.ink.calls).toEqual([]);
  });

  it("surfaces Maritime errors with the server detail", async () => {
    const d = deps();
    d.mar.queue.push({ body: [] }, 402);
    await expect(provisionUser(input, d.deps)).rejects.toThrow("Maritime 402: status 402");
    expect(d.store.byHandle("maria")?.status).toBe("error");
  });
});
