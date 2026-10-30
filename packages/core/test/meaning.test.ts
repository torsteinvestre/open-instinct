// [sunshine:meaning-search] Search by meaning and words over the kept chats and items, with a stand-in search model.
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLog } from "../src/audit.js";
import { coreTools } from "../src/core-tools.js";
import { HistoryArchive } from "../src/history.js";
import { ItemArchive, type ItemSummary } from "../src/items.js";
import { MEANING_FILE, MeaningSearch, PIECE_CHARS, chatPieces, itemPieces, type Embedder } from "../src/meaning.js";
import { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { ToolRegistry } from "../src/tools.js";
import { principalOf, tempState, testConfig } from "./helpers.js";

const T = Date.parse("2026-10-24T08:14:00Z"); // Sat 24 Oct, 04:14 in New York (the test owner's zone)
const MIN = 60_000;

/**
 * A stand-in search model: words that mean the same thing share a dimension, so it finds other wordings
 * the way a real model does ("ring" ~ "phone"); every other word gets a small dimension of its own.
 */
const SAME_MEANING = [
  ["phone", "phones", "ring", "call", "calls", "calling"],
  ["money", "spend", "cost", "costs", "price", "budget"],
  ["target", "buyer", "buyers", "audience", "customers"],
];
function standIn(calls: string[] = []): Embedder & { calls: string[] } {
  return {
    model: "stand-in@1",
    calls,
    async embed(texts, kind) {
      return texts.map((t) => {
        calls.push(`${kind}:${t.slice(0, 30)}`);
        const v = new Float32Array(SAME_MEANING.length + 64);
        for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          const group = SAME_MEANING.findIndex((g) => g.includes(w));
          if (group >= 0) v[group]! += 1;
          else v[SAME_MEANING.length + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64)]! += 0.05;
        }
        const len = Math.hypot(...v) || 1;
        return v.map((x) => x / len);
      });
    },
  };
}

const msg = (role: "user" | "assistant", text: string, ts: number) => ({ role, content: [{ type: "text", text }], timestamp: ts }) as never;
const SUMMARY: ItemSummary = {
  title: "Remote control design meeting",
  summary: "Second design meeting for the TV remote.",
  decisions: ["Aim it at young business customers"],
  ownerTasks: [],
  othersTasks: [],
  open: [],
};

function setup() {
  const state = tempState();
  const config = testConfig();
  const now = () => new Date(T + 600 * MIN);
  const history = new HistoryArchive(state, { now });
  const items = new ItemArchive(state, { now });
  const embedder = standIn();
  const audit = new AuditLog(state);
  const meaning = new MeaningSearch({ state, embedder, config, history, items, audit });
  return { state, config, now, history, items, embedder, audit, meaning };
}

describe("meaning search: pieces", () => {
  it("cuts a thread into pieces of consecutive messages, a new one after an hour's pause, dated in the owner's time", () => {
    const { history, config } = setup();
    history.record("imessage:c1", [msg("user", "should I ring the bank", T), msg("assistant", "Yes, call them today.", T + MIN), msg("user", "new topic: the cabin", T + 120 * MIN)]);
    history.record("imessage:c2", [msg("user", "other thread", T + 2 * MIN)]);
    const pieces = chatPieces(history.all(), config);
    expect(pieces.map((p) => p.lines)).toEqual([
      ["[2026-10-24 04:14] Maria: should I ring the bank", "[2026-10-24 04:15] Instinct: Yes, call them today."],
      ["[2026-10-24 06:14] Maria: new topic: the cabin"],
      ["[2026-10-24 04:16] Maria: other thread"],
    ]);
    expect(pieces.map((p) => p.ts)).toEqual([T, T + 120 * MIN, T + 2 * MIN]);
  });

  it("keeps pieces under PIECE_CHARS; a long message is cut, its speaker kept in front of each part", () => {
    const { history, config } = setup();
    history.record("imessage:c1", [msg("assistant", "word ".repeat(700).trim(), T)]);
    const pieces = chatPieces(history.all(), config);
    expect(pieces.length).toBe(2);
    for (const p of pieces) expect(p.lines.join("\n").length).toBeLessThanOrEqual(PIECE_CHARS);
    expect(pieces[1]!.lines[0]).toMatch(/^\[2026-10-24 04:14\] Instinct: …\S/);
  });

  it("gives an item its summary (with the title) as one piece and its text in stretches", () => {
    const { items } = setup();
    items.add({ id: "m1", source: "band", startedAt: T, text: ["[00:07] Sarah: Hello all.", "[25:42] Sarah: We focus on young business people."].join("\n") });
    items.setSummary("m1", SUMMARY);
    const pieces = itemPieces(items.get("m1")!);
    expect(pieces.map((p) => [p.part, p.lines[0]])).toEqual([
      ["summary", "Remote control design meeting"],
      ["text", "[00:07] Sarah: Hello all."],
    ]);
  });
});

