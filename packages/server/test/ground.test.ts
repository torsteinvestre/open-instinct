// [sunshine:grounding] The grounding step: what the small model is told and asked, nothing gathered for a greeting,
// recall and the look-up run on what it wrote, and what the agent gets.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, MemoryStore, StateDir, defaultConfig } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { GROUND_SCHEMA, createGround, groundSystem, parseGround } from "../src/ground.js";
import type { LookUpAsk } from "../src/lookup.js";

const NOW = new Date("2026-10-29T10:41:00Z"); // Thu 29 Oct, 11:41 in Oslo
const answer = (j: unknown) => JSON.stringify(j);
const WEEK = { needed: true, about: ["Torstein's plans and events next week"], days: ["2026-11-02/2026-11-08"], searches: ["(guestlist OR registered OR tickets OR invitation) newer_than:60d"] };

function setup(replies: string[], extra: { recall?: (q: string[], o?: { chatsBefore?: number }) => Promise<string | undefined>; lookUp?: (a: LookUpAsk) => Promise<string | undefined> } = {}) {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "ground-")));
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const memory = new MemoryStore(state);
  memory.replaceDurable("## About\n- Lives in Oslo; builds Sunshine.\n");
  const audit = new AuditLog(state);
  const asked: Array<{ system: string; user: string; schema?: unknown }> = [];
  const call = (async ({ system, user, schema }) => {
    asked.push({ system, user, schema });
    return { text: replies.shift() ?? "", costUsd: 0.001, model: "haiku" };
  }) as ModelCall;
  const ground = createGround({ call, config, memory, audit, now: () => NOW, ...extra });
  const grounded = () => audit.read().map((e) => e.detail).filter((d) => d && "grounding" in d).map((d) => (d as { grounding: Record<string, unknown> }).grounding);
  return { ground, asked, grounded };
}
const input = (text: string) => ({ text, recent: [{ who: "owner" as const, text: "[Wed 28 Oct 2026, 10:38 Europe/Oslo, UTC+01:00]\nDoes ripple want banks to use xrp" }, { who: "agent" as const, text: "Both, but they do different jobs." }], conversationKey: "imessage:c1" });

