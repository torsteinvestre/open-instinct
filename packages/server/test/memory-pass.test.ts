// [sunshine:memory] The nightly memory notes, with a stand-in model: when they run, what they read,
// what they write, and what they refuse.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, HistoryArchive, MemoryStore, Scheduler, StateDir, defaultConfig, writeSession } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { MEMORY_GATE, MEMORY_MAX_CHARS, MEMORY_PASS_CRON, createMemoryPass } from "../src/memory-pass.js";
import { LABELS_FILE, readNotes, renderNotes, saveLabels, type Note } from "../src/memory-notes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-16T01:30:00Z"); // 03:30 in Oslo
const at = (iso: string) => Date.parse(iso);
const user = (text: string, ts: number) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts }) as never;
const asst = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: ts }) as never;
const toolUse = (name: string, ts: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `t${ts}`, name, arguments: {} }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: ts }) as never;
const toolResult = (name: string, ts: number) => ({ role: "toolResult", toolCallId: `t${ts - 1}`, toolName: name, content: [{ type: "text", text: "..." }], isError: false, timestamp: ts }) as never;
const answer = (changes: unknown[]) => `<changes>${JSON.stringify({ changes })}</changes>`;

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

function setup(call?: ModelCall, now: () => Date = () => NOW, opts: { history?: boolean } = {}) {
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
  const history = opts.history ? new HistoryArchive(state, { now }) : undefined; // [sunshine:history]
  const pass = createMemoryPass({ state, memory, config, scheduler, audit, now, ...(call ? { call } : {}), ...(history ? { history } : {}) });
  const thread = (messages: unknown[]) => {
    state.writeJson("owner-route.json", { conversationKey: "imessage:c1", channel: "imessage" });
    writeSession(join(state.path("sessions"), `${encodeURIComponent("imessage:c1")}.jsonl`), messages as never);
  };
  /** Notes already written and labelled by an earlier night. */
  const labelled = (notes: Note[]) => {
    memory.replaceDurable(renderNotes(notes, "Torstein"));
    saveLabels(state, notes);
  };
  return { state, memory, scheduler, audit, pass, thread, dir, history, labelled };
}

const DAY = [
  user("[Thu 15 Oct 2026, 10:47 Europe/Oslo, UTC+02:00]\nI have a fund, what should be considered in the fund vs apartment", at("2026-10-15T08:47:00Z")),
  asst("Biggest thing is the loan...", at("2026-10-15T08:47:10Z")),
  user("[Thu 15 Oct 2026, 10:52 Europe/Oslo, UTC+02:00]\nAbout 1,5 million NOK and yeah aksjesparekonto", at("2026-10-15T08:52:00Z")),
  asst("Good, tax-wise the ASK is an advantage.", at("2026-10-15T08:52:10Z")),
];
const OSLO: Note = { text: "Lives in Oslo.", kind: "lasting", source: "said" };

