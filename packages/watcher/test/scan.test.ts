// [sunshine:watcher]
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelevanceSieve } from "../src/jev.js";
import { headlineKeys, runScan } from "../src/scan.js";
import { WatchStore } from "../src/store.js";
import { NOON, feeds, fixture, publicLookup, type Fixture } from "./helpers.js";

/** A sieve that answers from the headline: "about" in the title means yes. */
function wordSieve(fail = false): RelevanceSieve & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: "fake",
    asked,
    async relevance(topic, item) {
      asked.push(`${topic}|${item.title}`);
      if (fail) throw new Error("down");
      return { p: item.title.includes("about") ? 0.9 : 0.05, inputTokens: 100 };
    },
  };
}

let f: Fixture;
let store: WatchStore;
beforeEach(() => {
  f = fixture();
  store = new WatchStore(f.state, () => NOON);
  store.update((s) => {
    s.searches = [
      { topic: "Brann, the Bergen football club", query: "SK Brann", edition: "no-NO" },
      { topic: "Taylor Swift", query: "Taylor Swift", edition: "en-US" },
    ];
  });
});
afterEach(() => f.cleanup());

const brann = [
  { title: "Match report about Brann", link: "https://n/1", source: "BT", hoursAgo: 2 },
  { title: "House fire (brann) in Bergen", link: "https://n/2", source: "NRK", hoursAgo: 3 },
  { title: "Old news about Brann", link: "https://n/3", hoursAgo: 40 },
];
const swift = [
  { title: "Taylor Swift tour news about Oslo", link: "https://n/4", hoursAgo: 1 },
  // The same story again under another link, as when two searches overlap.
  { title: "Match report about Brann", link: "https://n/5", hoursAgo: 2 },
];

describe("a news check", () => {
  it("keeps the last day's new headlines that the sieve says are on topic, and remembers what it looked at", async () => {
    const { fetchImpl } = feeds({ "SK Brann": brann, "Taylor Swift": swift });
    const sieve = wordSieve();
    const { summary, candidates } = await runScan({ store, sieve, fetchImpl, lookup: publicLookup, now: () => NOON });

    expect(candidates.map((c) => c.link).sort()).toEqual(["https://n/1", "https://n/4"]);
    expect(summary).toMatchObject({ searches: 2, fetched: 5, fresh: 3, passed: 2, sieve: "jev", jevInputTokens: 300, errors: [] });
    // The 40-hour-old one and the re-post never reached the sieve.
    expect(sieve.asked).toHaveLength(3);
    const seen = store.read().seen;
    for (const link of ["https://n/1", "https://n/2", "https://n/4"]) expect(seen[`l:${link}`]).toBe(NOON.toISOString());
    expect(store.read().lastCheck?.passed).toBe(2);
  });

  it("shows nothing twice", async () => {
    const { fetchImpl } = feeds({ "SK Brann": brann, "Taylor Swift": swift });
    await runScan({ store, sieve: wordSieve(), fetchImpl, lookup: publicLookup, now: () => NOON });
    const again = await runScan({ store, sieve: wordSieve(), fetchImpl, lookup: publicLookup, now: () => NOON });
    expect(again.candidates).toEqual([]);
    expect(again.summary.fresh).toBe(0);
  });

  it("lets the newest few through unsieved when Jev is down, and does not mark the rest as seen", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `Brann item ${i}`, link: `https://n/b${i}`, hoursAgo: i + 1 }));
    const { fetchImpl } = feeds({ "SK Brann": many, "Taylor Swift": [] });
    const { summary, candidates } = await runScan({ store, sieve: wordSieve(true), fetchImpl, lookup: publicLookup, now: () => NOON, unsievedPerSearch: 3 });
    expect(candidates.map((c) => c.link)).toEqual(["https://n/b0", "https://n/b1", "https://n/b2"]);
    expect(candidates.every((c) => c.p === undefined)).toBe(true);
    expect(summary.sieve).toBe("none");
    expect(summary.errors.join(" ")).toMatch(/failed on 10 of 10/);
    expect(store.read().seen["l:https://n/b5"]).toBeUndefined();
  });

  it("works without a key: the newest few per search, marked unfiltered", async () => {
    const { fetchImpl } = feeds({ "SK Brann": brann, "Taylor Swift": swift });
    const { summary, candidates } = await runScan({ store, fetchImpl, lookup: publicLookup, now: () => NOON, unsievedPerSearch: 1 });
    expect(summary.sieve).toBe("none");
    expect(candidates).toHaveLength(2);
  });

  it("goes on when one feed fails, and says so", async () => {
    const { fetchImpl } = feeds({ "SK Brann": 503, "Taylor Swift": swift });
    const { summary, candidates } = await runScan({ store, sieve: wordSieve(), fetchImpl, lookup: publicLookup, now: () => NOON });
    expect(summary.errors.join(" ")).toMatch(/SK Brann.*HTTP 503/);
    // The other search still runs; its copy of the Brann story is not a repeat now, so it counts.
    expect(candidates.map((c) => c.link).sort()).toEqual(["https://n/4", "https://n/5"]);
  });

  it("keeps a full short list's overflow for the next check", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `News about Brann ${i}`, link: `https://n/o${i}`, hoursAgo: i + 1 }));
    const { fetchImpl } = feeds({ "SK Brann": many, "Taylor Swift": [] });
    const { candidates } = await runScan({ store, sieve: wordSieve(), fetchImpl, lookup: publicLookup, now: () => NOON, totalMax: 2 });
    expect(candidates).toHaveLength(2);
    const seen = store.read().seen;
    expect(Object.keys(seen).filter((k) => k.startsWith("l:"))).toHaveLength(2);
  });

  it("remembers a headline by its wording too", () => {
    expect(headlineKeys({ link: "https://a", title: "Brann: 2-1!" })).toEqual(["l:https://a", "t:brann 2 1"]);
  });
});
