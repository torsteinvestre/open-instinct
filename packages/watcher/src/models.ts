/**
 * [sunshine:watcher] The two model steps of a news check, as plain calls through Pi (the same
 * model layer the agent uses). Step 1 screens cheaply (Claude Haiku 5.5 when switched on); step 2
 * decides (default Claude Sonnet 5.5). Each is a setting, and "off" switches a step off:
 *   WATCHER_SCREEN_MODEL unset or off -> every short-listed headline goes to step 2 (the default
 *                                         since 2026-10-15); set to a model -> that model screens
 *   WATCHER_DECIDE_MODEL=off  -> step 1's verdict is final, decided by the same model (Haiku only)
 */
import { completeSimple, type Model, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { resolveModel } from "@open-instinct/core";

export const DEFAULT_SCREEN_MODEL = "anthropic/claude-haiku-5-5";
export const DEFAULT_DECIDE_MODEL = "anthropic/claude-sonnet-5-5";
/**
 * Step 3, the writer: the text as the agent itself. Sonnet, tested against Haiku: Haiku explained
 * itself ("this is what he wanted flagged"), forced links and hedged; about 0.4 cents per text sent.
 * WATCHER_WRITE_MODEL=off sends the decision's own text, as before.
 */
export const DEFAULT_WRITE_MODEL = "anthropic/claude-sonnet-5-5";

export interface ModelReply {
  text: string;
  costUsd: number;
  model: string;
}

export type ModelCall = (req: { system: string; user: string; signal?: AbortSignal }) => Promise<ModelReply>;

/**
 * A model spec as the rest of Sunshine reads it, plus Claude Haiku 5.5, which Pi 1.0.1's catalog
 * does not list yet. It is described from Sonnet 5.5's entry (same API and features) with Haiku's
 * own prices ($0.10 / $0.50 per million tokens). Delete this branch once Pi knows the model.
 */
export function resolveWatcherModel(spec: string, env: NodeJS.ProcessEnv = {}): Model<any> {
  try {
    return resolveModel(spec, env);
  } catch (err) {
    if (spec.trim() !== "anthropic/claude-haiku-5-5") throw err;
    const template = resolveModel("anthropic/claude-sonnet-5-5", env);
    return { ...template, id: "claude-haiku-5-5", name: "Claude Haiku 5.5", cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } };
  }
}

/**
 * A single call: system instructions plus one user message in, the reply's text out.
 * [sunshine:watcher] No prompt caching by default: Pi caches every call for 5 minutes, and storing
 * costs 25% more than sending. Checks run an hour apart, so the copy was never read again: measured,
 * a decide-sized call paid 0.46 of its 0.56 cents for storing. A 1-hour cache costs double to store
 * and, an hour apart, would miss about half the time, so it is not worth it either.
 */
export function modelCall(model: Model<any>, opts: { apiKey?: string; reasoning?: ThinkingLevel; cacheRetention?: "none" | "short" | "long" } = {}): ModelCall {
  return async ({ system, user, signal }) => {
    const reply = await completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.reasoning ? { reasoning: opts.reasoning } : {}), cacheRetention: opts.cacheRetention ?? "none", ...(signal ? { signal } : {}) },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`${model.id}: ${reply.errorMessage ?? reply.stopReason}`);
    const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    return { text, costUsd: reply.usage?.cost?.total ?? 0, model: model.id };
  };
}

/** The setting's value, or undefined when the step is switched off. */
export function stepModelSpec(value: string | undefined, fallback: string): string | undefined {
  const v = value?.trim();
  if (!v) return fallback;
  return v.toLowerCase() === "off" ? undefined : v;
}
