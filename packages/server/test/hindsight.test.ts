// [sunshine:hindsight] Hindsight as the memory engine, with a stand-in for its server: what goes in (kept items and the
// owner's own messages, a quiet spell at a time, never Sunshine's replies or notes; local times with their offset; each
// context naming the zone), Hindsight following the archive (stored once, stored again when a line is forgotten,
// deleted when gone, a failed store tried again), and recall by when things happen and by meaning.
import { describe, expect, it } from "vitest";
import { AuditLog, HistoryArchive, ItemArchive, StateDir, defaultConfig } from "@open-instinct/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HindsightMemory, SPELL_QUIET_MS, createHindsightRecall, createHindsightSearch, isTextOnly, localIso, type HindsightApi, type HindsightFact } from "../src/hindsight.js";
import type { Recall } from "../src/recall.js";

const T = Date.parse("2026-10-30T10:00:00Z"); // Fri 30 Oct, 11:00 in Oslo (CET)
const MIN = 60_000;
const user = (text: string, ts: number) => ({ role: "user", content: text, timestamp: ts }) as unknown as AgentMessage;
const assistant = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts }) as unknown as AgentMessage;

interface FakeOpts {
  facts?: HindsightFact[];
  near?: HindsightFact[];
  /** The replies bank's search results, and the pieces of text facts came from. */
  said?: HindsightFact[];
  chunks?: Record<string, { id: string; text: string }>;
  sourceFacts?: Record<string, HindsightFact>;
  failing?: Set<string>;
  slow?: boolean;
  /** The replies bank's settings as read back (default: text only, as asked). */
  saidConfig?: unknown;
  saidDown?: boolean;
}

function fakeApi(opts: FakeOpts = {}) {
  const calls = { banks: [] as Array<Record<string, unknown>>, stored: [] as Array<Record<string, unknown>>, deleted: [] as string[], recalls: [] as Array<Record<string, unknown>>, lists: [] as Array<Record<string, unknown>> };
  const api: HindsightApi = {
    createBank: async (bank, o) => {
      calls.banks.push({ bank, ...o });
      return {};
    },
    getBankConfig: async () => opts.saidConfig ?? { bank_id: "x", config: { retain_extraction_mode: "chunks", enable_observations: false } },
    retainBatch: async (bank, items, o) => {
      for (const it of items) {
        if (opts.failing?.has(it.document_id ?? "")) throw new Error("server busy");
        calls.stored.push({ bank, ...it, async: o?.async });
      }
      return { usage: { total_tokens: 100 } };
    },
    recall: async (bank, query, o) => {
      calls.recalls.push({ bank, query, ...o });
      if (opts.slow) return new Promise(() => {});
      if (bank.endsWith("-said")) {
        if (opts.saidDown) throw new Error("bank not found");
        return { results: opts.said ?? [] };
      }
      return { results: opts.near ?? [], ...(o?.includeChunks ? { chunks: opts.chunks ?? {} } : {}), ...(o?.includeSourceFacts ? { source_facts: opts.sourceFacts ?? {} } : {}) };
    },
    listMemories: async (_bank, o) => {
      calls.lists.push({ ...o });
      const from = Date.parse(o?.startDate ?? "");
      const to = Date.parse(o?.endDate ?? "");
      return { items: (opts.facts ?? []).filter((f) => Date.parse(f.occurred_start ?? "") >= from && Date.parse(f.occurred_start ?? "") < to) };
    },
    deleteDocument: async (_bank, id) => {
      calls.deleted.push(id);
    },
  };
  return { api, calls };
}

function setup(api: HindsightApi) {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "hindsight-")));
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  let now = T;
  const clock = () => new Date(now);
  const history = new HistoryArchive(state, { now: clock });
  const items = new ItemArchive(state, { now: clock });
  const audit = new AuditLog(state);
  const memory = new HindsightMemory({ api, bank: "sunshine-torstein", state, config, history, items, audit, now: clock });
  return { state, config, history, items, audit, memory, setNow: (ms: number) => (now = ms) };
}

