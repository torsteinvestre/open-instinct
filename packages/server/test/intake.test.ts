// [sunshine:intake] What reached the owner from elsewhere, with a stand-in model: kept, summarized once,
// journaled, handed to the agent as the summary only; and what happens when the summary fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, ItemArchive, MemoryStore, StateDir, defaultConfig } from "@open-instinct/core";
import type { ModelCall } from "@open-instinct/watcher";
import { createIntake, parseSummary, speakersOf } from "../src/intake.js";

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
const answer = (j: unknown) => `<summary>${JSON.stringify(j)}</summary>`;

function fakeModel(replies: Array<string | Error>): ModelCall & { asked: Array<{ system: string; user: string }> } {
  const asked: Array<{ system: string; user: string }> = [];
  const call = (async ({ system, user }) => {
    asked.push({ system, user });
    const r = replies.shift();
    if (r === undefined) throw new Error("no reply queued");
    if (r instanceof Error) throw r;
    return { text: r, costUsd: 0.03, model: "sonnet" };
  }) as ModelCall & { asked: typeof asked };
  call.asked = asked;
  return call;
}

function setup(call?: ModelCall) {
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
  const tasks: Array<{ id: string; name?: string; prompt: string }> = [];
  const intake = createIntake({ items, memory, config, audit, ...(call ? { call } : {}), runTask: async (t) => (tasks.push(t), "NO_REPLY") });
  const audits = () => audit.read().map((e) => e.detail).filter((d) => d && "intake" in d) as Array<Record<string, unknown>>;
  return { state, memory, items, intake, tasks, audits };
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
    expect(journal).toContain("Remote control design meeting (heard by the band, until 10:53, with Sarah, Ian, Una): Second design meeting");
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
    expect(prompt).toContain("Do what is clearly Maya's and easy to undo");
    expect(prompt).toContain("all questions in one text");
    expect(prompt).toMatch(/otherwise end with exactly NO_REPLY\.$/);
    expect(prompt).not.toContain("Instruction manuals, I'd say");

    expect(audits()).toEqual([expect.objectContaining({ intake: "handed over", id: "es2004b", source: "band", costUsd: 0.03, ownerTasks: 1, decisions: 2 })]);
  });

  it("asks once more when the summary cannot be read, then keeps the item without handing it over", async () => {
    const model = fakeModel(["Here is the summary: the meeting went well.", "<summary>{not json</summary>"]);
    const { items, memory, intake, tasks, audits } = setup(model);
    expect(await intake.receive(meeting)).toMatchObject({ outcome: "summary unreadable", costUsd: 0.06 });
    expect(model.asked).toHaveLength(2);
    expect(model.asked[1]!.user).toMatch(/Answer with the JSON between <summary> and <\/summary>/);
    expect(items.get("es2004b")!.summary).toBeUndefined();
    expect(memory.readJournal(new Date(T))).toContain("A conversation (heard by the band, until 10:53, with Sarah, Ian, Una) (kept in full)");
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

  it("reads the summary leniently and finds the named speakers", () => {
    expect(parseSummary(answer({ summary: " Short. ", decisions: ["a", 3, " ", "b"], owner_tasks: "none" }))).toEqual({ summary: "Short.", decisions: ["a", "b"], ownerTasks: [], othersTasks: [], open: [] });
    expect(parseSummary(answer({ title: "x" }))).toBeUndefined();
    expect(parseSummary("no tags")).toBeUndefined();
    expect(speakersOf(MEETING, "Maya")).toEqual(["Sarah", "Ian", "Una"]);
    expect(speakersOf("[1:02:03] Ola Nordmann: hei\nnot a turn: x", "Maya")).toEqual(["Ola Nordmann"]);
  });
});
