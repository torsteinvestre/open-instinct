import { describe, expect, it } from "vitest";
import { ContactStore, slugify } from "../src/contacts.js";
import { tempState } from "./helpers.js";

describe("slugify", () => {
  it("makes readable ids", () => {
    expect(slugify("Sam Lee")).toBe("sam-lee");
    expect(slugify("  Zoë  O'Brien ")).toBe("zoe-o-brien");
    expect(slugify("!!!")).toBe("contact");
  });
});

describe("ContactStore", () => {
  it("reads local numbers as the owner's country and finds them in any format", () => {
    const store = new ContactStore(tempState(), { phoneCountry: "SE" });
    const c = store.upsert({ name: "Anna Berg", phones: ["070-123 45 67"] });
    expect(c.phones).toEqual(["+46701234567"]);
    expect(store.findByPhone("+46 70 123 45 67")?.id).toBe("anna-berg");
    expect(store.findByPhone("0701234567")?.id).toBe("anna-berg");
    const friend = store.upsert({ name: "Ola Nordmann", phones: ["+47 912 34 567"] });
    expect(friend.phones).toEqual(["+4791234567"]);
  });

  it("refuses the reserved agent handle \"owner\"", () => {
    const store = new ContactStore(tempState());
    expect(() => store.upsert({ name: "Impostor", agentHandle: "@Owner" })).toThrow(/reserved/);
    expect(store.all()).toHaveLength(0);
    expect(store.findByHandle("owner")).toBeUndefined();
  });

  it("creates contacts with slug ids, normalized addresses and a default tier", () => {
    const store = new ContactStore(tempState());
    const c = store.upsert({ name: "Sam Lee", phones: ["(415) 555-0199"], emails: ["Sam@Example.com"], agentHandle: "@Sam-Instinct" });
    expect(c.id).toBe("sam-lee");
    expect(c.tier).toBe("contact");
    expect(c.phones).toEqual(["+14155550199"]);
    expect(c.emails).toEqual(["sam@example.com"]);
    expect(c.agentHandle).toBe("sam-instinct");
    expect(Date.parse(c.createdAt)).not.toBeNaN();
    expect(store.all()).toHaveLength(1);
  });

  it("merges on shared phone, email or handle and keeps existing addresses", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"] });
    const merged = store.upsert({ name: "Samantha Lee", tier: "partner", phones: ["415-555-0199"], emails: ["sam@example.com"] });
    expect(merged.id).toBe("sam-lee");
    expect(merged.name).toBe("Samantha Lee");
    expect(merged.tier).toBe("partner");
    expect(merged.emails).toEqual(["sam@example.com"]);
    expect(store.all()).toHaveLength(1);
    const byHandle = store.upsert({ name: "Sam", agentHandle: "sam-bot" });
    expect(byHandle.id).toBe("sam");
    const again = store.upsert({ name: "Sam L.", agentHandle: "@SAM-BOT", notes: "met at MIT" });
    expect(again.id).toBe("sam");
    expect(again.notes).toBe("met at MIT");
    expect(store.all()).toHaveLength(2);
  });

  it("merges by name when adding an address, and separates same-name people by explicit id", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Alex Kim", phones: ["+12125550001"] });
    const merged = store.upsert({ name: "Alex Kim", emails: ["alex@example.com"] });
    expect(merged.id).toBe("alex-kim");
    expect(merged.phones).toEqual(["+12125550001"]);
    expect(merged.emails).toEqual(["alex@example.com"]);
    const other = store.upsert({ id: "alex-kim-work", name: "Alex Kim", phones: ["+12125550002"] });
    expect(other.id).toBe("alex-kim-work");
    expect(store.all()).toHaveLength(2);
    expect(store.findByPhone("+12125550002")?.id).toBe("alex-kim-work");
    expect(store.upsert({ id: "alex-kim-work", name: "Alex Kim (work)" }).name).toBe("Alex Kim (work)");
    expect(store.all()).toHaveLength(2);
  });

  it("finds by phone, email and handle regardless of formatting", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"], emails: ["sam@example.com"], agentHandle: "sam-instinct" });
    expect(store.findByPhone("415.555.0199")?.id).toBe("sam-lee");
    expect(store.findByPhone("+12125550000")).toBeUndefined();
    expect(store.findByEmail("SAM@EXAMPLE.COM")?.id).toBe("sam-lee");
    expect(store.findByHandle("@Sam-Instinct")?.id).toBe("sam-lee");
    expect(store.findByHandle("")).toBeUndefined();
    expect(store.get("sam-lee")?.name).toBe("Sam Lee");
    expect(store.get("nobody")).toBeUndefined();
  });

  it("searches names, notes, emails and phone digits", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"], notes: "dentist" });
    store.upsert({ name: "Alex Kim", emails: ["alex@mit.edu"] });
    expect(store.search("sam").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("DENTIST").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("mit.edu").map((c) => c.id)).toEqual(["alex-kim"]);
    expect(store.search("555-0199").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("")).toHaveLength(2);
    expect(store.search("zzz")).toHaveLength(0);
  });

  it("sets tiers, removes, and persists across instances", () => {
    const state = tempState();
    const store = new ContactStore(state);
    store.upsert({ name: "Sam Lee" });
    expect(store.setTier("sam-lee", "family")?.tier).toBe("family");
    expect(store.setTier("nobody", "family")).toBeUndefined();
    expect(new ContactStore(state).get("sam-lee")?.tier).toBe("family");
    expect(store.remove("sam-lee")).toBe(true);
    expect(store.remove("sam-lee")).toBe(false);
    expect(new ContactStore(state).all()).toHaveLength(0);
  });

  it("returns copies so callers cannot corrupt the store", () => {
    const store = new ContactStore(tempState());
    const c = store.upsert({ name: "Sam Lee" });
    c.tier = "owner";
    c.phones.push("+10000000000");
    expect(store.get("sam-lee")?.tier).toBe("contact");
    expect(store.get("sam-lee")?.phones).toEqual([]);
  });
});
