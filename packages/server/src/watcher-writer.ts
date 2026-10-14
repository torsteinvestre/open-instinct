/**
 * [sunshine:watcher] What the news writer (step 3 of a check) gets from the agent: its persona, its
 * memory of the owner, the end of the owner's thread, and the agent's own web search. The writer
 * then texts as the agent would, instead of from the headline alone.
 */
import { join } from "node:path";
import { DEFAULT_PERSONA, readPersona, readSession, type InstinctConfig, type MemoryStore, type Principal, type StateDir, type ToolRegistry } from "@open-instinct/core";
import type { WriterContext } from "@open-instinct/watcher";

/** Messages from the end of the owner's thread the writer sees. */
export const WRITER_THREAD_MESSAGES = 10;
const MEMORY_MAX_CHARS = 3000;
const LINE_MAX_CHARS = 300;

export function writerContextFor(deps: { state: StateDir; memory: MemoryStore; config: InstinctConfig }): () => WriterContext {
  return () => ({
    persona: readPersona(deps.state) ?? DEFAULT_PERSONA,
    memory: deps.memory.readDurable().trim().slice(0, MEMORY_MAX_CHARS),
    thread: ownerThread(deps.state, deps.config),
  });
}

/** The end of the owner's own thread as plain lines, newest last; empty when there is none yet. */
export function ownerThread(state: StateDir, config: InstinctConfig, max = WRITER_THREAD_MESSAGES): string {
  const route = state.readJson<{ conversationKey?: unknown }>("owner-route.json", {});
  if (typeof route.conversationKey !== "string") return "";
  const tz = config.owner.timezone || "UTC";
  const lines: string[] = [];
  for (const m of readSession(join(state.path("sessions"), `${encodeURIComponent(route.conversationKey)}.jsonl`))) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const raw = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    // Drop the time stamp line the runtime puts in front of each message; the line carries the time.
    const text = raw.replace(/^\[[^\]\n]*\]\n/, "").trim();
    if (!text || text.startsWith("[Conversation summary]")) continue;
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(m.timestamp));
    const who = m.role === "assistant" ? config.agent.name : text.startsWith("[Not a message from") ? "(note)" : config.owner.name;
    lines.push(`[${when}] ${who}: ${text.replace(/\s+/g, " ").slice(0, LINE_MAX_CHARS)}`);
  }
  return lines.slice(-max).join("\n");
}

/** The agent's own web_search tool as the writer's research: one query in, results as text out. */
export function researchWith(registry: ToolRegistry, config: InstinctConfig): ((query: string, signal?: AbortSignal) => Promise<string>) | undefined {
  const tool = registry.get("web_search");
  if (!tool) return undefined;
  const principal: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: config.owner.name };
  return async (query, signal) => {
    const r = await tool.spec.execute({ query }, { principal, conversationKey: "scheduled:watcher", channel: "scheduled", now: () => new Date() }, signal);
    return typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  };
}
