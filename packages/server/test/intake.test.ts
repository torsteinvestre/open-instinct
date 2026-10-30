// [sunshine:intake] What reached the owner from elsewhere, with a stand-in model: kept, summarized once,
// journaled, handed to the agent as the summary only; and what happens when the summary fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, ItemArchive, MemoryStore, StateDir, defaultConfig } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { SUMMARY_SCHEMA, createIntake, parseAsk, parseSummary, speakersOf, type IntakeDeps } from "../src/intake.js";
import type { LookUpAsk } from "../src/lookup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = Date.parse("2026-10-24T08:14:00Z"); // Sat 24 Oct, 10:14 in Oslo
const MIN = 60_000;
const MEETING = [
  "[00:07] Sarah: Right, this is our second meeting.",
  "[18:00] Unknown speaker: Can you pass that?",
  "[25:42] Sarah: I think we are focusing on a sort of mid-range business kind of class type people.",
  "[30:00] Ian: The shell shape could work.",
  "[38:10] Maya: What should marketing look at for next time?",
  "[38:15] Una: Instruction manuals, I'd say.",
].join("\n");
const SUMMARY_JSON = {
  title: "Remote control design meeting",
  summary: "Second design meeting for the TV remote; the group settled the target buyer and the shape.",
  decisions: ["Target buyer: young, business-class people, mid-range price", "Shell-like flip-top shape"],
  owner_tasks: ["Research what consumers think of instruction manuals before the next meeting"],
  others_tasks: ["Una: work the company logo into the design"],
  open: ["Repetitive strain injury"],
};
const answer = (j: unknown) => JSON.stringify(j);

function fakeModel(replies: Array<string | Error>): ModelCall & { asked: Array<{ system: string; user: string; schema?: unknown }> } {
  const asked: Array<{ system: string; user: string; schema?: unknown }> = [];
  const call = (async ({ system, user, schema }) => {
    asked.push({ system, user, schema });
    const r = replies.shift();
    if (r === undefined) throw new Error("no reply queued");
    if (r instanceof Error) throw r;
    return { text: r, costUsd: 0.03, model: "sonnet" };
  }) as ModelCall & { asked: typeof asked };
  call.asked = asked;
  return call;
}

function setup(call?: ModelCall, extra: Partial<Pick<IntakeDeps, "recall" | "load" | "lookUp">> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "intake-"));
  dirs.push(dir);
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Maya", timezone: "Europe/Oslo" };
  const memory = new MemoryStore(state);
  memory.replaceDurable("## About\n- Maya is the marketing expert on a team designing a TV remote.\n");
  const items = new ItemArchive(state, { now: () => new Date(T + 60 * MIN) });
  const audit = new AuditLog(state);
  const tasks: Array<{ id: string; name?: string; prompt: string; load?: string[] }> = [];
  const intake = createIntake({ items, memory, config, audit, ...(call ? { call } : {}), runTask: async (t) => (tasks.push(t), "NO_REPLY"), ...extra });
  const audits = () => audit.read().map((e) => e.detail).filter((d) => d && "intake" in d) as Array<Record<string, unknown>>;
  return { state, config, memory, items, intake, tasks, audits };
}

const meeting = { id: "es2004b", source: "band", startedAt: T, endedAt: T + 39 * MIN, text: MEETING };

