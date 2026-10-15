// [sunshine:watcher] One news check end to end, with fake feeds, a fake Jev and fake models.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECIDE_MAX, headlinesPerCheck, runCheck, type CheckDeps } from "../src/check.js";
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
    // The journal records each headline's fate, and which card the told one opened.
    const [entry] = store.readJournal(0);
    expect(entry).toMatchObject({ outcome: "sent", costUsd: 0.02 });
    expect(entry!.items.map((i) => [i.link, i.stage, i.result])).toEqual([
      ["https://n/sign", "decide", "told"],
      ["https://n/friendly", "decide", "kept"],
    ]);
    expect(entry!.items[0]!.card).toBe(s.stories[0]!.id);
  });

  it("journals what the sieve and the screen dropped, and keeps a week of it", async () => {
    const sieve: RelevanceSieve = { name: "fake", relevance: async (_t, i) => ({ p: i.title.includes("fire") ? 0.04 : 0.9, inputTokens: 10 }) };
    const fire = { title: "House fire in Bergen", link: "https://n/fire" };
    await runCheck(deps([signing, friendly, fire], { sieve, screen: fakeModel("haiku", [{ pass: [] }]), decide: fakeModel("sonnet", []) }), "scheduled");
    const items = store.readJournal(0)[0]!.items;
    expect(items.find((i) => i.link === "https://n/fire")).toMatchObject({ stage: "sieve", result: "dropped", p: 0.04 });
    expect(items.filter((i) => i.stage === "screen").map((i) => i.result)).toEqual(["dropped", "dropped"]);
    // A week later, the old line is pruned when the next one is written.
    const later = new WatchStore(f.state, () => new Date(NOON.getTime() + 8 * 24 * 3600_000));
    later.appendJournal({ at: new Date(NOON.getTime() + 8 * 24 * 3600_000).toISOString(), mode: "scheduled", outcome: "nothing new", items: [] });
    expect(later.readJournal(0).map((e) => e.outcome)).toEqual(["nothing new"]);
  });

  it("writes no journal line when there was nothing to look at", async () => {
    await runCheck(deps([]), "scheduled");
    expect(store.readJournal(0)).toEqual([]);
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

  // [sunshine:watcher] Step 3: the text is written as the agent, with what it knows and a search.
  describe("the writer", () => {
    const draft = { message: { text: "Since you follow Brann: they signed Ola Nordmann.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing Ola Nordmann", status: "official" }] }, keep: [], note: "Told the signing." };
    const context = () => ({ persona: "Dry wit. Short sentences.", memory: "Plays five-a-side on Thursdays.", thread: "[Tue 13 Oct, 11:00] Maria: off to the match tonight!" });
    const research = async (q: string) => `1. Brann confirm striker signing\n   Nordmann, 24, joins from Molde on a three-year deal. (query: ${q})`;

    it("sends the text it writes, having seen the persona, memory, thread, story and search", async () => {
      const write = fakeModel("writer", ["Brann just signed Ola Nordmann, a 24-year-old striker from Molde, on a three-year deal."], 0.004);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [draft]), write, writerContext: context, research }), "scheduled");
      expect(out.status).toBe("sent");
      expect(f.sent.map((m) => m.text)).toEqual(["Brann just signed Ola Nordmann, a 24-year-old striker from Molde, on a three-year deal."]);
      expect(write.asked[0]!.system).toContain("Dry wit. Short sentences.");
      expect(write.asked[0]!.system).toContain("Plays five-a-side on Thursdays.");
      expect(write.asked[0]!.system).toContain("Lifelong SK Brann supporter"); // the news picture
      expect(write.asked[0]!.user).toContain("off to the match tonight!");
      expect(write.asked[0]!.user).toContain("1. Brann signs striker Ola Nordmann from Molde (BT)");
      expect(write.asked[0]!.user).toContain("three-year deal. (query: Brann signs striker Ola Nordmann from Molde BT)");
      expect(store.read().calls.map((c) => c.step)).toEqual(["screen", "decide", "write"]); // counts towards the budget
      expect(store.read().stories).toHaveLength(1);
    });

    it("tells the writer when a story is an update, and what was told before", async () => {
      store.update((s) => void s.stories.push({ id: "c_aaaaaa", subject: "SK Brann", event: "talks with Ola Nordmann", status: "rumour", titles: ["t"], links: ["https://n/talks"], firstTold: NOON.toISOString(), lastTold: NOON.toISOString(), updates: 0 }));
      const update = { message: { text: "It's official.", stories: [{ headline: 1, card: "c_aaaaaa", changed: "official now", status: "official" }] }, keep: [], note: "x" };
      const write = fakeModel("writer", ["The Nordmann move is official now."]);
      await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [update]), write, writerContext: context }), "scheduled");
      expect(write.asked[0]!.user).toContain("An update: you already told them that SK Brann: talks with Ola Nordmann (rumour); say what changed.");
    });

    it("holds the text back when the writer says so, logs the reason, and tells nothing", async () => {
      const write = fakeModel("writer", ["NO_TEXT: the search shows this signing was announced on 15 September; old news re-posted."]);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [draft]), write, writerContext: context, research }), "scheduled");
      expect(out.status).toBe("writer held");
      expect(f.sent).toHaveLength(0);
      expect(store.read().stories).toHaveLength(0);
      expect(store.read().notes.at(-1)?.text).toMatch(/held it back while writing: the search shows this signing was announced on 15 September/);
      expect(checks().at(-1)?.detail).toMatchObject({ outcome: "writer held", writerHeld: "the search shows this signing was announced on 15 September; old news re-posted." });
      expect(store.readJournal(0)[0]!.items[0]).toMatchObject({ stage: "write", result: "dropped" });
    });

    it("falls back to the decision's own text when the writer fails or answers unusably, so nothing is lost", async () => {
      const failing = fakeModel("writer", [new Error("overloaded")]);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [draft]), write: failing, writerContext: context, research }), "scheduled");
      expect(out.status).toBe("sent");
      expect(f.sent.map((m) => m.text)).toEqual([draft.message.text]);
      expect(checks().at(-1)?.detail.writerFailed).toMatch(/overloaded/);
      const empty = fakeModel("writer", ["   "]);
      await runCheck(deps([{ title: "Brann won 3-0 against Viking", link: "https://n/w2" }], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [{ ...draft, message: { ...draft.message, text: "Brann beat Viking 3-0." } }]), write: empty, writerContext: context }), "scheduled");
      expect(f.sent.at(-1)?.text).toBe("Brann beat Viking 3-0.");
    });

    it("writes from the headline when the search fails", async () => {
      const write = fakeModel("writer", ["Brann signed Ola Nordmann from Molde."]);
      await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [draft]), write, writerContext: context, research: async () => { throw new Error("blocked"); } }), "scheduled");
      expect(write.asked[0]!.user).toContain('The search for "Brann signs striker Ola Nordmann from Molde" failed; write from the headline.');
      expect(f.sent.map((m) => m.text)).toEqual(["Brann signed Ola Nordmann from Molde."]);
    });

    it("is not used when the owner asks for news in conversation: the agent says it in its own reply", async () => {
      const write = fakeModel("writer", []);
      const out = await runCheck(deps([signing], { screen: fakeModel("haiku", [{ pass: [1] }]), decide: fakeModel("sonnet", [draft]), write, writerContext: context }), "asked");
      expect(out).toMatchObject({ status: "to tell", text: draft.message.text });
      expect(write.asked).toHaveLength(0);
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

// [sunshine:watcher] Checks every two hours take on two hours' worth of headlines, and with the
// screen off (the default since 2026-10-15) step 2 reads every one of them (2026-10-15).
describe("how many headlines a check takes on", () => {
  const many = (q: string) => Array.from({ length: 35 }, (_, i) => ({ title: `${q} story number ${i + 1}`, link: `https://n/${q}/${i}`, hoursAgo: 1 }));
  const nothing = () => ({ message: null, keep: [], note: "nothing" });
  const listed = (user: string) => user.split("\n").filter((l) => /^\d+\. \[/.test(l)).map((l) => l.replace(/^\d+\. /, ""));
  function twoSearches(everyMinutes: number): CheckDeps {
    store.update((s) => {
      s.searches = [
        { topic: "Brann", query: "SK Brann", edition: "no-NO" },
        { topic: "Bergen", query: "Bergen", edition: "no-NO" },
      ];
      s.everyMinutes = everyMinutes;
    });
    const { fetchImpl } = feeds({ "SK Brann": many("brann"), Bergen: many("bergen") });
    return { ...deps([]), fetchImpl };
  }
  function threeSearches(everyMinutes: number): CheckDeps {
    store.update((s) => {
      s.searches = ["Brann", "Bergen", "Vestland"].map((q) => ({ topic: q, query: q, edition: "no-NO" }));
      s.everyMinutes = everyMinutes;
    });
    const { fetchImpl } = feeds({ Brann: many("brann"), Bergen: many("bergen"), Vestland: many("vestland") });
    return { ...deps([]), fetchImpl };
  }

  it("is an hour's worth for every hour between checks, at least one hour's, at most DECIDE_MAX", () => {
    expect([15, 30, 60, 120, 180].map(headlinesPerCheck)).toEqual([30, 30, 30, 60, 60]);
    expect(DECIDE_MAX).toBe(60);
  });

  it("every two hours, step 2 reads 60 headlines with no screen in between", async () => {
    const decide = fakeModel("sonnet", [nothing()]);
    await runCheck({ ...twoSearches(120), decide }, "scheduled");
    expect(listed(decide.asked[0]!.user)).toHaveLength(60);
  });

  it("the ones that did not fit come up in the next check", async () => {
    const decide = fakeModel("sonnet", [nothing(), nothing()]);
    const d = threeSearches(120);
    await runCheck({ ...d, decide }, "scheduled");
    await runCheck({ ...d, decide }, "scheduled");
    const [first, second] = decide.asked.map((a) => listed(a.user));
    expect(first).toHaveLength(60);
    expect(second!.length).toBeGreaterThan(0);
    expect(second!.filter((h) => first!.includes(h))).toEqual([]);
  });

  // [sunshine:watcher] Faster than every two hours is no longer offered (2026-10-15).
  it("treats an older hourly setting as every two hours", async () => {
    const decide = fakeModel("sonnet", [nothing()]);
    await runCheck({ ...twoSearches(60), decide }, "scheduled");
    expect(store.read().everyMinutes).toBe(120);
    expect(listed(decide.asked[0]!.user)).toHaveLength(60);
  });
});
