import { describe, expect, it } from "vitest";
import { ContactStore } from "../src/contacts.js";
import { OWNER_EMAIL_PRINCIPAL_ID, isReservedHandle, normalizeHandle, normalizePhone, phoneCountryOf, resolvePrincipal, type PhoneCountry } from "../src/principal.js";
import { inbound, tempState, testConfig } from "./helpers.js";

describe("normalizePhone", () => {
  it("keeps digits, prefixes +, assumes US for ten digits", () => {
    expect(normalizePhone("(617) 555-0100")).toBe("+16175550100");
    expect(normalizePhone("617.555.0100")).toBe("+16175550100");
    expect(normalizePhone("+1 617 555 0100")).toBe("+16175550100");
    expect(normalizePhone("1-617-555-0100")).toBe("+16175550100");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("abc")).toBe("");
  });

  it("keeps the country of a number written with +, even when it has ten digits", () => {
    // A Norwegian number is ten digits with its 47. It used to become +1 474...
    expect(normalizePhone("+4745775184")).toBe("+4745775184");
    expect(normalizePhone("+47 457 75 184")).toBe("+4745775184");
    expect(normalizePhone("  +4745775184 ")).toBe("+4745775184");
    expect(normalizePhone("+46 8 123 4567")).toBe("+4681234567");
  });

  it("reads local formats as the default country", () => {
    const cases: Array<[string, PhoneCountry, string]> = [
      ["457 75 184", "NO", "+4745775184"],
      ["004745775184", "NO", "+4745775184"],
      ["+46 70 123 45 67", "SE", "+46701234567"],
      ["070-123 45 67", "SE", "+46701234567"],
      ["08-123 456 78", "SE", "+46812345678"],
      ["+44 7400 123456", "GB", "+447400123456"],
      ["07400 123456", "GB", "+447400123456"],
      ["+44 20 7946 0958", "GB", "+442079460958"],
      ["(617) 555-0100", "US", "+16175550100"],
      ["+1 617 555 0100", "US", "+16175550100"],
      ["+46 70 123 45 67", "NO", "+46701234567"],
    ];
    for (const [input, country, want] of cases) expect(normalizePhone(input, country), `${input} in ${country}`).toBe(want);
  });

  it("keeps the digits of a number the library cannot place", () => {
    expect(normalizePhone("12345")).toBe("+12345");
  });
});

describe("phoneCountryOf", () => {
  it("takes the country from the owner's phone and falls back to US", () => {
    const owner = (phones: string[]) => ({ owner: { ...testConfig().owner, phones } });
    expect(phoneCountryOf(owner(["+4745775184"]))).toBe("NO");
    expect(phoneCountryOf(owner(["+46701234567"]))).toBe("SE");
    expect(phoneCountryOf(owner(["+447400123456"]))).toBe("GB");
    expect(phoneCountryOf(owner(["+16175550100"]))).toBe("US");
    expect(phoneCountryOf(owner([]))).toBe("US");
  });
});

describe("normalizeHandle", () => {
  it("strips @ and lowercases", () => {
    expect(normalizeHandle("@Maria-Instinct")).toBe("maria-instinct");
    expect(normalizeHandle("  sam_bot ")).toBe("sam_bot");
    expect(normalizeHandle("@@x")).toBe("x");
  });
});