describe("intake", () => {
  it("keeps the item, summarizes it once, journals it and hands the agent the summary only", async () => {
    const model = fakeModel([answer(SUMMARY_JSON)]);
    const { items, memory, intake, tasks, audits } = setup(model);
    const result = await intake.receive(meeting);
    expect(result).toMatchObject({ outcome: "handed over", costUsd: 0.03, reply: "NO_REPLY" });

    // The summary model saw the whole record as data, with the owner's notes and what may be wrong in it.
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]!.schema).toBe(SUMMARY_SCHEMA); // [sunshine:fixed-form]
    expect(model.asked[0]!.system).toContain("Speaker names come from voice recognition");
    expect(model.asked[0]!.system).toContain('even if nobody said "decide"');
    expect(model.asked[0]!.system).toContain("where it was left: the last view stated, and by whom");
    expect(model.asked[0]!.user).toContain("Maya is the marketing expert");
    expect(model.asked[0]!.user).toContain("heard by the band, Sat 24 Oct, 10:14-10:53 Europe/Oslo, with Sarah, Ian, Una.");
    expect(model.asked[0]!.user).toContain('<untrusted source="a recording of Maya\'s conversation">');
    expect(model.asked[0]!.user).toContain("[38:15] Una: Instruction manuals, I'd say.");

    // Kept whole with the summary; the people are the named speakers, not the owner or unknown voices.
    const kept = items.get("es2004b")!;
    expect(kept.people).toEqual(["Sarah", "Ian", "Una"]);
    expect(kept.title).toBe("Remote control design meeting");
    expect(kept.summary!.ownerTasks).toEqual(["Research what consumers think of instruction manuals before the next meeting"]);
    expect(kept.text).toBe(MEETING);

    // One journal line, so the owner's own conversation knows it happened today.
    const journal = memory.readJournal(new Date(T));
    expect(journal).toContain("Remote control design meeting (heard by the band, 10:14-10:53 Europe/Oslo, with Sarah, Ian, Una): Second design meeting");
    expect(journal).toContain("(kept in full)");
    expect(journal.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);

    // The agent gets the summary as data and how to act on it, not the transcript.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("intake-es2004b");
    const prompt = tasks[0]!.prompt;
    expect(prompt).toMatch(/^Maya's conversation "Remote control design meeting" \(heard by the band, Sat 24 Oct, 10:14-10:53 Europe\/Oslo, with Sarah, Ian, Una\) is now kept in full; history_search finds/);
    expect(prompt).toContain('<untrusted source="summary of the recording">');
    expect(prompt).toContain("Maya's tasks:\n- Research what consumers think of instruction manuals before the next meeting");
    expect(prompt).toContain("Decided:\n- Target buyer: young, business-class people, mid-range price");
    // [sunshine:acting] How to act is the owner's one rule in the system prompt; the hand-off points to it.
    expect(prompt).toContain("Handle it as you handle everything for Maya (How you act for Maya), starting from what is above.");
    expect(prompt).not.toContain("easy to undo");
    expect(prompt).not.toContain("ask first");
    expect(prompt).toMatch(/otherwise end with exactly NO_REPLY\.$/);
    expect(prompt).not.toContain("Instruction manuals, I'd say");
    // [sunshine:in-the-flow] Without meaning search nothing was looked up, and the prompt does not pretend it was.
    expect(prompt).not.toContain("already know that may bear");
    expect(prompt).not.toContain("Nothing you have kept");
    expect(tasks[0]!.load).toBeUndefined();

    expect(audits()).toEqual([expect.objectContaining({ intake: "handed over", id: "es2004b", source: "band", costUsd: 0.03, ownerTasks: 1, decisions: 2 })]);
  });

  // [sunshine:fixed-form] The form makes this rare (a refusal, an empty summary); no second try.
  it("keeps the item without handing it over when the summary cannot be read", async () => {
    const model = fakeModel(['{"title": "x", "summary": " "}']);
    const { items, memory, intake, tasks, audits } = setup(model);
    expect(await intake.receive(meeting)).toMatchObject({ outcome: "summary unreadable", costUsd: 0.03 });
    expect(model.asked).toHaveLength(1);
    expect(items.get("es2004b")!.summary).toBeUndefined();
    expect(memory.readJournal(new Date(T))).toContain("A conversation (heard by the band, 10:14-10:53 Europe/Oslo, with Sarah, Ian, Una) (kept in full)");
    expect(tasks).toHaveLength(0);
    expect(audits()[0]).toMatchObject({ intake: "summary unreadable" });
  });

  it("without a summary model, keeps and journals the item and wakes nobody", async () => {
    const { items, intake, tasks, audits } = setup();
    expect(await intake.receive({ ...meeting, people: ["Sarah"] })).toEqual({ outcome: "kept, not summarized", costUsd: 0 });
    expect(items.get("es2004b")!.people).toEqual(["Sarah"]);
    expect(tasks).toHaveLength(0);
    expect(audits()[0]).toMatchObject({ intake: "kept, not summarized" });
  });

  it("a failing model call keeps the item and logs the error", async () => {
    const { items, intake, tasks, audits } = setup(fakeModel([new Error("overloaded")]));
    expect(await intake.receive(meeting)).toMatchObject({ outcome: "failed" });
    expect(items.get("es2004b")).toBeDefined();
    expect(tasks).toHaveLength(0);
    expect(audits()[0]).toMatchObject({ intake: "failed", error: "overloaded" });
  });

  it("[sunshine:in-the-flow] brings what is already known and what is still unclear, with email and calendar loaded", async () => {
    // The first voice note (2026-10-27): "the event on 3 Nov" was asked about while it was in his email.
    const model = fakeModel([answer({ ...SUMMARY_JSON, to_settle: ["Which event is on 3 Nov, and at what time"] })]);
    const asked: Array<{ queries: string[]; exclude?: string }> = [];
    const recall = async (queries: string[], opts?: { exclude?: string }) => {
      asked.push({ queries, ...(opts?.exclude ? { exclude: opts.exclude } : {}) });
      return "[Thu 22 Oct 2026] Brand week planning (recorded on their phone)\n  Owner's tasks: Book the venue for the 3 Nov launch";
    };
    const { intake, tasks, items } = setup(model, { recall, load: ["apps"] });
    await intake.receive(meeting);

    // Asked about the title, the owner's tasks, what is unclear and what was left open; the item itself left out.
    expect(asked).toEqual([{ queries: ["Remote control design meeting", SUMMARY_JSON.owner_tasks[0], "Which event is on 3 Nov, and at what time", "Repetitive strain injury"], exclude: "es2004b" }]);
    expect(model.asked[0]!.system).toContain("to_settle: what Maya's tasks need that the record leaves out or unsure");
    expect(items.get("es2004b")!.summary!.toSettle).toEqual(["Which event is on 3 Nov, and at what time"]);

    const prompt = tasks[0]!.prompt;
    expect(prompt).toContain("Still unclear:\n- Which event is on 3 Nov, and at what time");
    expect(prompt).toContain('What you already know that may bear on it (earlier conversations and kept items, best first; dated, so things may have changed since):\n<untrusted source="what you already know">');
    expect(prompt).toContain("Owner's tasks: Book the venue for the 3 Nov launch");
    expect(prompt).toContain("starting from what is above."); // [sunshine:acting]
    expect(prompt).toContain("Speaker names come from voice recognition and the words from speech recognition; both can be wrong."); // a band recording: how sure the source is
    expect(tasks[0]!.load).toEqual(["apps"]);
  });

  it("[sunshine:in-the-flow] runs the summary's email searches and calendar days by code and hands over what they show", async () => {
    // The live check (2026-10-27): told what was unclear, the agent asked instead of searching his email.
    const model = fakeModel([answer({ ...SUMMARY_JSON, to_settle: ["Which event is on 3 Nov, and at what time"], searches: ['"3 November" OR "Nov 3"'], days: ["2026-11-03"] })]);
    const asks: LookUpAsk[] = [];
    const lookUp = async (ask: LookUpAsk) => (asks.push(ask), 'Email, searched for "3 November" OR "Nov 3":\n- Sat, 17 Oct 2026, from Oslo Startup Lab: Founders Story Oslo\nCalendar, Tue, 3 Nov 2026: nothing in the calendar.');
    const { intake, tasks, items } = setup(model, { lookUp, recall: async () => undefined });
    await intake.receive(meeting);

    // The summary step is asked for the searches and days, knows the year, and is told to leave other systems' state out.
    expect(model.asked[0]!.system).toContain("searches: for each to_settle point Maya's email may answer");
    expect(model.asked[0]!.system).toContain("days: the dates Maya's tasks and open points are about");
    expect(model.asked[0]!.system).toContain("not what is in a calendar, an inbox or another app now");
    expect(model.asked[0]!.user).toContain("It was made on 2026-10-24. From that day: This week: Mon 19 Oct to Sun 25 Oct (2026-10-19/2026-10-25). Next week: Mon 26 Oct to Sun 1 Nov");
    expect(asks).toEqual([{ searches: ['"3 November" OR "Nov 3"'], days: ["2026-11-03"] }]);

    const prompt = tasks[0]!.prompt;
    expect(prompt).toContain('What Maya\'s email and calendar show for it, looked up just now for what is still unclear and the days it is about:\n<untrusted source="email and calendar">\nEmail, searched for "3 November" OR "Nov 3":\n- Sat, 17 Oct 2026, from Oslo Startup Lab: Founders Story Oslo');
    expect(prompt.indexOf("looked up just now")).toBeLessThan(prompt.indexOf("starting from what is above.")); // [sunshine:acting]
    // The searches are for this hand-off only; the kept summary does not carry them.
    expect(items.get("es2004b")!.summary).not.toHaveProperty("searches");
    expect(items.get("es2004b")!.summary).not.toHaveProperty("days");
  });

  it("[sunshine:in-the-flow] looks nothing up when the summary asks nothing, and a failed look-up does not stop the hand-off", async () => {
    let called = 0;
    const counting = async () => (called++, "x");
    const quiet = setup(fakeModel([answer(SUMMARY_JSON)]), { lookUp: counting });
    await quiet.intake.receive(meeting);
    expect(called).toBe(0);
    expect(quiet.tasks[0]!.prompt).not.toContain("looked up just now");
    expect(quiet.tasks[0]!.prompt).toContain("starting from what is above."); // [sunshine:acting]

    const failing = setup(fakeModel([answer({ ...SUMMARY_JSON, searches: ["Founders"] })]), {
      lookUp: async () => {
        throw new Error("composio down");
      },
    });
    expect(await failing.intake.receive(meeting)).toMatchObject({ outcome: "handed over" });
    expect(failing.tasks[0]!.prompt).not.toContain("looked up just now");
  });

  it("[sunshine:in-the-flow] says so when nothing kept bears on it; typed work carries no speech-recognition caveat", async () => {
    const { intake, tasks } = setup(fakeModel([answer(SUMMARY_JSON)]), { recall: async () => undefined });
    await intake.receive({ ...meeting, source: "claude-code" });
    const p = tasks[0]!.prompt;
    expect(p).toContain("Nothing you have kept seems to bear on it.");
    expect(p).not.toContain("speech recognition");
    expect(p).toContain("starting from what is above."); // [sunshine:acting]
  });

  it("reads the summary leniently and finds the named speakers", () => {
    expect(parseSummary(answer({ summary: " Short. ", decisions: ["a", 3, " ", "b"], owner_tasks: "none" }))).toEqual({ summary: "Short.", decisions: ["a", "b"], ownerTasks: [], othersTasks: [], open: [] });
    expect(parseSummary(answer({ summary: "S.", to_settle: ["When is it?", 4] }))!.toSettle).toEqual(["When is it?"]); // [sunshine:in-the-flow]
    // [sunshine:in-the-flow] What to look up, read as leniently; missing or unreadable asks nothing.
    expect(parseAsk(answer({ summary: "S.", searches: [" J. Cole ", 3, ""], days: ["2026-11-12", null] }))).toEqual({ searches: ["J. Cole"], days: ["2026-11-12"] });
    expect(parseAsk(answer({ summary: "S.", searches: "J. Cole" }))).toEqual({ searches: [], days: [] });
    expect(parseAsk("{not json")).toEqual({ searches: [], days: [] });
    expect(parseSummary(answer({ title: "x" }))).toBeUndefined();
    expect(parseSummary("not json")).toBeUndefined();
    expect(speakersOf(MEETING, "Maya")).toEqual(["Sarah", "Ian", "Una"]);
    expect(speakersOf("[1:02:03] Ola Nordmann: hei\nnot a turn: x", "Maya")).toEqual(["Ola Nordmann"]);
  });
});