describe("meaning search: storing and forgetting", () => {
  it("stores a vector per piece once; a grown piece is stored again and its old vector removed", async () => {
    const { history, meaning, embedder, state } = setup();
    history.record("imessage:c1", [msg("user", "should I ring the bank", T)]);
    expect(await meaning.sync()).toEqual({ added: 1, removed: 0 });
    expect(await meaning.sync()).toEqual({ added: 0, removed: 0 });
    history.record("imessage:c1", [msg("user", "should I ring the bank", T), msg("assistant", "Yes.", T + MIN)]);
    expect(await meaning.sync()).toEqual({ added: 1, removed: 1 });
    expect(embedder.calls.every((c) => c.startsWith("document:"))).toBe(true);
    expect(Object.keys(state.readJson<{ vectors: object }>(MEANING_FILE, { vectors: {} }).vectors)).toHaveLength(1);
    expect(meaning.status()).toEqual({ pieces: 1, stored: 1 });
  });

  it("stores again from scratch for another model", async () => {
    const { history, meaning, state, config } = setup();
    history.record("imessage:c1", [msg("user", "hello", T)]);
    await meaning.sync();
    const other = new MeaningSearch({ state, config, history, embedder: { ...standIn(), model: "other@2" } });
    expect(other.status()).toEqual({ pieces: 1, stored: 0 });
    expect(await other.sync()).toEqual({ added: 1, removed: 0 });
  });

  it("history_forget removes the forgotten text's vectors at once", async () => {
    const { history, meaning, state, config, now } = setup();
    history.record("imessage:c1", [msg("user", "my secret code is 4471", T)]);
    history.record("imessage:c2", [msg("user", "the cabin trip", T)]);
    await meaning.sync();
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} }, history, meaning }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now };
    await registry.get("history_forget")!.spec.execute({ query: "secret code", confirm: true }, ctx);
    expect(Object.keys(state.readJson<{ vectors: object }>(MEANING_FILE, { vectors: {} }).vectors)).toHaveLength(1);
    expect(meaning.status()).toEqual({ pieces: 1, stored: 1 });
  });

  it("a failure while storing is audited, and what was stored so far is kept", async () => {
    const { history, state, config, audit } = setup();
    history.record("imessage:c1", [msg("user", "first", T)]);
    history.record("imessage:c2", [msg("user", "second", T + MIN)]);
    let n = 0;
    const flaky: Embedder = { model: "flaky@1", embed: async (texts, kind) => (n++ === 0 ? standIn().embed(texts, kind) : Promise.reject(new Error("out of memory"))) };
    const meaning = new MeaningSearch({ state, config, history, embedder: flaky, audit });
    await meaning.sync();
    expect(meaning.status()).toEqual({ pieces: 2, stored: 1 });
    expect(audit.read({ kinds: ["error"] }).some((e) => e.kind === "error" && JSON.stringify(e.detail).includes("out of memory"))).toBe(true);
  });
});

