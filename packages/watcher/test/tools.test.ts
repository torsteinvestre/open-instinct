// [sunshine:watcher]
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegisteredTool } from "@open-instinct/core";
import type { ModelCall } from "../src/models.js";
import { WatchStore } from "../src/store.js";
import { WATCH_GATE, WATCH_PROMPT, createWatcher, type Watcher } from "../src/tools.js";
import { FRIEND, NOON, ctx, feeds, fixture, isError, publicLookup, textOf, type Fixture } from "./helpers.js";

let f: Fixture;
let w: Watcher;
let tools: Map<string, RegisteredTool["spec"]>;

const sonnet = (reply: Record<string, unknown>): ModelCall => async () => ({ text: JSON.stringify(reply), costUsd: 0.01, model: "sonnet" });

function build(extra: Partial<Parameters<typeof createWatcher>[0]> = {}) {
  w = createWatcher({ state: f.state, config: f.config, outbox: f.outbox as never, audit: f.audit, scheduler: f.scheduler, sieve: { name: "fake", relevance: async () => ({ p: 0.9, inputTokens: 10 }) }, lookup: publicLookup, now: () => NOON, ...extra });
  tools = new Map(w.tools.map((t) => [t.spec.name, t.spec]));
}
const run = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args as never, ctx(NOON));

beforeEach(() => {
  f = fixture();
  build();
});
afterEach(() => f.cleanup());

describe("the news watch in conversation", () => {
  it("has six tools, and every one refuses anyone but the owner", async () => {
    expect([...tools.keys()]).toEqual(["watch_profile", "watch_profile_update", "watch_check", "watch_journal", "watch_later", "watch_settings"]);
    for (const name of tools.keys()) {
      const r = await tools.get(name)!.execute({ profile: "x" } as never, ctx(NOON, FRIEND));
      expect(textOf(r), name).toMatch(/belongs to the owner/);
    }
  });

  it("saves the picture and precise searches; interests given in conversation count as the answer to the question", async () => {
    expect(isError(await run("watch_profile_update", { searches: [{ topic: "Brann", query: "SK Brann", edition: "norsk" }] }))).toBe(true);
    expect(isError(await run("watch_profile_update", { profile: "x".repeat(2001) }))).toBe(true);
    await run("watch_profile_update", { profile: "Lifelong Brann supporter in Bergen.", searches: [{ topic: "Brann, the Bergen football club (SK Brann)", query: "SK Brann", edition: "no-NO" }] });
    const shown = textOf(await run("watch_profile"));
    expect(shown).toContain("Lifelong Brann supporter in Bergen.");
    expect(shown).toContain('- Brann, the Bergen football club (SK Brann): "SK Brann" (no-NO)');
    expect(shown).toContain("Asked about interests: yes");
    expect(shown).toContain("Model cost: $0.000 today");
  });

  it("answers 'anything new?' by running a check whose result it says itself; nothing is texted", async () => {
    const { fetchImpl } = feeds({ "SK Brann": [{ title: "Brann signs Ola Nordmann", link: "https://n/1" }] });
    build({ fetchImpl, decide: sonnet({ message: { text: "Brann signed Ola Nordmann.", stories: [{ headline: 1, card: "new", subject: "SK Brann", event: "signing", status: "official" }] }, keep: [], note: "x" }) });
    await run("watch_profile_update", { searches: [{ topic: "Brann", query: "SK Brann", edition: "no-NO" }] });
    const out = textOf(await run("watch_check"));
    expect(out).toMatch(/Worth telling them[\s\S]*Brann signed Ola Nordmann\./);
    expect(f.sent).toHaveLength(0);
    expect(textOf(await run("watch_check"))).toMatch(/Nothing new worth telling/);
  });

  it("answers 'what did you skip?' from the journal, by stage", async () => {
    const { fetchImpl } = feeds({
      "SK Brann": [
        { title: "Brann signs Ola Nordmann", link: "https://n/1" },
        { title: "Brann friendly in Spain", link: "https://n/2" },
        { title: "Brann ticket office opening hours", link: "https://n/3" },
        { title: "House fire in Bergen", link: "https://n/4" },
      ],
    });
    const sieve = { name: "fake", relevance: async (_t: string, i: { title: string }) => ({ p: i.title.startsWith("House") ? 0.05 : 0.9, inputTokens: 10 }) };
    const screen: ModelCall = async () => ({ text: '{"pass": [1, 2]}', costUsd: 0.001, model: "haiku" });
    build({ fetchImpl, sieve, screen, decide: sonnet({ message: null, keep: [{ headline: 2, why: "nice to know" }], note: "Nothing big today." }) });
    await run("watch_profile_update", { searches: [{ topic: "Brann", query: "SK Brann", edition: "no-NO" }] });
    await run("watch_settings", { on: true });
    expect((await w.runCheck("scheduled")).status).toBe("nothing to tell");
    const out = textOf(await run("watch_journal"));
    expect(out).toMatch(/Kept for later: 1\n- \[Brann\] Brann friendly in Spain/);
    expect(out).toMatch(/not worth a text: 1\n- \[Brann\] Brann signs Ola Nordmann/);
    expect(out).toMatch(/first pass: 1\n- \[Brann\] Brann ticket office opening hours/);
    expect(out).toMatch(/off-topic: 1[\s\S]*House fire in Bergen \(relevance 0.05\)/);
    expect(out).toContain("Nothing big today.");
    expect(out).toContain("<untrusted");
  });

  it("lists kept stories once", async () => {
    new WatchStore(f.state, () => NOON).update((s) => void s.later.push({ at: NOON.toISOString(), title: "Brann friendly in Spain", link: "https://n/k" }));
    expect(textOf(await run("watch_later"))).toContain("Brann friendly in Spain");
    expect(textOf(await run("watch_later"))).toBe("Nothing kept for later.");
  });
});

describe("scheduling the checks", () => {
  it("starts on its own on first boot with one gated job, every two hours outside quiet hours in the owner's timezone", () => {
    w.ensureStarted();
    w.ensureStarted();
    const jobs = f.scheduler.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cron: "0 8,10,12,14,16,18,20 * * *", tz: "Europe/Oslo", gate: WATCH_GATE, toolRepliesOnly: true, prompt: WATCH_PROMPT, enabled: true });
  });

  it("follows the settings: interval and quiet hours move the job, off removes it, and a job deleted by hand comes back", async () => {
    w.ensureStarted();
    await run("watch_settings", { everyMinutes: 30, quietStart: "23:00", quietEnd: "07:00" });
    expect(f.scheduler.list().map((j) => j.cron)).toEqual(["0,30 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22 * * *"]);
    expect(isError(await run("watch_settings", { everyMinutes: 7 }))).toBe(true);
    await run("watch_settings", { on: false });
    expect(f.scheduler.list()).toEqual([]);
    await run("watch_settings", { on: true });
    f.scheduler.delete(f.scheduler.list()[0]!.id);
    await run("watch_settings", { on: true });
    expect(f.scheduler.list()).toHaveLength(1);
  });

  it("the gate runs a check in code and never wakes the agent", async () => {
    w.ensureStarted();
    expect(await w.gate(f.scheduler.list()[0]!)).toBe(false);
    expect(f.audit.read({ kinds: ["policy"] }).some((e) => e.detail.watcher === "check" && e.detail.outcome === "no searches")).toBe(true);
  });
});
