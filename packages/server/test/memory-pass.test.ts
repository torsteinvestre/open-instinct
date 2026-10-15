// [sunshine:memory] The nightly memory notes, with a stand-in model: when they run, what they read,
// what they write, and what they refuse.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, MemoryStore, Scheduler, StateDir, defaultConfig, writeSession } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { MEMORY_GATE, MEMORY_MAX_CHARS, MEMORY_PASS_CRON, createMemoryPass, parseNotes } from "../src/memory-pass.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-16T01:30:00Z"); // 03:30 in Oslo
const at = (iso: string) => Date.parse(iso);
const user = (text: string, ts: number) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts }) as never;
const asst = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: ts }) as never;

function fakeModel(replies: Array<string | Error>): ModelCall & { asked: Array<{ system: string; user: string }> } {
  const asked: Array<{ system: string; user: string }> = [];
  const call = (async ({ system, user: u }) => {
    asked.push({ system, user: u });
    const r = replies.shift();
    if (r === undefined) throw new Error("no reply queued");
    if (r instanceof Error) throw r;
    return { text: r, costUsd: 0.02, model: "sonnet" };
  }) as ModelCall & { asked: typeof asked };
  call.asked = asked;
  return call;
}

function setup(call?: ModelCall, now: () => Date = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), "memory-pass-"));
  dirs.push(dir);
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  const memory = new MemoryStore(state);
  const scheduler = new Scheduler(state, { now });
  const audit = new AuditLog(state);
  const pass = createMemoryPass({ state, memory, config, scheduler, audit, now, ...(call ? { call } : {}) });
  const thread = (messages: unknown[]) => {
    state.writeJson("owner-route.json", { conversationKey: "imessage:c1", channel: "imessage" });
    writeSession(join(state.path("sessions"), `${encodeURIComponent("imessage:c1")}.jsonl`), messages as never);
  };
  return { state, memory, scheduler, audit, pass, thread, dir };
}

const DAY = [
  user("[Thu 15 Oct 2026, 10:47 Europe/Oslo, UTC+02:00]\nI have a fund, what should be considered in the fund vs apartment", at("2026-10-15T08:47:00Z")),
  asst("Biggest thing is the loan...", at("2026-10-15T08:47:10Z")),
  user("[Thu 15 Oct 2026, 10:52 Europe/Oslo, UTC+02:00]\nAbout 1,5 million NOK and yeah aksjesparekonto", at("2026-10-15T08:52:00Z")),
  asst("Good, tax-wise the ASK is an advantage.", at("2026-10-15T08:52:10Z")),
];
const NEW_NOTES = "# Memory\n## About Torstein\nLives in Oslo.\nHas a fund of about NOK 1.5M in an aksjesparekonto (Oct 2026).\n## Lately\nThinking about buying an apartment in Oslo.";