describe("grounding", () => {
  it("asks the small model what the message concerns, with now, the notes and the latest texts", async () => {
    const { ground, asked } = setup([answer({ needed: false })]);
    await ground(input("Anything happening next week for me"));
    expect(asked[0]!.system).toBe(groundSystem("Torstein"));
    expect(asked[0]!.schema).toBe(GROUND_SCHEMA); // [sunshine:fixed-form]
    expect(asked[0]!.system).toContain("worked out from now, as YYYY-MM-DD");
    expect(asked[0]!.user).toContain("Now: Thu, 29 Oct 2026, 11:41 Europe/Oslo (2026-10-29).");
    expect(asked[0]!.user).toContain("- Lives in Oslo; builds Sunshine.");
    expect(asked[0]!.user).toContain("Torstein: [Wed 28 Oct 2026, 10:38 Europe/Oslo, UTC+01:00] Does ripple want banks to use xrp\nAssistant: Both, but they do different jobs.");
    expect(asked[0]!.user).toMatch(/Torstein's new message: Anything happening next week for me$/);
  });

  it("hands over nothing for a greeting or a general question, or when the answer cannot be read", async () => {
    let recalled = 0;
    let looked = 0;
    for (const reply of [answer({ needed: false, about: [], days: [], searches: [] }), answer({ needed: true, about: [], days: [], searches: [] }), "no tags"]) {
      const { ground, grounded } = setup([reply], { recall: async () => (recalled++, undefined), lookUp: async () => (looked++, "x") });
      expect(await ground(input("thanks!"))).toBeUndefined();
      expect(grounded()[0]!.outcome).toMatch(/nothing needed|unreadable/);
    }
    // Only the recall on the message itself (local, before the small model decides); no email or calendar read.
    expect(recalled).toBe(3);
    expect(looked).toBe(0);
  });

  it("runs recall and the look-up on what it wrote and hands the agent both, as data", async () => {
    const recalls: Array<{ q: string[]; chatsBefore?: number }> = [];
    const lookUps: LookUpAsk[] = [];
    const { ground, grounded } = setup([answer(WEEK)], {
      recall: async (q, o) => (recalls.push({ q, ...(o?.chatsBefore ? { chatsBefore: o.chatsBefore } : {}) }), "[Tue, 27 Oct 2026] Project update (recorded on their phone)\n  I got an event which I think is at the third of November"),
      lookUp: async (a) => (lookUps.push(a), "Email, searched for (guestlist OR registered OR tickets OR invitation) newer_than:60d:\n- Sat, 17 Oct 2026, from Google Events: You're on the guestlist for Founders Story Oslo\nCalendar, Mon, 2 Nov 2026 to Sun, 8 Nov 2026: nothing in the calendar."),
    });
    const text = (await ground(input("Anything happening next week for me")))!;
    // Recall on the message first (the small model plans its searches knowing it), then on what it concerns and the
    // days; the last day of chat left out (in the thread already).
    const chatsBefore = NOW.getTime() - 24 * 60 * 60 * 1000;
    expect(recalls).toEqual([
      { q: ["Anything happening next week for me"], chatsBefore },
      { q: ["Anything happening next week for me", ...WEEK.about, ...WEEK.days], chatsBefore },
    ]);
    expect(lookUps).toEqual([{ searches: WEEK.searches, days: WEEK.days }]);
    expect(text).toMatch(/^\[Not a message from Torstein: what Sunshine's own code gathered for the message above, before you answer it\./);
    expect(text).toContain('What you already know that may bear on it (earlier conversations and kept items, best first; dated, so things may have changed since):\n<untrusted source="what you already know">\n[Tue, 27 Oct 2026] Project update');
    expect(text).toContain("What Torstein's email and calendar show for it, looked up just now:\n<untrusted source=\"email and calendar\">\nEmail, searched for");
    expect(text).toContain("Founders Story Oslo");
    expect(grounded()[0]).toMatchObject({ outcome: "grounded", about: 1, days: 1, searches: 1, known: "found", live: "shown", costUsd: 0.001 });
  });

  it("shows the small model what is kept about the message before it plans the searches", async () => {
    const { ground, asked } = setup([answer({ needed: false })], { recall: async () => "[Tue, 27 Oct 2026] Project update\n  I got an event which I think is at the third of November" });
    await ground(input("Anything happening next week for me"));
    expect(asked[0]!.user).toContain('What the assistant has kept that may bear on the new message (earlier conversations and recordings, dated):\n<untrusted source="what the assistant has kept">\n[Tue, 27 Oct 2026] Project update');
    expect(asked[0]!.system).toContain("Anything the assistant knows of only in part (an event without its time or place");
    expect(asked[0]!.system).toContain("not by when an event takes place");
  });

  it("says when nothing kept bears on it, and goes on when a source fails", async () => {
    const quiet = setup([answer(WEEK)], { recall: async () => undefined, lookUp: async () => { throw new Error("composio down"); } });
    expect(await quiet.ground(input("Anything happening next week for me"))).toContain("Nothing you have kept seems to bear on it.");
    const none = setup([answer(WEEK)]);
    expect(await none.ground(input("Anything happening next week for me"))).toBeUndefined();
  });

  it("reads the answer's lists leniently", () => {
    expect(parseGround(answer({ needed: true, about: [" plans ", 3, ""], days: ["2026-11-02"], searches: "x" }))).toEqual({ needed: true, about: ["plans"], days: ["2026-11-02"], searches: [] });
    expect(parseGround(answer({ about: ["plans"] }))!.needed).toBe(true);
    expect(parseGround("{not json")).toBeUndefined();
    expect(parseGround("null")).toBeUndefined();
  });

  // [sunshine:fixed-form] The form makes an unreadable answer rare (a refusal); no second try.
  it("asks once and logs how an unreadable answer began", async () => {
    const never = setup(["I can't help with that."]);
    expect(await never.ground(input("Anything happening next week for me"))).toBeUndefined();
    expect(never.asked).toHaveLength(1);
    expect(never.grounded()[0]).toMatchObject({ outcome: "unreadable", start: "I can't help with that.", costUsd: 0.001 });
  });
});