describe("the nightly memory notes", () => {
  it("make no model call when the owner has not texted since the last time", async () => {
    const call = fakeModel([]);
    const { pass, thread } = setup(call);
    expect(await pass.run()).toBe("nothing new"); // no thread yet
    thread([asst("Time to stretch.", at("2026-10-15T09:00:00Z"))]);
    expect(await pass.run()).toBe("nothing new"); // only Sunshine spoke
    expect(call.asked).toHaveLength(0);
  });

  it("apply the model's changes to the notes, keep a backup and the labels, and never read the same messages twice", async () => {
    const call = fakeModel([
      answer([
        { id: "n1", kind: "lasting", source: "said" },
        { text: "Has about NOK 1.5M in an aksjesparekonto (Oct 2026)", kind: "lasting", source: "said" },
        { text: "Weighing an apartment in Oslo against keeping the fund", kind: "current", source: "said" },
      ]),
    ]);
    const { pass, thread, memory, state, audit } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("updated");
    expect(memory.readDurable()).toBe(
      "# Memory\n\n## About Torstein\n- Lives in Oslo.\n- Has about NOK 1.5M in an aksjesparekonto (Oct 2026)\n\n## Lately\n- Weighing an apartment in Oslo against keeping the fund\n",
    );
    // What the model read: the notes with ids and labels, the conversation as plain lines, stamps dropped.
    expect(call.asked[0]!.system).toContain("what a good friend would remember");
    expect(call.asked[0]!.user).toContain("Today is Friday, 16 October 2026 (2026-10-16).");
    expect(call.asked[0]!.user).toContain("<notes>\nn1 [unlabeled, under About Torstein] Lives in Oslo.\n</notes>");
    expect(call.asked[0]!.user).toContain("[Thu 15 Oct, 10:52] Torstein: About 1,5 million NOK and yeah aksjesparekonto");
    expect(call.asked[0]!.user).toContain("Sunshine: Good, tax-wise the ASK is an advantage.");
    expect(call.asked[0]!.user).not.toContain("Europe/Oslo, UTC");
    // The labels go with the file, so the next night sees them; the current note is dated today.
    expect(readNotes(memory.readDurable(), state).map((n) => [n.kind, n.date, n.unlabeled ?? false])).toEqual([["lasting", undefined, false], ["lasting", undefined, false], ["current", "2026-10-16", false]]);
    expect(state.readJson<Record<string, unknown>>(LABELS_FILE, {})).not.toEqual({});
    const backups = readdirSync(state.path("memory/backups"));
    expect(backups).toHaveLength(1);
    expect(state.readText(`memory/backups/${backups[0]}`)).toBe("# Memory\nLives in Oslo.\n");
    expect(state.readJson<{ lastPassAt?: number }>("memory-pass.json", {}).lastPassAt).toBe(at("2026-10-15T08:52:10Z"));
    expect(audit.read({ kinds: ["policy"] }).at(-1)!.detail).toMatchObject({ memoryPass: "updated", costUsd: 0.02, added: 2, updated: 1, removed: 0, dropped: 0 });
    // The next night, nothing new: no call.
    expect(await pass.run()).toBe("nothing new");
    expect(call.asked).toHaveLength(1);
  });

  it("mark the replies that came from reading email or the web, and log what was kept out and why", async () => {
    const call = fakeModel([
      answer([
        { text: "Inbox has a Helsenorge prescription message", kind: "current", source: "read", private: true },
        { text: "Dentist on Thursday; wants it moved", kind: "current", source: "read", taken_up: true },
      ]),
    ]);
    const { pass, thread, memory, audit, labelled } = setup(call);
    labelled([OSLO]);
    thread([
      user("check my inbox", at("2026-10-15T08:00:00Z")),
      toolUse("app_composio_multi_execute_tool", at("2026-10-15T08:00:02Z")),
      toolResult("app_composio_multi_execute_tool", at("2026-10-15T08:00:03Z")),
      asst("Two new: Helsenorge says your prescription is ready, and the dentist reminds you of Thursday.", at("2026-10-15T08:00:05Z")),
      user("ugh, move the dentist to next week", at("2026-10-15T08:01:00Z")),
      asst("Which day suits you?", at("2026-10-15T08:01:05Z")),
    ]);
    expect(await pass.run()).toBe("updated");
    expect(call.asked[0]!.user).toContain("Sunshine (after reading email or calendar): Two new: Helsenorge says");
    expect(call.asked[0]!.user).toContain("Sunshine: Which day suits you?"); // a reply after no tool is not marked
    expect(memory.readDurable()).toContain("- Dentist on Thursday; wants it moved");
    expect(memory.readDurable()).not.toContain("Helsenorge");
    expect(audit.read({ kinds: ["policy"] }).find((e) => e.detail["memoryChanges"])?.detail["memoryChanges"]).toEqual(['kept out "Inbox has a Helsenorge prescription message": read by the agent, not taken up']);
  });

  it("send a broken answer back once with what is wrong, and use the second one", async () => {
    const call = fakeModel([answer([{ id: "n7", remove: "?" }, { text: "Has a dog" }]), answer([{ id: "n1", kind: "lasting", source: "said" }, { text: "Has a dog named Kaja", kind: "lasting", source: "said" }])]);
    const { pass, thread, memory } = setup(call);
    memory.replaceDurable("# Memory\nLives in Oslo.");
    thread(DAY);
    expect(await pass.run()).toBe("updated");
    expect(call.asked[1]!.user).toContain("# Your previous answer was not accepted\nn7 is not a note\na new note needs kind and source");
    expect(call.asked[1]!.user).toContain("n1 is unlabeled: give it labels or remove it");
    expect(memory.readDurable()).toContain("- Has a dog named Kaja");
  });

  it("leave the notes alone when nothing changes, and move on", async () => {
    const call = fakeModel([answer([])]);
    const { pass, thread, memory, labelled } = setup(call);
    labelled([OSLO]);
    const before = memory.readDurable();
    thread(DAY);
    expect(await pass.run()).toBe("no change");
    expect(memory.readDurable()).toBe(before);
    expect(await pass.run()).toBe("nothing new");
  });

  it("send notes over the limit back once with the reason; still too long, the old notes stay and the day is read again", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ text: `Fact ${i} ${"x".repeat(200)}`, kind: "lasting", source: "said" }));
    const call = fakeModel([answer(many), answer(many)]);
    const { pass, thread, memory, state, labelled } = setup(call);
    labelled([OSLO]);
    const before = memory.readDurable();
    thread(DAY);
    expect(await pass.run()).toBe("too long");
    expect(call.asked[1]!.user).toContain(`they must stay under ${MEMORY_MAX_CHARS}`);
    expect(memory.readDurable()).toBe(before);
    expect(state.readJson<{ lastPassAt?: number }>("memory-pass.json", {}).lastPassAt).toBeUndefined();
  });

  it("refuse a night that would remove most of the notes", async () => {
    const facts: Note[] = Array.from({ length: 40 }, (_, i) => ({ text: `Fact number ${i} about Torstein.`, kind: "lasting", source: "said" }));
    const call = fakeModel([answer(Array.from({ length: 30 }, (_, i) => ({ id: `n${i + 1}`, remove: "tidy" })))]);
    const { pass, thread, memory, labelled } = setup(call);
    labelled(facts);
    const before = memory.readDurable();
    thread(DAY);
    expect(await pass.run()).toBe("dropped too much");
    expect(memory.readDurable()).toBe(before);
  });

  it("read the shortened part too when the conversation was trimmed since the last time", async () => {
    const call = fakeModel([answer([])]);
    const { pass, thread } = setup(call);
    thread([user("[Conversation summary] 30 earlier messages were trimmed to save space. Highlights, oldest first:\n- user: [Thu 15 Oct, 08:10] got tickets to J. Cole in November", at("2026-10-15T09:00:00Z")), ...DAY]);
    await pass.run();
    expect(call.asked[0]!.user).toContain("Shortened earlier part of the conversation:");
    expect(call.asked[0]!.user).toContain("got tickets to J. Cole in November");
  });

  // [sunshine:history] With the kept history the notes read whole messages, also the ones a trim removed.
  it("read whole messages from the kept history, not the trim's highlights, each message once, with what replies read", async () => {
    const call = fakeModel([answer([])]);
    const { pass, thread, history } = setup(call, () => NOW, { history: true });
    const early = [
      user("[Thu 15 Oct 2026, 08:10 Europe/Oslo, UTC+02:00]\ngot tickets to J. Cole in November, the 14th, with Martin", at("2026-10-15T06:10:00Z")),
      toolUse("web_search", at("2026-10-15T06:10:02Z")),
      toolResult("web_search", at("2026-10-15T06:10:03Z")),
      asst("Nice, it's at Oslo Spektrum.", at("2026-10-15T06:10:05Z")),
    ];
    history!.record("imessage:c1", [...early, ...DAY]);
    thread([user("[Conversation summary] 2 earlier messages were trimmed to save space. Highlights, oldest first:\n- user: [Thu 15 Oct, 08:10] got tickets to J. Cole in Nov", at("2026-10-15T09:00:00Z")), ...DAY]);
    await pass.run();
    const read = call.asked[0]!.user;
    expect(read).toContain("Torstein: got tickets to J. Cole in November, the 14th, with Martin");
    expect(read).toContain("Sunshine (after reading the web): Nice, it's at Oslo Spektrum.");
    expect(read).not.toContain("Shortened earlier part of the conversation:");
    expect(read.split("About 1,5 million NOK").length - 1).toBe(1);
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
    const replies = Array.from({ length: 9 }, (_, i) => answer([{ text: `Version ${i}`, kind: "lasting", source: "said" }]));
    let night = 0;
    const { pass, thread, memory, state } = setup(fakeModel(replies), () => new Date(NOW.getTime() + night * 86_400_000));
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
