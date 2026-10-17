// [sunshine:history] The owner's conversations kept for searching after the live history is trimmed.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLog } from "../src/audit.js";
import { coreTools } from "../src/core-tools.js";
import { HISTORY_FILE, HistoryArchive, queryWords } from "../src/history.js";
import { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { ToolRegistry } from "../src/tools.js";
import { principalOf, tempState, testConfig } from "./helpers.js";

const T = Date.parse("2026-10-15T08:47:00Z"); // Thu 15 Oct, 04:47 in New York (the test owner's zone)
const MIN = 60_000;
const user = (text: string, ts: number): AgentMessage => ({ role: "user", content: [{ type: "text", text: `[Thu 15 Oct 2026, 10:47 Europe/Oslo, UTC+02:00]\n${text}` }], timestamp: ts });
const agent = (text: string, ts: number): AgentMessage => ({ ...fauxAssistantMessage(text), timestamp: ts }) as AgentMessage;
const lines = (state: ReturnType<typeof tempState>) => state.readLines(HISTORY_FILE).map((l) => JSON.parse(l) as { ts: number; who: string; text: string });

describe("history archive", () => {
  it("keeps the conversation once: texts and replies without stamps, notes short, no summaries or tool traffic", () => {
    const state = tempState();
    const history = new HistoryArchive(state, { now: () => new Date(T + 60 * MIN) });
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "[Conversation summary] 30 earlier messages were trimmed. Highlights:\n- user: hi" }], timestamp: T - 10 * MIN },
      user("I have a fund, what should be considered in the fund vs apartment", T),
      { ...fauxAssistantMessage([fauxToolCall("web_search", { query: "boligpriser" }, { id: "c1" })], { stopReason: "toolUse" }), timestamp: T + 1000 } as AgentMessage,
      { role: "toolResult", toolCallId: "c1", toolName: "web_search", content: [{ type: "text", text: "1. Eiendom Norge ..." }], isError: false, timestamp: T + 2000 } as AgentMessage,
      agent("Three things matter most: equity, rates and tax.", T + 3000),
      user(`[Not a message from Maria: a note that you texted them the next message when a reminder came due. ${"x".repeat(400)}]`, T + 5 * MIN),
      agent("Drink water", T + 5 * MIN + 1),
    ];
    expect(history.record("imessage:c1", messages)).toBe(4);
    expect(history.record("imessage:c1", messages)).toBe(0); // saved again: nothing new
    const kept = lines(state);
    expect(kept.map((e) => e.who)).toEqual(["owner", "agent", "note", "agent"]);
    expect(kept[0]!.text).toBe("I have a fund, what should be considered in the fund vs apartment");
    expect(kept[2]!.text.length).toBe(300);
    // [sunshine:memory] A reply keeps what its tools read; a reply after none (or after a new message) has nothing.
    expect((kept as Array<{ tools?: string[] }>).map((e) => e.tools)).toEqual([undefined, ["the web"], undefined, undefined]);
    // A new process reads the file and still writes nothing twice.
    expect(new HistoryArchive(state, { now: () => new Date(T + 60 * MIN) }).record("imessage:c1", messages)).toBe(0);
  });

  it("finds messages with every word, newest first, with the answer that followed", () => {
    const state = tempState();
    const history = new HistoryArchive(state, { now: () => new Date(T + 3 * 24 * 60 * MIN) });
    history.record("imessage:c1", [
      user("what about the fund vs apartment question", T),
      agent("Keep the fund unless the apartment is a home you would live in.", T + MIN),
      user("Lunch with Martin about the deck tomorrow", T + 24 * 60 * MIN),
      agent("Noted.", T + 24 * 60 * MIN + 1000),
      user("Was the fund a good idea after all?", T + 2 * 24 * 60 * MIN),
    ]);
    const both = history.search("fund apartment");
    expect(both.partial).toBe(false);
    expect(both.matches).toHaveLength(1);
    expect(both.matches[0]!.next?.text).toMatch(/^Keep the fund/);
    // The reply matched too, but is shown once: under the question it answered.
    const fund = history.search("FUND");
    expect(fund.matches.map((m) => m.entry.ts)).toEqual([T + 2 * 24 * 60 * MIN, T]);
    const partial = history.search("fund mortgage");
    expect(partial.partial).toBe(true);
    expect(partial.matches.length).toBeGreaterThan(0);
    const early = history.search("fund", { until: T + 12 * 60 * MIN }).matches;
    expect(early.map((m) => [m.entry.text, m.next?.text])).toEqual([["what about the fund vs apartment question", "Keep the fund unless the apartment is a home you would live in."]]);
    expect(history.search("nothing like this").matches).toHaveLength(0);
    expect(queryWords("Hva med lånet på XRP?")).toEqual(["hva", "med", "lånet", "på", "xrp"]);
  });

  it("forgets on request, after showing what would go, and never keeps it again", () => {
    const state = tempState();
    const history = new HistoryArchive(state, { now: () => new Date(T + 60 * MIN) });
    const messages = [user("my prescription from helsenorge came", T), agent("Got it.", T + 1000), user("lunch at 12", T + 2000)];
    history.record("imessage:c1", messages);
    expect(history.forget("prescription")).toHaveLength(1);
    expect(lines(state)).toHaveLength(3); // only listed
    expect(history.forget("prescription", {}, true)).toHaveLength(1);
    expect(lines(state).map((e) => e.text)).toEqual(["Got it.", "lunch at 12"]);
    // Still in the live thread, saved again: not written back.
    expect(history.record("imessage:c1", messages)).toBe(0);
    expect(new HistoryArchive(state, { now: () => new Date(T + 60 * MIN) }).record("imessage:c1", messages)).toBe(0);
  });

  it("drops what is older than the age limit", () => {
    const state = tempState();
    new HistoryArchive(state, { now: () => new Date(T) }).record("imessage:c1", [user("old", T - 400 * 24 * 60 * MIN), user("new", T - MIN)]);
    const later = new HistoryArchive(state, { now: () => new Date(T) });
    expect(later.all().map((e) => e.text)).toEqual(["new"]);
    expect(lines(state).map((e) => e.text)).toEqual(["new"]);
  });

  it("gives the owner history_search and history_forget, with dates in the owner's time", async () => {
    const state = tempState();
    const config = testConfig();
    const history = new HistoryArchive(state, { now: () => new Date(T + 60 * MIN) });
    history.record("imessage:c1", [user("what about the fund vs apartment", T), agent("Keep the fund.", T + MIN)]);
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} }, history }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now: () => new Date(T + 60 * MIN) };
    const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
    const search = registry.get("history_search")!;
    expect(search.spec.meta.capabilities).toEqual(["memory.write"]); // the owner's own: no one else has it
    const found = text(await search.spec.execute({ query: "fund apartment" }, ctx));
    expect(found).toContain("[Thu 15 Oct, 04:47] Maria: what about the fund vs apartment");
    expect(found).toContain("[Thu 15 Oct, 04:48] Instinct: Keep the fund.");
    // Days are the owner's days: 15 Oct in New York starts at 04:00 UTC.
    expect(text(await search.spec.execute({ query: "fund", since: "2026-10-16" }, ctx))).toMatch(/^Nothing found for "fund" in your earlier conversations \(kept from Thu 15 Oct, 04:47\)\.$/);
    expect(text(await search.spec.execute({ query: "fund", until: "2026-10-15" }, ctx))).toContain("Keep the fund.");
    const forget = registry.get("history_forget")!;
    expect(text(await forget.spec.execute({ query: "apartment" }, ctx))).toMatch(/^1 message\(s\) would be removed/);
    expect(text(await forget.spec.execute({ query: "apartment", confirm: true }, ctx))).toMatch(/^Removed 1 message/);
    expect(text(await search.spec.execute({ query: "apartment" }, ctx))).toMatch(/^Nothing found/);
  });
});
