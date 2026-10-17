// [sunshine:memory] The notes as labelled lines: reading MEMORY.md, applying the model's changes, what
// code keeps out by the labels, and the file it writes back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, StateDir } from "@open-instinct/core";
import { applyChanges, CURRENT_MAX_DAYS, describeNotes, parseChanges, readNotes, renderNotes, saveLabels, withoutContactDetails, type Note } from "../src/memory-notes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function state(): StateDir {
  const dir = mkdtempSync(join(tmpdir(), "memory-notes-"));
  dirs.push(dir);
  const s = new StateDir(dir);
  s.ensure();
  return s;
}
const TODAY = "2026-10-17";

describe("reading the notes", () => {
  it("takes each line with its section as a guess, skips headings and the template line, and finds saved labels", () => {
    const s = state();
    const md = "# Memory\n\nDurable facts about the owner, their people and their preferences. Short lines. One fact per line.\n## About Torstein\n- Lives in Oslo.\n## People\n- Sanna: girlfriend.\n## Preferences\n- Likes short answers.\n## Lately\n- Weighing a flat in Oslo.\n- Lives in Oslo.\nAdded by memory_write later.";
    saveLabels(s, [{ text: "Lives in Oslo.", kind: "lasting", source: "said" }]);
    const notes = readNotes(md, s);
    expect(notes.map((n) => [n.text, n.kind, n.unlabeled ?? false])).toEqual([
      ["Lives in Oslo.", "lasting", false],
      ["Sanna: girlfriend.", "person", true],
      ["Likes short answers.", "preference", true],
      ["Weighing a flat in Oslo.", "current", true],
      ["Added by memory_write later.", "current", true],
    ]);
    expect(describeNotes(notes, "Torstein").split("\n")).toEqual([
      "n1 [lasting, said] Lives in Oslo.",
      "n2 [unlabeled, under People] Sanna: girlfriend.",
      "n3 [unlabeled, under Preferences] Likes short answers.",
      "n4 [unlabeled, under Lately] Weighing a flat in Oslo.",
      "n5 [unlabeled, under Lately] Added by memory_write later.",
    ]);
  });
});