describe("the nightly memory notes", () => {
  it("make no model call when the owner has not texted since the last time", async () => {
    const call = fakeModel([]);
    const { pass, thread } = setup(call);
    expect(await pass.run()).toBe("nothing new"); // no thread yet
    thread([asst("Time to stretch.", at("2026-10-15T09:00:00Z"))]);
    expect(await pass.run()).toBe("nothing new"); // only Sunshine spoke
    expect(call.asked).toHaveLength(0);
  });

  it("write the notes from the conversation, keep a backup, and never read the same messages twice", async () => {
    const call = fakeModel([`Here you go.\n<memory>\n${NEW_NOTES}\n</memory>`]);
    const { pass, thread, memory, state, audit } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("updated");
    expect(memory.readDurable()).toBe(NEW_NOTES + "\n");
    // What the model read: the old notes and the conversation as plain lines, stamps dropped.
    expect(call.asked[0]!.system).toContain("what a good friend would remember");
    expect(call.asked[0]!.user).toContain("Today is Friday, 16 October 2026.");
    expect(call.asked[0]!.user).toContain("<notes>\n# Memory\nLives in Oslo.");
    expect(call.asked[0]!.user).toContain("[Thu 15 Oct, 10:52] Torstein: About 1,5 million NOK and yeah aksjesparekonto");
    expect(call.asked[0]!.user).toContain("Sunshine: Good, tax-wise the ASK is an advantage.");
    expect(call.asked[0]!.user).not.toContain("Europe/Oslo, UTC");
    const backups = readdirSync(state.path("memory/backups"));
    expect(backups).toHaveLength(1);
    expect(state.readText(`memory/backups/${backups[0]}`)).toBe("# Memory\nLives in Oslo.\n");
    expect(state.readJson<{ lastPassAt?: number }>("memory-pass.json", {}).lastPassAt).toBe(at("2026-10-15T08:52:10Z"));
    expect(audit.read({ kinds: ["policy"] }).at(-1)!.detail).toMatchObject({ memoryPass: "updated", costUsd: 0.02 });
    // The next night, nothing new: no call.
    expect(await pass.run()).toBe("nothing new");
    expect(call.asked).toHaveLength(1);
  });

  it("leave the notes alone on NO_CHANGE, and move on", async () => {
    const call = fakeModel(["NO_CHANGE"]);
    const { pass, thread, memory } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("no change");
    expect(memory.readDurable()).toBe("# Memory\nLives in Oslo.\n");
    expect(await pass.run()).toBe("nothing new");
  });

  it("send a file over the limit back once with the reason; still too long, the old notes stay and the day is read again", async () => {
    const long = `<memory>\n# Memory\n${"x".repeat(MEMORY_MAX_CHARS + 10)}\n</memory>`;
    const call = fakeModel([long, long]);
    const { pass, thread, memory, state } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("too long");
    expect(call.asked[1]!.user).toContain(`it must stay under ${MEMORY_MAX_CHARS}`);
    expect(memory.readDurable()).toBe("# Memory\nLives in Oslo.\n");
    expect(state.readJson<{ lastPassAt?: number }>("memory-pass.json", {}).lastPassAt).toBeUndefined();
  });

  it("refuse a rewrite that drops most of a long file", async () => {
    const call = fakeModel(["<memory>\n# Memory\nLives in Oslo.\n</memory>"]);
    const { pass, thread, memory } = setup(call);
    const long = "# Memory\n" + Array.from({ length: 40 }, (_, i) => `Fact number ${i} about Torstein.`).join("\n");
    memory.replaceDurable(long);
    thread(DAY);
    expect(await pass.run()).toBe("dropped too much");
    expect(memory.readDurable()).toBe(long + "\n");
  });

  it("read the shortened part too when the conversation was trimmed since the last time", async () => {
    const call = fakeModel(["NO_CHANGE"]);
    const { pass, thread } = setup(call);
    thread([user("[Conversation summary] 30 earlier messages were trimmed to save space. Highlights, oldest first:\n- user: [Thu 15 Oct, 08:10] got tickets to J. Cole in November", at("2026-10-15T09:00:00Z")), ...DAY]);
    await pass.run();
    expect(call.asked[0]!.user).toContain("Shortened earlier part of the conversation:");
    expect(call.asked[0]!.user).toContain("got tickets to J. Cole in November");
  });

  it("keep everything when the model fails, and say so", async () => {
    const call = fakeModel([new Error("credit balance too low")]);
    const { pass, thread, memory, state } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("failed");
    expect(memory.readDurable()).toBe("# Memory\nLives in Oslo.\n");
    expect(state.readJson<{ lastPassAt?: number }>("memory-pass.json", {}).lastPassAt).toBeUndefined();
  });

  it("keep the last seven backups", async () => {
    const replies = Array.from({ length: 9 }, (_, i) => `<memory>\n# Memory\nVersion ${i}\n</memory>`);
    let night = 0;
    const { pass, thread, memory, state } = setup(fakeModel(replies), () => new Date(NOW.getTime() + night * 86_400_000));
    memory.replaceDurable("# Memory\nStart");
    const msgs: unknown[] = [];
    for (night = 0; night < 9; night++) {
      msgs.push(user(`message ${night}`, at("2026-10-15T08:00:00Z") + night * 86_400_000));
      thread(msgs);
      expect(await pass.run()).toBe("updated");
    }
    const backups = readdirSync(state.path("memory/backups")).sort();
    expect(backups).toHaveLength(7);
    expect(state.readText(`memory/backups/${backups.at(-1)}`)).toContain("Version 7"); // the one before the last
    expect(memory.readDurable()).toContain("Version 8");
  });
});

describe("the memory notes job", () => {
  it("is one gated job at 03:30 in the owner's timezone, created once, gone when the notes are off", async () => {
    const { pass, scheduler, state, memory, audit } = setup(fakeModel([]));
    pass.ensureStarted();
    pass.ensureStarted();
    const jobs = scheduler.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cron: MEMORY_PASS_CRON, tz: "Europe/Oslo", gate: MEMORY_GATE, toolRepliesOnly: true, enabled: true });
    expect(await pass.gate()).toBe(false); // never wakes the agent
    const config = defaultConfig();
    config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
    createMemoryPass({ state, memory, config, scheduler, audit, now: () => NOW }).ensureStarted();
    expect(scheduler.list()).toHaveLength(0);
  });
});

describe("reading the model's answer", () => {
  it("takes the file between the tags, or NO_CHANGE, and nothing else", () => {
    expect(parseNotes("NO_CHANGE")).toEqual({ noChange: true });
    expect(parseNotes(" no_change \n")).toEqual({ noChange: true });
    expect(parseNotes("ok <memory>\n# Memory\nA\n</memory> done")).toEqual({ notes: "# Memory\nA" });
    expect(parseNotes("# Memory\nA")).toBeUndefined();
    expect(parseNotes("<memory>   </memory>")).toBeUndefined();
  });
});
