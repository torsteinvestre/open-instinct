// [sunshine:intake] What reached the owner from elsewhere: kept whole, searched and forgotten with the chat history's tools.
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLog } from "../src/audit.js";
import { coreTools } from "../src/core-tools.js";
import { HistoryArchive } from "../src/history.js";
import { ITEMS_FILE, ItemArchive, summaryLines, type ItemSummary } from "../src/items.js";
import { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { ToolRegistry } from "../src/tools.js";
import { principalOf, tempState, testConfig } from "./helpers.js";

const T = Date.parse("2026-10-24T08:14:00Z"); // Sat 24 Oct, 04:14 in New York (the test owner's zone)
const MIN = 60_000;
const MEETING = [
  "[00:07] Sarah: Right, this is our second meeting.",
  "[25:42] Sarah: I think we are focusing on a sort of mid-range business kind of class type people.",
  "[38:10] Maya: What should marketing look at for next time?",
  "[38:15] Sarah: Instruction manuals.",
].join("\n");
const SUMMARY: ItemSummary = {
  title: "Remote control design meeting",
  summary: "Second design meeting for the TV remote.",
  decisions: ["Target buyer: young, business-class people, mid-range price"],
  ownerTasks: ["Research what consumers think of instruction manuals before the next meeting"],
  othersTasks: ["Una: work the company logo into the design"],
  open: ["Repetitive strain injury"],
};
const lines = (state: ReturnType<typeof tempState>) => state.readLines(ITEMS_FILE).map((l) => JSON.parse(l) as { id: string; text: string });

describe("item archive", () => {
  it("keeps an item whole with its summary; the same id again replaces it", () => {
    const state = tempState();
    const items = new ItemArchive(state, { now: () => new Date(T + 60 * MIN) });
    items.add({ id: "m1", source: "band", startedAt: T, endedAt: T + 39 * MIN, people: ["Sarah"], text: MEETING });
    items.setSummary("m1", SUMMARY);
    expect(items.get("m1")).toMatchObject({ source: "band", title: "Remote control design meeting", people: ["Sarah"], summary: SUMMARY, receivedAt: T + 60 * MIN });
    expect(summaryLines(SUMMARY)).toEqual([
      "Second design meeting for the TV remote.",
      "Decided: Target buyer: young, business-class people, mid-range price",
      "Their tasks: Research what consumers think of instruction manuals before the next meeting",
      "Others' tasks: Una: work the company logo into the design",
      "Open: Repetitive strain injury",
    ]);
    items.add({ id: "m1", source: "band", startedAt: T, text: "[00:01] Sarah: corrected transcript" });
    expect(lines(state)).toHaveLength(1);
    expect(items.get("m1")!.text).toBe("[00:01] Sarah: corrected transcript");
  });

  it("finds lines of the text and the summary with every word, newest item first; partial otherwise", () => {
    const state = tempState();
    const items = new ItemArchive(state, { now: () => new Date(T + 3 * 24 * 60 * MIN) });
    items.add({ id: "m1", source: "band", startedAt: T, text: MEETING });
    items.setSummary("m1", SUMMARY);
    items.add({ id: "m2", source: "band", startedAt: T + 24 * 60 * MIN, text: "[02:00] Ian: The manuals came back from the printer." });
    const target = items.search("target buyer");
    expect(target.partial).toBe(false);
    expect(target.matches.map((m) => [m.item.id, m.lines.map((l) => l.part)])).toEqual([["m1", ["summary"]]]);
    const manuals = items.search("MANUALS");
    expect(manuals.matches.map((m) => m.item.id)).toEqual(["m2", "m1"]);
    expect(manuals.matches[1]!.lines.map((l) => l.text)).toEqual([
      "Their tasks: Research what consumers think of instruction manuals before the next meeting",
      "[38:15] Sarah: Instruction manuals.",
    ]);
    const partial = items.search("business budget");
    expect(partial.partial).toBe(true);
    expect(partial.matches[0]!.lines[0]!.text).toContain("business");
    expect(items.search("manuals", { until: T + 60 * MIN }).matches.map((m) => m.item.id)).toEqual(["m1"]);
    expect(items.search("zebra giraffe").matches).toHaveLength(0);
  });

  it("forgets lines on request, after showing what would go, and keeps them out when the item comes again", () => {
    const state = tempState();
    const items = new ItemArchive(state, { now: () => new Date(T + 60 * MIN) });
    const meeting = { id: "m1", source: "band", startedAt: T, text: MEETING };
    items.add(meeting);
    items.setSummary("m1", SUMMARY);
    expect(items.forget("instruction manuals")).toHaveLength(2);
    expect(items.get("m1")!.text).toContain("Instruction manuals."); // only listed
    expect(items.forget("instruction manuals", {}, true)).toHaveLength(2);
    const after = items.get("m1")!;
    expect(after.text).not.toContain("Instruction manuals.");
    expect(after.summary!.ownerTasks).toEqual([]);
    expect(after.summary!.decisions).toHaveLength(1);
    // Sent again (the backend retries), and summarized again: the forgotten lines stay out.
    const again = new ItemArchive(state, { now: () => new Date(T + 60 * MIN) });
    again.add(meeting);
    again.setSummary("m1", SUMMARY);
    expect(again.get("m1")!.text).not.toContain("Instruction manuals.");
    expect(again.get("m1")!.summary!.ownerTasks).toEqual([]);
  });

  it("drops what is older than the age limit", () => {
    const state = tempState();
    new ItemArchive(state, { now: () => new Date(T) }).add({ id: "old", source: "band", startedAt: T - 400 * 24 * 60 * MIN, text: "[00:01] A: old" });
    new ItemArchive(state, { now: () => new Date(T) }).add({ id: "new", source: "band", startedAt: T - MIN, text: "[00:01] A: new" });
    expect(new ItemArchive(state, { now: () => new Date(T) }).all().map((it) => it.id)).toEqual(["new"]);
    expect(lines(state).map((it) => it.id)).toEqual(["new"]);
  });

  it("history_search shows chats and what came from elsewhere; history_forget removes both", async () => {
    const state = tempState();
    const config = testConfig();
    const now = () => new Date(T + 60 * MIN);
    const history = new HistoryArchive(state, { now });
    const items = new ItemArchive(state, { now });
    history.record("imessage:c1", [{ role: "user", content: [{ type: "text", text: "the manuals worry me" }], timestamp: T - 60 * MIN } as never]);
    items.add({ id: "m1", source: "band", startedAt: T, endedAt: T + 39 * MIN, people: ["Sarah", "Ian", "Una"], text: MEETING });
    items.setSummary("m1", SUMMARY);
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} }, history, items }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now };
    const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
    const search = registry.get("history_search")!;

    const target = text(await search.spec.execute({ query: "target buyer" }, ctx));
    expect(target).toBe([
      "From elsewhere, newest first (a line's [mm:ss] is the time into the conversation):",
      "[Sat 24 Oct, 04:14-04:53] Remote control design meeting (heard by the band, with Sarah, Ian, Una)",
      "  Summary: Second design meeting for the TV remote.",
      "  Decided: Target buyer: young, business-class people, mid-range price",
    ].join("\n"));
    const manuals = text(await search.spec.execute({ query: "manuals" }, ctx));
    expect(manuals).toMatch(/^Newest first:\n\[Sat 24 Oct, 03:14\] Maria: the manuals worry me\n\nFrom elsewhere/);
    expect(manuals).toContain("  [38:15] Sarah: Instruction manuals.");

    const forget = registry.get("history_forget")!;
    expect(text(await forget.spec.execute({ query: "manuals" }, ctx))).toMatch(/^3 message\(s\) would be removed/);
    expect(text(await forget.spec.execute({ query: "manuals", confirm: true }, ctx))).toMatch(/^Removed 3 message/);
    expect(text(await search.spec.execute({ query: "manuals" }, ctx))).toMatch(/^Nothing found/);
  });

  it("history_search clips a long line so the matching words show, keeping who said it", async () => {
    const state = tempState();
    const items = new ItemArchive(state, { now: () => new Date(T + 60 * MIN) });
    items.add({ id: "m1", source: "band", startedAt: T, text: `[12:00] Sarah: ${"we talked about many other things here. ".repeat(30)}and then the docking station.` });
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config: testConfig(), outbox: { send: async () => {} }, items }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now: () => new Date(T + 60 * MIN) };
    const r = await registry.get("history_search")!.spec.execute({ query: "docking station" }, ctx);
    const out = typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(out).toContain("[12:00] Sarah: …");
    expect(out).toContain("and then the docking station.");
  });
});
