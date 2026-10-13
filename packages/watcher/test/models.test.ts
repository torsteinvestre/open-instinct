// [sunshine:watcher]
import { describe, expect, it } from "vitest";
import { DEFAULT_DECIDE_MODEL, DEFAULT_SCREEN_MODEL, resolveWatcherModel, stepModelSpec } from "../src/models.js";

describe("the two model steps", () => {
  it("default to Haiku 5.5 for screening and Sonnet 5.5 for deciding; 'off' switches a step off", () => {
    expect(DEFAULT_SCREEN_MODEL).toBe("anthropic/claude-haiku-5-5");
    expect(DEFAULT_DECIDE_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(stepModelSpec(undefined, DEFAULT_SCREEN_MODEL)).toBe(DEFAULT_SCREEN_MODEL);
    expect(stepModelSpec(" OFF ", DEFAULT_SCREEN_MODEL)).toBeUndefined();
    expect(stepModelSpec("anthropic/claude-opus-5-5", DEFAULT_DECIDE_MODEL)).toBe("anthropic/claude-opus-5-5");
  });

  it("knows Claude Haiku 5.5 even though Pi's catalog does not list it yet, with Haiku's own prices", () => {
    const haiku = resolveWatcherModel("anthropic/claude-haiku-5-5");
    expect(haiku).toMatchObject({ id: "claude-haiku-5-5", provider: "anthropic", api: "anthropic-messages", cost: { input: 0.1, output: 0.5 } });
    expect(resolveWatcherModel("anthropic/claude-sonnet-5-5")).toMatchObject({ id: "claude-sonnet-5-5", cost: { input: 2, output: 10 } });
    expect(() => resolveWatcherModel("anthropic/claude-nonexistent")).toThrow(/no model/);
  });
});