function fill(s: ReturnType<typeof setup>) {
  s.history.record("imessage:owner", [
    user("[Tue 20 Oct 12:00]\nI prefer morning meetings", Date.parse("2026-10-20T10:00:00Z")),
    user("Remember: dinner with Zia on 5 Nov at 19:00", T - 180 * MIN),
    assistant("Noted! Your calendar has no events that day.", T - 180 * MIN + 10_000),
    user("[Not a message from Torstein: the reminder Sunshine sent]", T - 179 * MIN),
    user("thanks", T - 179 * MIN),
    user("what's on next week?", T - 5 * MIN),
  ]);
  s.items.add({ id: "rec-1", source: "recording", title: "Server talk", startedAt: Date.parse("2026-10-26T11:52:00Z"), people: ["Morten"], text: "[00:23] Torstein: let's meet Thursday at 14:00\n[00:30] Morten: fine by me" });
}

describe("hindsight: what goes in", () => {
  it("keeps items and quiet spells of the owner's own messages, oldest first, in local time with the zone named", async () => {
    const { api, calls } = fakeApi();
    const s = setup(api);
    fill(s);
    expect(await s.memory.sync()).toEqual({ stored: 4, deleted: 0, failed: 0 });
    expect(calls.banks).toEqual([
      { bank: "sunshine-torstein", retainMission: expect.stringContaining("Memory for Torstein's personal assistant"), retainExtractionMode: "concise", enableObservations: true },
      { bank: "sunshine-torstein-said", retainExtractionMode: "chunks", enableObservations: false },
    ]);
    const [old, rec, spell, said] = calls.stored as Array<Record<string, string>>;
    // Before the clocks went back (CEST) and after (CET): his wall-clock time with its offset, never UTC.
    expect(old!.timestamp).toBe("2026-10-20T12:00:00+02:00");
    expect(old!.content).toBe("[2026-10-20 12:00] Torstein: I prefer morning meetings");
    expect(rec).toMatchObject({ document_id: "item:rec-1", timestamp: "2026-10-26T12:52:00+01:00", metadata: { source: "recording", title: "Server talk" }, async: false });
    expect(rec!.context).toContain("recorded on their phone, with Morten");
    expect(rec!.context).toContain("Each line starts with the time into the conversation, not the time of day.");
    expect(rec!.context).toContain("Times are Europe/Oslo time unless it names another zone.");
    // Only his side: not Sunshine's reply ("no events that day" would become a fact), not the runtime's note.
    expect(spell!.content).toBe("[2026-10-30 08:00] Torstein: Remember: dinner with Zia on 5 Nov at 19:00\n[2026-10-30 08:01] Torstein: thanks");
    expect(spell!.timestamp).toBe("2026-10-30T08:00:00+01:00");
    expect(spell!.context).toBe("Torstein's own text messages to Sunshine, their personal AI assistant (only Torstein's side of the chat). Times are Europe/Oslo time unless it names another zone.");
    expect(String(spell!.document_id)).toMatch(/^chat:/);
    // What Sunshine said (its reply, the runtime's note of a text it sent) goes to the replies bank only, word for word.
    expect(said).toMatchObject({ bank: "sunshine-torstein-said", content: "[2026-10-30 08:00] Sunshine: Noted! Your calendar has no events that day.\n[2026-10-30 08:01] (note): [Not a message from Torstein: the reminder Sunshine sent]" });
    expect(String(said!.document_id)).toMatch(/^said:/);
    expect(said!.context).toBe("What Sunshine, Torstein's personal AI assistant, said to Torstein: its own replies and the texts it sent (as said then, not facts). Times are Europe/Oslo time unless it names another zone.");
    expect(calls.stored.filter((d) => d.bank === "sunshine-torstein").map((d) => d.content).join("\n")).not.toMatch(/Sunshine:|\(note\)/);
    expect(calls.stored.map((d) => d.content).join("\n")).not.toContain("next week");

    // The spell still going on goes in once it has been quiet.
    expect(await s.memory.sync()).toEqual({ stored: 0, deleted: 0, failed: 0 });
    s.setNow(T - 5 * MIN + SPELL_QUIET_MS + 1);
    expect(await s.memory.sync()).toMatchObject({ stored: 1 });
    expect(calls.stored.at(-1)!.content).toBe("[2026-10-30 10:55] Torstein: what's on next week?");
    expect(calls.banks).toHaveLength(2);

    // A source that is not a conversation is named as what it is.
    s.items.add({ id: "mail-1", source: "email", title: "Your tickets", startedAt: T - 60 * MIN, text: "Order: J. Cole, 12.11.26 19:00" });
    // [sunshine:flowing-in] Email is a source of its own now, named as what it is; one with no rule still reads "From ...".
    expect(s.memory.documents().docs.find((d) => d.id === "item:mail-1")!.context).toBe("An email Torstein received. Times are Europe/Oslo time unless it names another zone.");
    s.items.add({ id: "note-1", source: "notion", title: "Plan", startedAt: T - 60 * MIN, text: "Launch on 3 Nov" });
    expect(s.memory.documents().docs.find((d) => d.id === "item:note-1")!.context).toBe("From Torstein's notion. Times are Europe/Oslo time unless it names another zone.");
  });

  it("writes times as local wall-clock time with the offset that holds then", () => {
    expect(localIso(Date.parse("2026-10-25T00:30:00Z"), "Europe/Oslo")).toBe("2026-10-25T02:30:00+02:00");
    expect(localIso(Date.parse("2026-10-25T01:30:00Z"), "Europe/Oslo")).toBe("2026-10-25T02:30:00+01:00");
    expect(localIso(Date.parse("2026-11-12T18:00:00Z"), "America/New_York")).toBe("2026-11-12T13:00:00-05:00");
  });
});