describe("meaning search: finding", () => {
  async function filled() {
    const s = setup();
    s.history.record("imessage:c1", [msg("user", "remind me about the phone calls with suppliers", T - 3 * 24 * 60 * MIN)]);
    s.history.record("imessage:c2", [msg("user", "order 23-48112 arrived damaged", T - 2 * 24 * 60 * MIN)]);
    s.history.record("imessage:c3", [msg("user", "the cabin weekend is booked", T - 24 * 60 * MIN)]);
    s.items.add({ id: "m1", source: "band", startedAt: T, text: ["[00:07] Sarah: Hello all.", "[25:42] Sarah: We focus on young business people."].join("\n") });
    s.items.setSummary("m1", SUMMARY);
    await s.meaning.sync();
    return s;
  }
  const first = (p: { lines: string[] } | undefined) => p?.lines[0] ?? "";

  it("finds another wording by meaning, where words alone find nothing", async () => {
    const { meaning } = await filled();
    expect((await meaning.search("ring people", {}, "words")).some((p) => first(p).includes("phone calls"))).toBe(false);
    expect(first((await meaning.search("ring people", {}, "meaning"))[0])).toContain("phone calls with suppliers");
    expect(first((await meaning.search("ring people"))[0])).toContain("phone calls with suppliers");
  });

  it("finds an exact number by words, merged with what meaning puts forward", async () => {
    const { meaning } = await filled();
    expect(first((await meaning.search("23-48112"))[0])).toContain("order 23-48112");
  });

  it("keeps to the date range", async () => {
    const { meaning } = await filled();
    const found = await meaning.search("cabin", { since: T - 30 * 60 * MIN });
    expect(found.every((p) => p.ts > T - 30 * 60 * MIN)).toBe(true);
  });

  it("history_search shows the best pieces: a chat as it was, an item under its heading and summary", async () => {
    const { state, config, now, history, items, meaning } = await filled();
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit: new AuditLog(state), config, outbox: { send: async () => {} }, history, items, meaning }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now };
    const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
    const search = registry.get("history_search")!;
    expect(search.spec.description).toContain("search again in other words");

    const out = text(await search.spec.execute({ query: "who is the target buyer" }, ctx));
    expect(out).toMatch(/^Most relevant first, by meaning and words/);
    expect(out).toContain([
      "[Sat 24 Oct, 04:14] Remote control design meeting (heard by the band)",
      "  Summary: Second design meeting for the TV remote.",
      "  Decided: Aim it at young business customers",
    ].join("\n"));
    expect(out.indexOf("Remote control design meeting")).toBeLessThan(out.indexOf("cabin"));
    expect(text(await search.spec.execute({ query: "ring people" }, ctx))).toContain("[2026-10-21 04:14] Maria: remind me about the phone calls with suppliers");
  });

  it("history_search falls back to word search when the search model fails, and audits it", async () => {
    const { state, config, now, history, audit } = setup();
    history.record("imessage:c1", [msg("user", "the manuals worry me", T)]);
    const broken = new MeaningSearch({ state, config, history, embedder: { model: "broken@1", embed: async () => Promise.reject(new Error("model not loaded")) } });
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit, config, outbox: { send: async () => {} }, history, meaning: broken }));
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now };
    const r = await registry.get("history_search")!.spec.execute({ query: "manuals" }, ctx);
    const out = typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(out).toBe("Newest first:\n[Sat 24 Oct, 04:14] Maria: the manuals worry me");
    expect(audit.read({ kinds: ["error"] }).some((e) => e.kind === "error" && JSON.stringify(e.detail).includes("model not loaded"))).toBe(true);
  });

  it("[sunshine:hindsight] history_search asks the memory engine first, and word search answers when it fails", async () => {
    const { state, config, now, history, audit } = setup();
    history.record("imessage:c1", [msg("user", "the manuals worry me", T)]);
    const asked: Array<{ query: string; range: unknown }> = [];
    let down = false;
    const memorySearch = async (query: string, range: unknown) => {
      asked.push({ query, range });
      if (down) throw new Error("Hindsight is down");
      return "What you know, best first: the manuals are late";
    };
    const registry = new ToolRegistry();
    registry.registerMany(coreTools({ memory: new MemoryStore(state), scheduler: new Scheduler(state), approvals: new ApprovalStore(state), audit, config, outbox: { send: async () => {} }, history, memorySearch }));
    const tool = registry.get("history_search")!;
    expect(tool.spec.description).toContain("what you yourself said to them");
    const ctx = { principal: principalOf("owner"), conversationKey: "imessage:c1", channel: "imessage" as const, ownerTurn: true, now };
    const run = async (args: Record<string, string>) => {
      const r = await tool.spec.execute(args as never, ctx);
      return typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    };
    expect(await run({ query: "manuals", since: "2026-10-01" })).toBe("What you know, best first: the manuals are late");
    expect(asked[0]!.query).toBe("manuals");
    expect((asked[0]!.range as { since?: number }).since).toBeGreaterThan(0);
    down = true;
    expect(await run({ query: "manuals" })).toBe("Newest first:\n[Sat 24 Oct, 04:14] Maria: the manuals worry me");
    expect(audit.read({ kinds: ["error"] }).some((e) => JSON.stringify(e.detail).includes("Hindsight is down"))).toBe(true);
  });

  it("[sunshine:hindsight] without a search model: words only, nothing stored, meaning alone refused", async () => {
    const { state, config, history } = setup();
    history.record("imessage:c1", [msg("user", "should I ring the bank", T), msg("user", "the cabin roof", T + 120 * MIN)]);
    const words = new MeaningSearch({ state, config, history });
    expect(await words.sync()).toEqual({ added: 0, removed: 0 });
    const hits = await words.searchScored("cabin");
    expect(hits[0]!.piece.lines.join(" ")).toContain("the cabin roof");
    expect(hits[0]!.near).toBeUndefined();
    await expect(words.searchScored("cabin", {}, "meaning")).rejects.toThrow("no search model");
  });
});
