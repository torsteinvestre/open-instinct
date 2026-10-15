// [sunshine:watcher]
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DECIDE_MODEL, DEFAULT_SCREEN_MODEL, DEFAULT_WRITE_MODEL, modelCall, resolveWatcherModel, stepModelSpec } from "../src/models.js";

vi.mock("@earendil-works/pi-ai/compat", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-ai/compat")>()),
  completeSimple: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], usage: { cost: { total: 0.001 } }, stopReason: "stop" })),
}));

describe("a model call", () => {
  // Storing in the cache costs 25% more than sending, and checks an hour apart never read it back.
  it("asks for no prompt caching unless told otherwise", async () => {
    const model = resolveWatcherModel(DEFAULT_DECIDE_MODEL);
    expect(await modelCall(model)({ system: "s", user: "u" })).toEqual({ text: "ok", costUsd: 0.001, model: "claude-sonnet-5-5" });
    await modelCall(model, { cacheRetention: "long" })({ system: "s", user: "u" });
    const options = vi.mocked(completeSimple).mock.calls.map((c) => c[2]);
    expect(options[0]).toMatchObject({ cacheRetention: "none" });
    expect(options[1]).toMatchObject({ cacheRetention: "long" });
  });
});

describe("the two model steps", () => {
  it("default to Haiku 5.5 for screening and Sonnet 5.5 for deciding; 'off' switches a step off", () => {
    expect(DEFAULT_SCREEN_MODEL).toBe("anthropic/claude-haiku-5-5");
    expect(DEFAULT_DECIDE_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(DEFAULT_WRITE_MODEL).toBe("anthropic/claude-sonnet-5-5");
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