describe("hindsight: follows the archive", () => {
  it("stores again what changed, deletes what is gone, and tries a failed store again", async () => {
    const failing = new Set<string>(["item:rec-1"]);
    const { api, calls } = fakeApi({ failing });
    const s = setup(api);
    fill(s);
    expect(await s.memory.sync()).toEqual({ stored: 3, deleted: 0, failed: 1 });
    expect(s.audit.read({ kinds: ["error"] })[0]!.detail).toMatchObject({ hindsight: "store failed", doc: "item:rec-1", message: "server busy" });
    failing.clear();
    expect(await s.memory.sync()).toEqual({ stored: 1, deleted: 0, failed: 0 });

    // A line forgotten in an item: the item is stored again without it (the same id replaces it in Hindsight).
    s.items.forget("fine by me", {}, true);
    expect(await s.memory.sync()).toEqual({ stored: 1, deleted: 0, failed: 0 });
    expect(calls.stored.at(-1)).toMatchObject({ document_id: "item:rec-1", content: "[00:23] Torstein: let's meet Thursday at 14:00" });

    // The first message of a spell forgotten: the spell starts later, so it is a new document and the old one goes.
    const before = calls.stored.find((d) => String(d.content).includes("dinner with Zia"))!.document_id as string;
    s.history.forget("dinner with Zia", {}, true);
    expect(await s.memory.sync()).toEqual({ stored: 1, deleted: 1, failed: 0 });
    expect(calls.deleted).toEqual([before]);
    expect(calls.stored.at(-1)!.content).toBe("[2026-10-30 08:01] Torstein: thanks");
    expect(s.audit.read({ kinds: ["policy"] }).some((e) => JSON.stringify(e.detail).includes("dinner"))).toBe(false);
  });
});

