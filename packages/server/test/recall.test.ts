// [sunshine:in-the-flow] What is already known, gathered before the agent decides: the closest pieces for each subject,
// weak matches dropped, the new item itself left out, one entry per item, best first; word search when the search model
// does not answer in time.
import { describe, expect, it } from "vitest";
import { AuditLog, StateDir, defaultConfig, type ArchiveItem, type MeaningSearch, type Piece } from "@open-instinct/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_MIN_NEAR, createRecall } from "../src/recall.js";

const T = Date.parse("2026-10-22T10:00:00Z");
const item = (id: string, title: string): ArchiveItem => ({ id, source: "recording", title, startedAt: T, text: "", receivedAt: T, people: ["Ian", "Scott"] });
const itemPiece = (it: ArchiveItem, part: "summary" | "text", lines: string[]): Piece => ({ kind: "item", item: it, part, hash: `${it.id}-${part}`, ts: T, lines });
const chat = (hash: string, line: string): Piece => ({ kind: "chat", hash, ts: T, lines: [line] });

const GROUP = item("rec-group", "Group project kickoff");
const NEW = item("rec-new", "Today's voice note");

function setup(hits: Record<string, Array<{ piece: Piece; score: number; near?: number }>>, opts: { slow?: boolean } = {}) {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "recall-")));
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const calls: Array<{ query: string; mode?: string }> = [];
  const meaning = {
    searchScored: async (query: string, _range: unknown, mode?: string) => {
      calls.push({ query, ...(mode ? { mode } : {}) });
      if (opts.slow && mode !== "words") return new Promise(() => {});
      return hits[query] ?? [];
    },
  } as unknown as MeaningSearch;
  const audit = new AuditLog(state);
  return { recall: createRecall({ meaning, config, audit, waitMs: 20 }), calls, audit };
}

describe("recall", () => {
  it("[sunshine:grounding] leaves out chat stretches from chatsBefore on (they are in the thread already)", async () => {
    const older = { ...chat("old", "Torstein: the event is on the third of November"), ts: T - 3 * 86_400_000 };
    const recent = { ...chat("new", "Torstein: anything next week?"), ts: T };
    const { recall } = setup({ "events next week": [{ piece: recent, score: 0.9, near: 0.9 }, { piece: older, score: 0.8, near: 0.8 }] });
    const text = await recall(["events next week"], { chatsBefore: T - 86_400_000 });
    expect(text).toContain("third of November");
    expect(text).not.toContain("anything next week?");
  });

  it("brings the closest pieces for each subject, best first, one entry per item, without the new item or weak matches", async () => {
    const { recall } = setup({
      "Make the presentation for my group": [
        { piece: itemPiece(NEW, "summary", ["Today's voice note: presentation"]), score: 0.9, near: 0.9 }, // the item itself
        { piece: itemPiece(GROUP, "summary", ["Group project with Ian and Scott, about wormholes", "Owner's tasks: the slides on traversable wormholes"]), score: 0.6, near: 0.62 },
        { piece: chat("c1", "[2026-10-20 18:00] Torstein: the wormhole group meets Thursdays"), score: 0.5, near: 0.55 },
        { piece: chat("c2", "[2026-10-01 09:00] Torstein: pizza tonight?"), score: 0.3, near: RECALL_MIN_NEAR - 0.05 }, // weak
      ],
      "Which topic was assigned": [
        { piece: itemPiece(GROUP, "text", ["[03:10] Ian: our topic is wormholes"]), score: 0.7, near: 0.66 }, // same item, better
      ],
    });
    const known = await recall(["Make the presentation for my group", "Which topic was assigned", " "], { exclude: "rec-new" });
    expect(known).toBe(
      [
        "[Thu, 22 Oct 2026] Group project kickoff (recorded on their phone, with Ian, Scott)\n  [03:10] Ian: our topic is wormholes",
        "[2026-10-20 18:00] Torstein: the wormhole group meets Thursdays",
      ].join("\n\n"),
    );
  });

  it("says nothing when nothing is close enough, and answers with word search when the search model is too slow", async () => {
    const empty = setup({ "renew my passport": [{ piece: chat("c2", "[2026-10-01 09:00] Torstein: pizza tonight?"), score: 0.2, near: 0.3 }] });
    expect(await empty.recall(["renew my passport"])).toBeUndefined();
    expect(await empty.recall(["", "  "])).toBeUndefined();

    const slow = setup({ "the 3 Nov event": [{ piece: chat("c3", "[2026-10-21 12:00] Torstein: launch party on 3 Nov"), score: 4.2 }] }, { slow: true });
    expect(await slow.recall(["the 3 Nov event"])).toBe("[2026-10-21 12:00] Torstein: launch party on 3 Nov");
    expect(slow.calls).toEqual([{ query: "the 3 Nov event" }, { query: "the 3 Nov event", mode: "words" }]);
    expect(slow.audit.read({ kinds: ["error"] })[0]!.detail).toMatchObject({ recall: "word search answered instead" });
  });
});
