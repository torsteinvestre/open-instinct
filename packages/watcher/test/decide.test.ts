// [sunshine:watcher]
import { describe, expect, it } from "vitest";
import { extractJson, headlineOverlap, parseDecision, parseScreen } from "../src/decide.js";

describe("reading the models' answers", () => {
  it("finds the JSON even with prose or a code fence around it", () => {
    expect(extractJson('Here you go:\n```json\n{"pass": [1]}\n```')).toEqual({ pass: [1] });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
    // Seen live: a second object or a remark after the answer; braces inside strings do not count.
    expect(extractJson('{"note": "a {curly} remark", "keep": []}\n{"note": "corrected"}')).toEqual({ note: "a {curly} remark", keep: [] });
    expect(extractJson('{"text": "say \\"hi\\" }"} trailing')).toEqual({ text: 'say "hi" }' });
    expect(() => extractJson('{"text": "cut off')).toThrow(/not complete/);
  });

  it("keeps only real headline numbers from the screen", () => {
    expect(parseScreen('{"pass": [3, "1", 9, 0, 3], "note": "x"}', 4)).toEqual({ pass: [1, 3], note: "x" });
    expect(() => parseScreen('{"note": "x"}', 4)).toThrow(/pass/);
  });

  it("reads a decision: new stories, updates, keeps and the note", () => {
    const d = parseDecision(
      JSON.stringify({
        message: { text: " Hi ", stories: [{ headline: 1, card: "new", subject: "S", event: "E", status: "St" }, { headline: "2", card: "c_123456", changed: "C", status: "St2" }] },
        keep: [{ headline: 3, why: "w" }, { why: "no number" }],
        note: "n",
      }),
    );
    expect(d.message?.text).toBe("Hi");
    expect(d.message?.stories).toEqual([
      { headline: 1, card: "new", subject: "S", event: "E", status: "St" },
      { headline: 2, card: "c_123456", changed: "C", status: "St2" },
    ]);
    expect(d.keep).toEqual([{ headline: 3, why: "w" }]);
    expect(parseDecision('{"message": null, "keep": [], "note": "quiet"}').message).toBeNull();
  });

  it("measures how alike two headlines read, with numbers counting", () => {
    expect(headlineOverlap("Brann signs striker Ola Nordmann", "Brann signs striker Ola Nordmann from Molde")).toBeGreaterThan(0.7);
    expect(headlineOverlap("Brann won 2-1 against Molde", "Brann won 3-0 against Viking")).toBeLessThan(0.5);
    expect(headlineOverlap("", "anything")).toBe(0);
  });
});