describe("hindsight: the replies bank", () => {
  it("stores nothing there unless Hindsight reads it back as text only; the rest goes in", async () => {
    // As if the bank kept its old settings (or a strategy fell back): replies would become facts there.
    const { api, calls } = fakeApi({ saidConfig: { config: { retain_extraction_mode: "concise", enable_observations: true } } });
    const s = setup(api);
    fill(s);
    expect(await s.memory.sync()).toEqual({ stored: 3, deleted: 0, failed: 1 });
    expect(calls.stored.some((d) => d.bank === "sunshine-torstein-said")).toBe(false);
    expect(s.audit.read({ kinds: ["error"] })[0]!.detail).toMatchObject({ hindsight: "store failed", message: "bank sunshine-torstein-said is not text only (chunks, observations off)" });
    expect(isTextOnly({ config: { retain_extraction_mode: "chunks", enable_observations: false } })).toBe(true);
    expect(isTextOnly({ retain_extraction_mode: "chunks" })).toBe(false);
  });
});

describe("hindsight: the agent's own search", () => {
  const fact = (id: string, text: string, extra: Partial<HindsightFact> = {}): HindsightFact => ({ id, text, mentioned_at: "2026-10-26T11:52:00+00:00", document_id: "item:rec-1", ...extra });

  it("shows what is known, the text it came from and what Sunshine said, each marked for what it is", async () => {
    const { api, calls } = fakeApi({
      near: [
        fact("k1", "Torstein and Morten decided OVH is fine for V1", { chunk_id: "c1" }),
        fact("k2", "The server must be in Europe because of GDPR", { chunk_id: "c1" }),
        fact("k3", "Torstein prefers morning meetings", { document_id: "chat:abc:1", mentioned_at: "2026-10-20T10:00:00+00:00", chunk_id: "c2" }),
      ],
      chunks: { c1: { id: "c1", text: "[22:01] Torstein: which server we're gonna use\n[22:10] Morten: OVH is fine for V1" }, c2: { id: "c2", text: "[2026-10-20 12:00] Torstein: I prefer morning meetings" } },
      said: [fact("s1", "[2026-10-29 11:41] Sunshine: Your calendar has no events from 2 to 8 November.", { document_id: "said:abc:1", mentioned_at: "2026-10-29T10:41:00+00:00" })],
    });
    const s = setup(api);
    s.items.add({ id: "rec-1", source: "recording", title: "Server talk", startedAt: Date.parse("2026-10-26T11:52:00Z"), text: "[00:01] Morten: OVH then" });
    const search = createHindsightSearch({ memory: s.memory, config: s.config, items: s.items, audit: s.audit, now: () => new Date(T) });
    expect(await search("what did we decide about the server?")).toBe(
      [
        "What you know, best first (from what Torstein told you and what reached them; dated, so things may have changed since):",
        "[noted 26 Oct 2026] Torstein and Morten decided OVH is fine for V1 (recorded on their phone: Server talk)",
        "[noted 26 Oct 2026] The server must be in Europe because of GDPR (recorded on their phone: Server talk)",
        "[noted 20 Oct 2026] Torstein prefers morning meetings (their own texts)",
        "",
        "The text it came from:",
        "(recorded on their phone: Server talk)",
        "  [22:01] Torstein: which server we're gonna use",
        "  [22:10] Morten: OVH is fine for V1",
        "(their own texts)",
        "  [2026-10-20 12:00] Torstein: I prefer morning meetings",
        "",
        "What you (Sunshine) said to Torstein before, word for word (your words then, not facts: check anything about other systems again):",
        "[2026-10-29 11:41] Sunshine: Your calendar has no events from 2 to 8 November.",
      ].join("\n"),
    );
    expect(calls.recalls.map((r) => [r.bank, r.includeChunks ?? false])).toEqual([["sunshine-torstein", true], ["sunshine-torstein-said", false]]);

    // A range keeps what was said or noted in it.
    const inOct26 = await search("server", { since: Date.parse("2026-10-25T23:00:00Z"), until: Date.parse("2026-10-26T23:00:00Z") });
    expect(inOct26).toContain("OVH is fine");
    expect(inOct26).not.toContain("morning meetings");
    expect(inOct26).not.toContain("no events from 2 to 8");
  });

  it("leaves out what Sunshine said when its bank fails, and says nothing when nothing is found", async () => {
    const down = fakeApi({ near: [fact("k1", "Torstein and Morten decided OVH is fine for V1")], saidDown: true });
    const s = setup(down.api);
    const search = createHindsightSearch({ memory: s.memory, config: s.config, audit: s.audit, now: () => new Date(T) });
    const text = await search("server");
    expect(text).toContain("OVH is fine");
    expect(text).not.toContain("said to Torstein before");
    expect(s.audit.read({ kinds: ["error"] })[0]!.detail).toMatchObject({ memorySearch: "replies bank left out" });
    const empty = setup(fakeApi().api);
    expect(await createHindsightSearch({ memory: empty.memory, config: empty.config, now: () => new Date(T) })("passport")).toBeUndefined();
  });
});