describe("resolvePrincipal", () => {
  const config = testConfig();

  function contacts(): ContactStore {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", tier: "partner", phones: ["(415) 555-0199"], emails: ["Sam@Example.com"], agentHandle: "@Sam-Instinct" });
    store.upsert({ name: "Alex Kim", tier: "friend", emails: ["alex@example.com"] });
    return store;
  }

  it("recognises the owner by phone in any formatting and on local channels", () => {
    const c = contacts();
    for (const from of ["+16175550100", "(617) 555-0100", "617-555-0100", "16175550100"]) {
      const p = resolvePrincipal(inbound({ channel: "imessage", from }), config, c);
      expect(p.kind, from).toBe("owner");
      expect(p.id).toBe("owner");
      expect(p.tier).toBe("owner");
      expect(p.displayName).toBe("Maria");
      expect(p.phone).toBe("+16175550100");
    }
    for (const channel of ["chat", "scheduled", "system"] as const) {
      expect(resolvePrincipal(inbound({ channel, from: "anything" }), config, c).kind).toBe("owner");
    }
  });

  it("recognises an owner outside the US by their real number, not a US look-alike", () => {
    const norwegian = { ...config, owner: { ...config.owner, phones: ["+4745775184"] } };
    const c = contacts();
    for (const from of ["+4745775184", "+47 457 75 184", "004745775184"]) {
      const p = resolvePrincipal(inbound({ channel: "imessage", from }), norwegian, c);
      expect(p.kind, from).toBe("owner");
      expect(p.phone).toBe("+4745775184");
    }
    expect(resolvePrincipal(inbound({ channel: "imessage", from: "+14745775184" }), norwegian, c).kind).toBe("stranger");
  });

  it("reduces the owner's own email address to a partner-tier contact, because From can be forged", () => {
    const c = contacts();
    const p = resolvePrincipal(inbound({ channel: "email", from: "MARIA@example.com" }), config, c);
    expect(p.kind).toBe("contact");
    expect(p.id).toBe(OWNER_EMAIL_PRINCIPAL_ID);
    expect(p.tier).toBe("partner");
    expect(p.email).toBe("maria@example.com");
    expect(p.displayName).toContain("Maria");
    expect(p.displayName).toMatch(/unverified/);
  });

  it("never honours the literal sender \"owner\" on a network channel", () => {
    const c = contacts();
    const im = resolvePrincipal(inbound({ channel: "imessage", from: "owner" }), config, c);
    expect(im.kind).toBe("stranger");
    expect(im.tier).toBe("stranger");
    const a2a = resolvePrincipal(inbound({ channel: "a2a", from: "owner" }), config, c);
    expect(a2a).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:a2a:owner", agentHandle: "owner" });
    expect(resolvePrincipal(inbound({ channel: "a2a", from: "@Owner" }), config, c).kind).toBe("stranger");
    expect(resolvePrincipal(inbound({ channel: "email", from: "owner" }), config, c).kind).toBe("stranger");
    expect(isReservedHandle("@OWNER")).toBe(true);
    expect(isReservedHandle("sam-instinct")).toBe(false);
  });

  it("resolves contacts by phone and email with their tier", () => {
    const c = contacts();
    const byPhone = resolvePrincipal(inbound({ channel: "sms", from: "415-555-0199" }), config, c);
    expect(byPhone).toMatchObject({ kind: "contact", id: "contact:sam-lee", tier: "partner", displayName: "Sam Lee", contactId: "sam-lee", phone: "+14155550199", agentHandle: "sam-instinct" });
    const byEmail = resolvePrincipal(inbound({ channel: "email", from: "ALEX@example.com" }), config, c);
    expect(byEmail).toMatchObject({ kind: "contact", id: "contact:alex-kim", tier: "friend", email: "alex@example.com" });
  });

  it("maps an A2A caller handle to the contact's agent", () => {
    const c = contacts();
    const p = resolvePrincipal(inbound({ channel: "a2a", from: "@Sam-Instinct" }), config, c);
    expect(p.kind).toBe("agent");
    expect(p.id).toBe("agent:sam-instinct");
    expect(p.tier).toBe("partner");
    expect(p.agentHandle).toBe("sam-instinct");
    expect(p.contactId).toBe("sam-lee");
    expect(p.onBehalfOf).toEqual({ displayName: "Sam Lee", contactId: "sam-lee" });
  });

  it("treats everyone else as a stranger with a channel-scoped id", () => {
    const c = contacts();
    const sms = resolvePrincipal(inbound({ channel: "imessage", from: "(212) 555-0000" }), config, c);
    expect(sms).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:imessage:+12125550000", phone: "+12125550000" });
    const mail = resolvePrincipal(inbound({ channel: "email", from: "Nobody@Nowhere.org" }), config, c);
    expect(mail).toMatchObject({ kind: "stranger", id: "stranger:email:nobody@nowhere.org", email: "nobody@nowhere.org" });
    const a2a = resolvePrincipal(inbound({ channel: "a2a", from: "unknown-bot" }), config, c);
    expect(a2a).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:a2a:unknown-bot", agentHandle: "unknown-bot" });
    expect(a2a.contactId).toBeUndefined();
  });

  it("never promotes a contact to owner through a shared-looking address", () => {
    const c = contacts();
    c.upsert({ name: "Impostor", tier: "stranger", phones: ["+16175550101"] });
    const p = resolvePrincipal(inbound({ channel: "imessage", from: "+16175550101" }), config, c);
    expect(p.kind).toBe("contact");
    expect(p.tier).toBe("stranger");
  });
});
