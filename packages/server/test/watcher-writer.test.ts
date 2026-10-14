// [sunshine:watcher] What the news writer is given from the agent's own files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, StateDir, defaultConfig, writeSession } from "@open-instinct/core";
import { ownerThread, writerContextFor } from "../src/watcher-writer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "writer-ctx-"));
  dirs.push(dir);
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  return { state, config };
}

const at = (iso: string) => Date.parse(iso);
const asst = (text: string, ts: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: ts }) as never;
const user = (text: string, ts: number) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts }) as never;

describe("the end of the owner's thread, for the writer", () => {
  it("is plain lines with time and speaker: stamps dropped, notes marked, summaries and tool calls left out", () => {
    const { state, config } = setup();
    state.writeJson("owner-route.json", { conversationKey: "imessage:c1", channel: "imessage" });
    writeSession(join(state.path("sessions"), `${encodeURIComponent("imessage:c1")}.jsonl`), [
      user("[Conversation summary] 5 earlier messages were trimmed", at("2026-10-14T10:00:00Z")),
      user("[Wed 14 Oct 2026, 14:58 Europe/Oslo, UTC+02:00]\nRemind me in 3 minutes to stretch", at("2026-10-14T12:58:00Z")),
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "schedule_create", arguments: {} }], timestamp: at("2026-10-14T12:58:01Z") } as never,
      asst("Done. I'll remind you at 15:01.", at("2026-10-14T12:58:02Z")),
      user("[Wed 14 Oct 2026, 15:01 Europe/Oslo, UTC+02:00]\n[Not a message from Torstein: a note that you texted them the next message when \"stretch\" came due.]", at("2026-10-14T13:01:00Z")),
      asst("Time to stretch.", at("2026-10-14T13:01:00Z")),
      user("[Wed 14 Oct 2026, 15:02 Europe/Oslo, UTC+02:00]\nThanks", at("2026-10-14T13:02:00Z")),
    ]);
    expect(ownerThread(state, config).split("\n")).toEqual([
      "[Wed 14 Oct, 14:58] Torstein: Remind me in 3 minutes to stretch",
      "[Wed 14 Oct, 14:58] Sunshine: Done. I'll remind you at 15:01.",
      '[Wed 14 Oct, 15:01] (note): [Not a message from Torstein: a note that you texted them the next message when "stretch" came due.]',
      "[Wed 14 Oct, 15:01] Sunshine: Time to stretch.",
      "[Wed 14 Oct, 15:02] Torstein: Thanks",
    ]);
    expect(ownerThread(state, config, 2).split("\n")).toHaveLength(2); // only the newest
  });

  it("is empty before the owner has written, and the context still has a persona", () => {
    const { state, config } = setup();
    expect(ownerThread(state, config)).toBe("");
    const memory = new MemoryStore(state);
    memory.writeDurable?.("Runs on Sundays.");
    const ctx = writerContextFor({ state, memory, config })();
    expect(ctx.thread).toBe("");
    expect(ctx.persona.length).toBeGreaterThan(0);
  });
});