describe("hindsight: recall", () => {
  const oslo = (iso: string) => iso; // facts as Hindsight keeps them: UTC
  const founders: HindsightFact = { id: "f1", text: "Torstein is invited to The Founder's Story Oslo at Startup Lab", occurred_start: oslo("2026-11-03T16:00:00+00:00"), mentioned_at: "2026-10-30T10:06:54+00:00", document_id: "item:email-1", metadata: { source: "email", title: "Invitation: The Founder's Story Oslo" } };
  const dateOnly: HindsightFact = { id: "f2", text: "Torstein has an event on 3 November", occurred_start: "2026-11-03T00:00:00.010000+00:00", mentioned_at: "2026-10-27T06:00:00+00:00", document_id: "chat:abc123:1" };
  const lateSunday: HindsightFact = { id: "f3", text: "A late show starts after midnight", occurred_start: "2026-11-08T23:30:00+00:00", document_id: "item:email-2" }; // Mon 9 Nov 00:30 in Oslo
  const itself: HindsightFact = { id: "f4", text: "The voice note itself", occurred_start: "2026-11-04T09:00:00+00:00", document_id: "item:rec-new" };
  const server: HindsightFact = { id: "f5", text: "Torstein and Morten decided OVH is fine for V1", mentioned_at: "2026-10-26T11:52:00+00:00", document_id: "item:rec-1" };
  const recentChat: HindsightFact = { id: "f6", text: "Torstein asked what is on next week", mentioned_at: "2026-10-30T09:55:00+00:00", document_id: "chat:abc123:2" };

  function recallSetup(opts: Parameters<typeof fakeApi>[0], fallback?: Recall) {
    const { api, calls } = fakeApi(opts);
    const s = setup(api);
    s.items.add({ id: "rec-1", source: "recording", title: "Server talk", startedAt: Date.parse("2026-10-26T11:52:00Z"), text: "[00:01] Morten: OVH then" });
    const recall = createHindsightRecall({ memory: s.memory, config: s.config, items: s.items, audit: s.audit, now: () => new Date(T), waitMs: 50, ...(fallback ? { fallback } : {}) });
    return { recall, calls, audit: s.audit };
  }

  it("lists every fact on the days asked by when it happens, then the rest by meaning, without the item itself or today's chats", async () => {
    // Same email, same evening (Hindsight adds a few ms to keep facts in order).
    const again = { ...founders, id: "f1b", text: "Torstein received an invitation to The Founder's Story Oslo, 5pm-8pm CET", occurred_start: "2026-11-03T16:00:00.020000+00:00" };
    // Hindsight's consolidated view of two facts: shown instead of them.
    const observed: HindsightFact = { id: "o1", text: "Torstein plans to see Dune: Part Three at Odeon Storo", occurred_start: "2026-11-06T18:00:00+00:00", document_id: null, source_memory_ids: ["d1", "d2"] };
    const dune1: HindsightFact = { id: "d1", text: "Torstein wants Dune tickets", occurred_start: "2026-11-06T18:00:00+00:00", document_id: "item:rec-dune" };
    const dune2: HindsightFact = { id: "d2", text: "Torstein asked for Dune tickets at Odeon", occurred_start: "2026-11-06T18:00:00+00:00", document_id: "chat:abc123:3" };
    // A date written with his offset is kept as his midnight (23:00 UTC the day before): still that day, no time shown.
    const localDate: HindsightFact = { id: "f7", text: "Torstein's passport expires", occurred_start: "2026-11-06T23:00:00.010000+00:00", document_id: "item:email-3" };
    const { recall, calls } = recallSetup({ facts: [founders, again, dateOnly, lateSunday, itself, dune1, observed, dune2, localDate], near: [server, founders, dune1, recentChat] });
    const text = await recall(["Anything happening next week for me", "events next week"], { exclude: "rec-new", chatsBefore: T - 86_400_000, days: ["2026-11-02/2026-11-08"] });
    // The owner's days, widened to hold dates kept as midnight UTC.
    expect(calls.lists).toEqual([{ timeField: "occurred_start", startDate: "2026-11-01T23:00:00.000Z", endDate: "2026-11-09T00:00:00.000Z", state: "valid", limit: 50 }]);
    expect(calls.recalls).toEqual([
      {
        bank: "sunshine-torstein",
        query: "Anything happening next week for me; events next week",
        budget: "mid",
        maxTokens: 1500,
        queryTimestamp: "2026-10-30T11:00:00+01:00",
        types: ["observation", "world", "experience"],
        preferObservations: true,
        includeSourceFacts: true,
        maxSourceFactsTokens: 2000,
      },
    ]);
    expect(text).toBe(
      [
        "On the days it concerns, by when each thing happens:",
        "[happens Tue, 3 Nov 2026; noted 27 Oct 2026] Torstein has an event on 3 November (their own texts)",
        "[happens Tue, 3 Nov 2026, 17:00; noted 30 Oct 2026] Torstein is invited to The Founder's Story Oslo at Startup Lab (received by email: Invitation: The Founder's Story Oslo)",
        "[happens Fri, 6 Nov 2026, 19:00] Torstein plans to see Dune: Part Three at Odeon Storo",
        "[happens Sat, 7 Nov 2026] Torstein's passport expires",
        "",
        "Related, best first:",
        "[noted 26 Oct 2026] Torstein and Morten decided OVH is fine for V1 (recorded on their phone: Server talk)",
      ].join("\n"),
    );
  });

  it("gives an observation the document of its source fact: where it came from, and the item itself left out", async () => {
    const fromServerTalk: HindsightFact = { id: "o1", text: "Torstein and Morten settled on OVH for V1", source_fact_ids: ["s1"] };
    const fromTheNewNote: HindsightFact = { id: "o2", text: "Torstein recorded a note about the presentation", source_fact_ids: ["s2"] };
    const { recall } = recallSetup({
      near: [fromServerTalk, fromTheNewNote],
      sourceFacts: { s1: { id: "s1", text: "OVH is fine for V1", document_id: "item:rec-1", chunk_id: "c1" }, s2: { id: "s2", text: "a note", document_id: "item:rec-new" } },
    });
    expect(await recall(["the server"], { exclude: "rec-new" })).toBe(["Related, best first:", "Torstein and Morten settled on OVH for V1 (recorded on their phone: Server talk)"].join("\n"));
  });

  it("says nothing when nothing is kept, and lets the meaning search answer when Hindsight is slow", async () => {
    const empty = recallSetup({});
    expect(await empty.recall(["renew my passport"])).toBeUndefined();
    expect(await empty.recall([" "], { days: [] })).toBeUndefined();
    expect(empty.calls.recalls).toHaveLength(1);

    const fallback: Recall = async (q) => `meaning search: ${q.join(", ")}`;
    const slow = recallSetup({ slow: true }, fallback);
    expect(await slow.recall(["the 3 Nov event"])).toBe("meaning search: the 3 Nov event");
    expect(slow.audit.read({ kinds: ["error"] })[0]!.detail).toMatchObject({ recall: "Hindsight failed, meaning search answered" });
  });
});
