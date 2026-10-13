// [sunshine:watcher]
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegisteredTool } from "@open-instinct/core";
import type { RelevanceSieve } from "../src/jev.js";
import { WatchStore } from "../src/store.js";
import { WATCH_PROMPT, watcherTools } from "../src/tools.js";
import { FRIEND, NOON, ctx, feeds, fixture, isError, publicLookup, textOf, type Fixture } from "./helpers.js";

let f: Fixture;
let tools: Map<string, RegisteredTool["spec"]>;
const yes: RelevanceSieve = { name: "fake", relevance: async () => ({ p: 0.9, inputTokens: 50 }) };

function build(extra: { fetchImpl?: typeof fetch; dailyLimit?: number } = {}) {
  tools = new Map(
    watcherTools({ state: f.state, config: f.config, outbox: f.outbox as never, audit: f.audit, scheduler: f.scheduler, sieve: yes, lookup: publicLookup, now: () => NOON, ...extra }).map((t) => [t.spec.name, t.spec]),
  );
}
const run = (name: string, args: Record<string, unknown> = {}, at: Date = NOON) => tools.get(name)!.execute(args as never, ctx(at));

beforeEach(() => {
  f = fixture();
  build();
});
afterEach(() => f.cleanup());

describe("the news watch tools", () => {
  it("are the seven expected, and every one refuses anyone but the owner", async () => {
    expect([...tools.keys()]).toEqual(["watch_profile", "watch_profile_update", "watch_scan", "watch_send", "watch_keep", "watch_later", "watch_settings"]);
    for (const name of tools.keys()) {
      const r = await tools.get(name)!.execute({ text: "x", items: [], profile: "x" } as never, ctx(NOON, FRIEND));
      expect(isError(r), name).toBe(true);
      expect(textOf(r), name).toMatch(/belongs to the owner/);
    }
    expect(f.sent).toHaveLength(0);
  });

  it("saves the written picture and the searches, and checks them", async () => {
    expect(isError(await run("watch_profile_update", { searches: [{ topic: "Brann", query: "SK Brann", edition: "norsk" }] }))).toBe(true);
    expect(isError(await run("watch_profile_update", { profile: "x".repeat(2001) }))).toBe(true);
    const ok = await run("watch_profile_update", {
      profile: "Huge Taylor Swift fan; lives in Oslo. Supports Brann. Mentioned a heatwave once (weak).",
      searches: [{ topic: "Brann, the Bergen football club", query: "SK Brann", edition: "no-NO" }, { topic: "Taylor Swift", query: "Taylor Swift" }],
    });
    expect(textOf(ok)).toBe("Saved. 2 searches.");
    const shown = textOf(await run("watch_profile"));
    expect(shown).toContain("Huge Taylor Swift fan");
    expect(shown).toContain('- Taylor Swift: "Taylor Swift" (en-US)');
    expect(shown).toContain("News watch: off");
  });

  describe("watch_send, the one door", () => {
    it("texts the owner's phone, remembers the links, and counts as the run's message", async () => {
      const r = await run("watch_send", { text: "Taylor Swift added an Oslo date: tickets Friday 10:00.", links: ["https://n/4"] });
      expect(textOf(r)).toBe("Sent to Torstein.");
      expect(f.sent).toEqual([{ channel: "imessage", to: "+4791234567", text: "Taylor Swift added an Oslo date: tickets Friday 10:00." }]);
      expect(new WatchStore(f.state, () => NOON).read().sent[0]?.links).toEqual(["https://n/4"]);
      expect(tools.get("watch_send")!.meta.replyTarget?.({})).toBe("owner");
      expect(f.audit.read({ kinds: ["outbound"] })[0]?.detail).toMatchObject({ via: "watcher", to: "+4791234567" });
    });

    it("holds anything in quiet hours, in the owner's own timezone", async () => {
      const lateEvening = new Date("2026-10-13T21:30:00Z"); // 23:30 in Oslo
      const r = await run("watch_send", { text: "Big news" }, lateEvening);
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toMatch(/quiet hours.*22:00-08:00.*watch_keep/);
      expect(f.sent).toHaveLength(0);
      expect(f.audit.read({ kinds: ["policy"] }).some((e) => e.detail.watcher === "held" && e.detail.reason === "quiet hours")).toBe(true);
      // The owner's own quiet hours count.
      await run("watch_settings", { quietStart: "23:45", quietEnd: "07:00" });
      expect(textOf(await run("watch_send", { text: "Big news" }, lateEvening))).toBe("Sent to Torstein.");
    });

    it("has a hidden daily limit the agent only meets when it hits it", async () => {
      build({ dailyLimit: 2 });
      expect(tools.get("watch_send")!.description).not.toMatch(/\d/);
      await run("watch_send", { text: "one" });
      await run("watch_send", { text: "two" });
      const third = await run("watch_send", { text: "three" });
      expect(textOf(third)).toMatch(/enough unprompted texts today/);
      expect(f.sent).toHaveLength(2);
      // A new day in Oslo starts fresh.
      expect(textOf(await run("watch_send", { text: "next day" }, new Date("2026-10-14T10:00:00Z")))).toBe("Sent to Torstein.");
    });

    it("never sends the same story twice", async () => {
      await run("watch_send", { text: "Brann signed a striker", links: ["https://n/1"] });
      const again = await run("watch_send", { text: "Brann signed a striker!", links: ["https://n/1", "https://n/9"] });
      expect(textOf(again)).toMatch(/already told them about https:\/\/n\/1/);
      expect(f.sent).toHaveLength(1);
    });

    it("refuses an empty or very long text, and an owner without a phone", async () => {
      expect(isError(await run("watch_send", { text: "  " }))).toBe(true);
      expect(isError(await run("watch_send", { text: "x".repeat(1201) }))).toBe(true);
      f.config.owner.phones = [];
      expect(textOf(await run("watch_send", { text: "hi" }))).toMatch(/no phone/);
    });
  });

  it("keeps stories for later, lists them once, and drops one that was sent", async () => {
    await run("watch_keep", { items: [{ title: "Brann friendly announced", link: "https://n/k1", topic: "Brann" }, { title: "Cooking show", link: "https://n/k2", why: "mildly fun" }] });
    await run("watch_keep", { items: [{ title: "dup", link: "https://n/k1" }] });
    await run("watch_send", { text: "Brann friendly", links: ["https://n/k1"] });
    const listed = textOf(await run("watch_later"));
    expect(listed).toContain("Cooking show");
    expect(listed).not.toContain("Brann friendly announced");
    expect(listed).toContain("<untrusted");
    expect(textOf(await run("watch_later"))).toBe("Nothing kept for later.");
  });

  describe("watch_settings", () => {
    it("turning it on schedules the checks in the owner's timezone, texting only through the door", async () => {
      const r = await run("watch_settings", { on: true });
      expect(textOf(r)).toContain("on, checks at 09:00 and 18:00 (Europe/Oslo)");
      const jobs = f.scheduler.list();
      expect(jobs.map((j) => j.cron)).toEqual(["0 9 * * *", "0 18 * * *"]);
      for (const j of jobs) expect(j).toMatchObject({ tz: "Europe/Oslo", prompt: WATCH_PROMPT, enabled: true, toolRepliesOnly: true });
    });

    it("moves the checks when the times change, and removes them when turned off", async () => {
      await run("watch_settings", { on: true });
      await run("watch_settings", { times: ["7", "20:30"] });
      expect(f.scheduler.list().map((j) => j.cron)).toEqual(["0 7 * * *", "30 20 * * *"]);
      await run("watch_settings", { on: false });
      expect(f.scheduler.list()).toEqual([]);
      expect(isError(await run("watch_settings", { times: ["25:00"] }))).toBe(true);
      expect(isError(await run("watch_settings", { times: [] }))).toBe(true);
    });

    it("brings back a check that was deleted by hand when turned on again", async () => {
      await run("watch_settings", { on: true });
      f.scheduler.delete(f.scheduler.list()[0]!.id);
      await run("watch_settings", { on: true });
      expect(f.scheduler.list()).toHaveLength(2);
    });
  });

  describe("watch_scan", () => {
    it("says so when there is nothing to search for", async () => {
      expect(textOf(await run("watch_scan"))).toMatch(/No searches yet/);
    });

    it("returns the short list as untrusted data, with the picture, what was told, and the quiet-hours state", async () => {
      const { fetchImpl } = feeds({ "Taylor Swift": [{ title: "Taylor Swift adds Oslo date", link: "https://n/4", source: "NRK", hoursAgo: 2 }] });
      build({ fetchImpl });
      await run("watch_profile_update", { profile: "Huge Taylor Swift fan in Oslo.", searches: [{ topic: "Taylor Swift", query: "Taylor Swift" }] });
      await run("watch_send", { text: "Earlier text", links: ["https://n/0"] });
      const out = textOf(await run("watch_scan"));
      expect(out).toMatch(/1 headlines from 1 searches, 1 new, 1 on the short list \(filter: Jev\)/);
      expect(out).toMatch(/<untrusted source="news headlines">[\s\S]*Taylor Swift adds Oslo date \(NRK\), 2 h ago[\s\S]*<\/untrusted>/);
      expect(out).toContain("Huge Taylor Swift fan in Oslo.");
      expect(out).toContain('"Earlier text"');
      expect(out).toContain("Not quiet hours.");
      expect(f.audit.read({ kinds: ["policy"] }).some((e) => e.detail.watcher === "check" && e.detail.passed === 1)).toBe(true);
    });
  });
});