describe("applying the changes", () => {
  const notes = (): Note[] => [
    { text: "Lives in Oslo.", kind: "lasting", source: "said" },
    { text: "Thinking about a trip to the Maldives.", kind: "lasting", source: "said", unlabeled: true },
    { text: "A packing list PDF was sent 15 Oct.", kind: "lasting", source: "said", unlabeled: true },
  ];

  it("removes, relabels, rewords and adds, and leaves what it does not mention as it was", () => {
    const r = applyChanges(notes(), [
      { id: "n3", remove: "a file sent once" },
      { id: "n2", kind: "current", date: "2026-10-15" },
      { text: "Sanna: girlfriend, studies medicine", kind: "person", source: "said" },
    ], TODAY);
    expect(r.problems).toEqual([]);
    expect(r.removed).toEqual([{ text: "A packing list PDF was sent 15 Oct.", why: "a file sent once" }]);
    expect(r.notes).toEqual([
      { text: "Lives in Oslo.", kind: "lasting", source: "said" },
      { text: "Thinking about a trip to the Maldives.", kind: "current", source: "said", date: "2026-10-15" },
      { text: "Sanna: girlfriend, studies medicine", kind: "person", source: "said" },
    ]);
    expect([r.added, r.updated]).toEqual([1, 1]);
  });

  it("names what is wrong with an answer: an unknown id, a new note without labels, an unlabeled note left", () => {
    const r = applyChanges(notes(), [{ id: "n9", remove: "x" }, { text: "Has a dog" }, { id: "n2", kind: "big" }], TODAY);
    expect(r.problems).toEqual([
      "n9 is not a note",
      'a new note needs kind and source: "Has a dog"',
      "n2: kind must be one of lasting, person, preference, current",
      "n2 is unlabeled: give it labels or remove it",
      "n3 is unlabeled: give it labels or remove it",
    ]);
    // Used anyway on a second answer: the invalid changes are left out, the rest stays as it was.
    expect(r.notes.map((n) => n.text)).toEqual(["Lives in Oslo.", "Thinking about a trip to the Maldives.", "A packing list PDF was sent 15 Oct."]);
  });

  it("keeps out what the labels say does not belong: the agent itself, what it read and nobody took up, private things they did not raise", () => {
    const r = applyChanges([], [
      { text: "Gmail and Calendar connected 15 Oct", kind: "lasting", source: "said", about_agent: true },
      { text: "Gmail showed a Helsenorge prescription message", kind: "current", source: "read", private: true },
      { text: "Dentist on Thursday, wants to move it", kind: "current", source: "read", taken_up: true, date: TODAY },
      { text: "Inbox had a Nordnet statement", kind: "current", source: "read" },
      { text: "Back pain; physio on Monday", kind: "current", source: "said", private: true, date: TODAY },
      { text: "Seeing a therapist", kind: "lasting", source: "showed", private: true },
      { text: "Prefers not to talk about the divorce", kind: "preference", source: "said", private: true },
    ], TODAY);
    expect(r.notes.map((n) => [n.text, n.kind])).toEqual([
      ["Dentist on Thursday, wants to move it", "current"],
      ["Back pain; physio on Monday", "current"],
      ["Prefers not to talk about the divorce", "lasting"], // private: not in the section partners may see
    ]);
    expect(r.dropped.map((d) => d.why)).toEqual(["about the agent itself", "read by the agent, not taken up", "read by the agent, not taken up", "private, and they did not bring it up"]);
  });

  it(`drops a current note nobody has mentioned for over ${CURRENT_MAX_DAYS} days, and dates a new one today`, () => {
    const r = applyChanges(
      [
        { text: "Weighing a flat in Oslo", kind: "current", source: "said", date: "2026-10-01" },
        { text: "Planning Lisbon in November", kind: "current", source: "said", date: "2026-10-05" },
      ],
      [{ text: "Watching for a Kanye concert", kind: "current", source: "said" }],
      TODAY,
    );
    expect(r.notes.map((n) => [n.text, n.date])).toEqual([["Planning Lisbon in November", "2026-10-05"], ["Watching for a Kanye concert", TODAY]]);
    expect(r.dropped).toEqual([{ text: "Weighing a flat in Oslo", why: `nothing new for over ${CURRENT_MAX_DAYS} days` }]);
  });

  it("keeps something coming up until its day, however long ago it was mentioned, and shows when each current note goes", () => {
    const before: Note[] = [
      { text: "J. Cole at Oslo Spektrum", kind: "current", source: "said", date: "2026-09-20", until: "2026-11-21" },
      { text: "Physio on Monday", kind: "current", source: "said", date: "2026-10-10", until: "2026-10-12" },
      { text: "Weighing a flat in Oslo", kind: "current", source: "said", date: "2026-10-15" },
    ];
    const r = applyChanges(before, [], TODAY);
    expect(r.notes.map((n) => n.text)).toEqual(["J. Cole at Oslo Spektrum", "Weighing a flat in Oslo"]);
    expect(r.dropped).toEqual([{ text: "Physio on Monday", why: "over (until 2026-10-12)" }]);
    expect(describeNotes(before, "Torstein").split("\n")).toEqual([
      "n1 [current, last true 2026-09-20, goes after 2026-11-21, said] J. Cole at Oslo Spektrum",
      "n2 [current, last true 2026-10-10, goes after 2026-10-12, said] Physio on Monday",
      "n3 [current, last true 2026-10-15, goes after 2026-10-29, said] Weighing a flat in Oslo",
    ]);
    // An until set by the model is kept with the note.
    const added = applyChanges([], [{ text: "Dentist moved to next week", kind: "current", source: "said", until: "2026-10-28" }], TODAY);
    expect(added.notes[0]).toMatchObject({ date: TODAY, until: "2026-10-28" });
  });

  it("strips email addresses and phone numbers, and keeps a line once", () => {
    const r = applyChanges([], [
      { text: "Miles: co-founder (miles@quicksolutions.io)", kind: "person", source: "said" },
      { text: "Mom Kari, +47 934 56 789", kind: "person", source: "said" },
      { text: "Mom Kari", kind: "person", source: "said" },
    ], TODAY);
    expect(r.notes.map((n) => n.text)).toEqual(["Miles: co-founder", "Mom Kari"]);
    expect(withoutContactDetails("Born 2026-10-15, call 91234567 or +4791234567.")).toBe("Born 2026-10-15, call or.");
  });
});

describe("writing the notes", () => {
  it("puts each kind under its heading, leaves out empty sections, and the preferences partners see are still found", () => {
    const s = state();
    const md = renderNotes([
      { text: "Weighing a flat", kind: "current", source: "said", date: TODAY },
      { text: "Lives in Oslo.", kind: "lasting", source: "said" },
      { text: "Likes short answers.", kind: "preference", source: "said" },
    ], "Torstein");
    expect(md).toBe("# Memory\n\n## About Torstein\n- Lives in Oslo.\n\n## Preferences\n- Likes short answers.\n\n## Lately\n- Weighing a flat\n");
    const memory = new MemoryStore(s);
    memory.replaceDurable(md);
    expect(memory.preferencesDigest()).toBe("- Likes short answers.");
    // Read back with the labels saved: nothing unlabeled the next night.
    saveLabels(s, readNotes(md, state()).map((n) => ({ ...n, unlabeled: undefined, source: "said" as const })));
    expect(readNotes(md, s).every((n) => !n.unlabeled)).toBe(true);
  });
});

describe("reading the answer", () => {
  it("takes the JSON between the tags, and nothing else", () => {
    expect(parseChanges('ok <changes>{"changes": [{"id": "n1", "remove": "over"}]}</changes>')).toEqual([{ id: "n1", remove: "over" }]);
    expect(parseChanges('<changes>{"changes": []}</changes>')).toEqual([]);
    expect(parseChanges('{"changes": []}')).toBeUndefined();
    expect(parseChanges("<changes>not json</changes>")).toBeUndefined();
    expect(parseChanges('<changes>{"nope": 1}</changes>')).toBeUndefined();
  });
});
