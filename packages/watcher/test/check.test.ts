// [sunshine:watcher] One news check end to end, with fake feeds, a fake Jev and fake models.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck, type CheckDeps } from "../src/check.js";
import type { RelevanceSieve } from "../src/jev.js";
import type { ModelCall } from "../src/models.js";
import { INTERESTS_QUESTION } from "../src/prompts.js";
import { WatchStore, type StoryCard } from "../src/store.js";
import { NOON, feeds, fixture, publicLookup, type FeedItem, type Fixture } from "./helpers.js";

const yes: RelevanceSieve = { name: "fake", relevance: async () => ({ p: 0.9, inputTokens: 100 }) };

/** A fake model step: answers from a queue (strings or errors) and records what it was asked. */
function fakeModel(name: string, replies: Array<string | Error | Record<string, unknown>>, costUsd = 0.01): ModelCall & { asked: Array<{ system: string; user: string }> } {
  const asked: Array<{ system: string; user: string }> = [];
  const call = (async ({ system, user }) => {
    asked.push({ system, user });
    const r = replies.shift();
    if (r === undefined) throw new Error(`${name}: no reply queued`);
    if (r instanceof Error) throw r;
    return { text: typeof r === "string" ? r : JSON.stringify(r), costUsd, model: name };
  }) as ModelCall & { asked: typeof asked };
  call.asked = asked;
  return call;
}

let f: Fixture;
let store: WatchStore;
beforeEach(() => {
  f = fixture();
  store = new WatchStore(f.state, () => NOON);
  store.update((s) => {
    s.on = true;
    s.profile = "Lives in Bergen. Lifelong SK Brann supporter, follows transfers closely.";
    s.searches = [{ topic: "Brann, the Bergen football club (SK Brann)", query: "SK Brann", edition: "no-NO" }];
  });
});
afterEach(() => f.cleanup());

function deps(items: FeedItem[] | number, extra: Partial<CheckDeps> = {}, at: Date = NOON): CheckDeps & { urls: string[] } {
  const { fetchImpl, urls } = feeds({ "SK Brann": items }, at);
  return { store, config: f.config, outbox: f.outbox as never, audit: f.audit, now: () => at, sieve: yes, fetchImpl, lookup: publicLookup, urls, ...extra };
}

const checks = () => f.audit.read({ kinds: ["policy"] }).filter((e) => e.detail.watcher === "check");
const signing = { title: "Brann signs striker Ola Nordmann from Molde", link: "https://n/sign", source: "BT", hoursAgo: 1 };
const friendly = { title: "Brann plays friendly in Spain", link: "https://n/friendly", source: "BA", hoursAgo: 2 };

describe("a news check", () => {
  it("does nothing at all in quiet hours or when off: no feeds, no models", async () => {
    const screen = fakeModel("haiku", []);
    const d = deps([signing], { screen, decide: fakeModel("sonnet", []) }, new Date("2026-10-13T21:30:00Z")); // 23:30 in Bergen
    expect((await runCheck(d, "scheduled")).status).toBe("quiet");
    store.update((s) => void (s.on = false));
    expect((await runCheck(deps([signing], { screen }), "scheduled")).status).toBe("off");
    expect(d.urls).toEqual([]);
    expect(screen.asked).toHaveLength(0);
  });

  it("calls no model when nothing new turned up", async () => {
    const screen = fakeModel("haiku", []);
    const out = await runCheck(deps([], { screen, decide: fakeModel("sonnet", []) }), "scheduled");
    expect(out.status).toBe("nothing new");
    expect(screen.asked).toHaveLength(0);
    expect(checks()[0]?.detail).toMatchObject({ outcome: "nothing new", fetched: 0 });
  });

  it("stops after the screen when it finds only noise, and remembers that it looked", async () => {
    const decide = fakeModel("sonnet", []);
    const out = await runCheck(deps([friendly], { screen: fakeModel("haiku", [{ pass: [], note: "a routine friendly" }]), decide }), "scheduled");
    expect(out.status).toBe("screened out");
    expect(decide.asked).toHaveLength(0);
    expect(store.read().notes[0]?.text).toMatch(/none worth a closer look/);
    expect(store.read().calls).toEqual([{ at: NOON.toISOString(), step: "screen", costUsd: 0.01 }]);
  });

  it("texts a new story through the door, opens a story card, and logs one entry with the cost", async () => {
    const screen = fakeModel("haiku", [{ pass: [1, 2], note: "" }]);
    const decide = fakeModel("sonnet", [
      {
        message: { text: "Since you follow Brann: they just signed striker Ola Nordmann from Molde.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing striker Ola Nordmann from Molde", status: "official" }] },
        keep: [{ headline: 2, why: "a friendly, nice to know" }],
        note: "Told: Brann signed Ola Nordmann (official). Kept the Spain friendly.",
      },
    ]);
    const out = await runCheck(deps([signing, friendly], { screen, decide }), "scheduled");
    expect(out.status).toBe("sent");
    expect(f.sent).toEqual([{ channel: "imessage", to: "+4791234567", text: "Since you follow Brann: they just signed striker Ola Nordmann from Molde." }]);
    const s = store.read();
    expect(s.stories).toHaveLength(1);
    expect(s.stories[0]).toMatchObject({ subject: "SK Brann", status: "official", links: ["https://n/sign"], updates: 0 });
    expect(s.later.map((l) => l.link)).toEqual(["https://n/friendly"]);
    expect(s.notes.at(-1)?.text).toContain("Ola Nordmann");
    // Step 2 saw the playbook, the picture of the owner and only the headlines step 1 passed.
    expect(decide.asked[0]!.system).toContain("# The one question");
    expect(decide.asked[0]!.user).toContain("Lifelong SK Brann supporter");
    expect(checks().at(-1)?.detail).toMatchObject({ outcome: "sent", costUsd: 0.02, screened: { in: 2, out: 2 } });
  });

  it("sends a real development as an update to its card", async () => {
    const card: StoryCard = { id: "c_aaaaaa", subject: "SK Brann", event: "talks with striker Ola Nordmann", status: "rumour, talks advanced", titles: ["Brann in talks with Ola Nordmann"], links: ["https://n/talks"], firstTold: NOON.toISOString(), lastTold: NOON.toISOString(), updates: 0 };
    store.update((s) => void s.stories.push(card));
    const decide = fakeModel("sonnet", [{ message: { text: "Update on Brann and Ola Nordmann: it's official now.", stories: [{ headline: 1, card: "c_aaaaaa", changed: "rumour became an official signing", status: "official" }] }, keep: [], note: "Update: Nordmann official." }]);
    await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide }), "scheduled");
    expect(decide.asked[0]!.user).toContain("c_aaaaaa | SK Brann | talks with striker Ola Nordmann | status: rumour, talks advanced");
    const updated = store.read().stories[0]!;
    expect(updated).toMatchObject({ status: "official", updates: 1, links: ["https://n/talks", "https://n/sign"] });
    expect(f.sent).toHaveLength(1);
  });

  describe("never the same story twice", () => {
    const told = (title: string, link: string): StoryCard => ({ id: "c_bbbbbb", subject: "SK Brann", event: "signing striker Ola Nordmann", status: "official", titles: [title], links: [link], firstTold: NOON.toISOString(), lastTold: NOON.toISOString(), updates: 0 });
    const asNew = { message: { text: "Brann signed Ola Nordmann!", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing Nordmann", status: "official" }] }, keep: [], note: "x" };

    it("refuses an article already told, asks once more, and sends nothing if it is still wrong", async () => {
      store.update((s) => void s.stories.push(told("Old title", "https://n/sign")));
      const decide = fakeModel("sonnet", [asNew, asNew]);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide }), "scheduled");
      expect(out.status).toBe("refused");
      expect(decide.asked).toHaveLength(2);
      expect(decide.asked[1]!.user).toMatch(/not accepted[\s\S]*exact article you already told them about \(card c_bbbbbb\)/);
      expect(f.sent).toHaveLength(0);
    });

    it("catches the same story reworded by another outlet, and lets the model fix it", async () => {
      store.update((s) => void s.stories.push(told("Brann signs striker Ola Nordmann from Molde FK", "https://n/other")));
      const nothing = { message: null, keep: [], note: "Same signing as c_bbbbbb, nothing new." };
      const decide = fakeModel("sonnet", [asNew, nothing]);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide }), "scheduled");
      expect(decide.asked[1]!.user).toMatch(/reads almost like the story on card c_bbbbbb/);
      expect(out.status).toBe("nothing to tell");
      expect(f.sent).toHaveLength(0);
    });

    it("does not mistake next week's result for last week's", async () => {
      store.update((s) => void s.stories.push(told("Brann won 2-1 against Molde", "https://n/w1")));
      const decide = fakeModel("sonnet", [{ message: { text: "Brann beat Viking 3-0.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "beat Viking 3-0", status: "final" }] }, keep: [], note: "x" }]);
      const out = await runCheck(deps([{ title: "Brann won 3-0 against Viking", link: "https://n/w2" }], { screen: fakeModel("haiku", [{ pass: [1] }]), decide }), "scheduled");
      expect(out.status).toBe("sent");
      expect(decide.asked).toHaveLength(1);
    });

    it("accepts a different event that reads alike when the model says how it differs, and logs the claim", async () => {
      store.update((s) => void s.stories.push(told("Brann signs striker Ola Nordmann from Molde", "https://n/a")));
      const distinct = { message: { text: "Brann signed another striker, Kari Nordmann.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing Kari Nordmann", status: "official", distinct: "a different player, Kari not Ola" }] }, keep: [], note: "x" };
      const out = await runCheck(deps([{ title: "Brann signs striker Kari Nordmann from Molde", link: "https://n/kari" }], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [distinct]) }), "scheduled");
      expect(out.status).toBe("sent");
      expect(checks().at(-1)?.detail.distinctClaims).toEqual(["a different player, Kari not Ola"]);
    });
  });

  describe("when a step fails", () => {
    it("Haiku down: everything goes on to Sonnet", async () => {
      const decide = fakeModel("sonnet", [{ message: null, keep: [], note: "nothing" }]);
      await runCheck(deps([signing, friendly], { screen: fakeModel("haiku", [new Error("overloaded")]), decide }), "scheduled");
      expect(decide.asked[0]!.user).toContain("Ola Nordmann");
      expect(decide.asked[0]!.user).toContain("friendly in Spain");
      expect(checks().at(-1)?.detail.screenFailed).toMatch(/overloaded/);
    });

    it("Sonnet down: nothing is sent, and the headlines wait for the next check", async () => {
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [new Error("529")]) }), "scheduled");
      expect(out.status).toBe("model failed");
      expect(f.sent).toHaveLength(0);
      expect(store.read().seen["l:https://n/sign"]).toBeUndefined();
      const again = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [{ message: null, keep: [], note: "ok" }]) }), "scheduled");
      expect(again.status).toBe("nothing to tell");
    });

    it("with step 2 switched off, step 1's model decides directly (Haiku only)", async () => {
      const haiku = fakeModel("haiku", [{ message: null, keep: [], note: "decided by haiku" }]);
      const out = await runCheck(deps([signing], { screen: haiku }), "scheduled");
      expect(out.status).toBe("nothing to tell");
      expect(haiku.asked).toHaveLength(1);
      expect(haiku.asked[0]!.system).toContain("# The one question");
    });
  });

  describe("fences", () => {
    const send = { message: { text: "news", stories: [{ headline: 1, card: "new", subject: "s", event: "e", status: "st" }] }, keep: [], note: "n" };

    it("holds a text past the daily limit, keeps the story, and flags the judgment as too loose", async () => {
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [send]), dailyTextLimit: 0 }), "scheduled");
      expect(out.status).toBe("held");
      expect(f.sent).toHaveLength(0);
      expect(store.read().later.map((l) => l.link)).toEqual(["https://n/sign"]);
      expect(f.audit.read({ kinds: ["policy"] }).some((e) => e.detail.watcher === "held" && e.detail.fault === true)).toBe(true);
    });

    it("stops calling models past the daily budget, without even fetching", async () => {
      store.update((s) => void s.calls.push({ at: NOON.toISOString(), step: "decide", costUsd: 0.01 }));
      const d = deps([signing], { screen: fakeModel("haiku", []), dailyModelCallLimit: 1 });
      expect((await runCheck(d, "scheduled")).status).toBe("budget");
      expect(d.urls).toEqual([]);
    });
  });

  it("answers in conversation without texting, and still counts the story as told", async () => {
    const decide = fakeModel("sonnet", [{ message: { text: "Brann signed Ola Nordmann.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing Nordmann", status: "official" }] }, keep: [], note: "x" }]);
    const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide }, new Date("2026-10-13T21:30:00Z")), "asked");
    expect(out).toMatchObject({ status: "to tell", text: "Brann signed Ola Nordmann." });
    expect(f.sent).toHaveLength(0);
    expect(store.read().stories).toHaveLength(1);
  });

  it("asks about interests once, a day after starting with none, and never again", async () => {
    store.update((s) => {
      s.searches = [];
      s.startedAt = new Date(NOON.getTime() - 25 * 3600_000).toISOString();
    });
    const first = await runCheck(deps([]), "scheduled");
    expect(first.status).toBe("asked interests");
    expect(f.sent.map((m) => m.text)).toEqual([INTERESTS_QUESTION]);
    expect((await runCheck(deps([]), "scheduled")).status).toBe("no searches");
    expect(f.sent).toHaveLength(1);
  });

  it("waits a day before asking, so the welcome conversation can ask first", async () => {
    store.update((s) => void (s.searches = []));
    expect((await runCheck(deps([]), "scheduled")).status).toBe("no searches");
    expect(f.sent).toHaveLength(0);
  });
});
