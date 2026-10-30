// [sunshine:acting] The owner's one rule for how Sunshine acts: the same section in every conversation of theirs, the
// setting filled in by code, nobody else's prompt carrying it; and the setting itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateDir, defaultConfig, type Principal } from "@open-instinct/core";
import { PROACTIVITY_LEVELS, actingPromptFor, actingSection, proactivityTool, readProactivity } from "../src/acting.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function state(): StateDir {
  const dir = mkdtempSync(join(tmpdir(), "acting-"));
  dirs.push(dir);
  const s = new StateDir(dir);
  s.ensure();
  return s;
}

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maya" };
// Email from the owner's own address: unverified, so tier partner (prompt.ts).
const ownerByEmail: Principal = { kind: "owner", id: "owner", tier: "partner", displayName: "Maya" };
const friend: Principal = { kind: "contact", id: "contact:sam", tier: "friend", displayName: "Sam" };

describe("[sunshine:acting] how Sunshine acts for the owner", () => {
  it("holds the same criteria at every level, with the level's own line", () => {
    for (const level of PROACTIVITY_LEVELS) {
      const s = actingSection("Maya", level);
      expect(s).toMatch(/^# How you act for Maya\n/);
      expect(s).toContain("The same in everything you do for Maya: their messages, what reaches you from elsewhere (recordings, email, other tools) and your scheduled work.");
      expect(s).toContain("- Find out before you ask.");
      expect(s).toContain("check how things stand before you change them");
      expect(s).toContain("Ask only what is still unclear after that, all in one message.");
      expect(s).toContain("how clearly it is Maya's and what they want, what a mistake would cost them, and whether it can be undone");
      expect(s).toContain(`- Maya's setting is "${level}".`);
      expect(s).toContain("act on it only when it is clearly Maya's");
      expect(s).toContain("- Anything that goes to other people, costs money or speaks for Maya: ask first, whatever the setting.");
      expect(s).toContain("tell Maya only what is worth their attention");
    }
    expect(actingSection("Maya", "ask first")).toContain("Ask before you do anything for Maya: gather what you know and can find, then ask in one message");
    expect(actingSection("Maya", "prepare and offer")).toContain("Do what is clearly Maya's and easy to undo (their own calendar, a reminder) and tell them in one line what you did.");
    expect(actingSection("Maya", "just do it")).toContain("offer first only a big piece of work they may not want");
  });

  it("names no channel, source or tool as the only place it applies", () => {
    // Written to hold for sources and tools still to come (Torstein, 2026-10-30): no "text", "recording" or tool name as its scope.
    const s = actingSection("Maya", "prepare and offer");
    expect(s).not.toMatch(/\bin one text\b|\bthis recording\b|\bNO_REPLY\b|\bhistory_search\b|\bschedule_create\b/);
  });

  it("goes to the owner's own conversations only, with the setting read at the time", () => {
    let level: (typeof PROACTIVITY_LEVELS)[number] = "prepare and offer";
    const read = () => level;
    expect(actingPromptFor(owner, "Maya", read)).toEqual([actingSection("Maya", "prepare and offer")]);
    level = "just do it";
    expect(actingPromptFor(owner, "Maya", read)).toEqual([actingSection("Maya", "just do it")]);
    expect(actingPromptFor(ownerByEmail, "Maya", read)).toEqual([]);
    expect(actingPromptFor(friend, "Maya", read)).toEqual([]);
  });

  it("is the same text for the same setting, so the prompt stays the same between messages", () => {
    expect(actingSection("Maya", "prepare and offer")).toBe(actingSection("Maya", "prepare and offer"));
  });

  it("the owner sets how much is done on its own; the default is to prepare and offer", async () => {
    const s = state();
    const config = defaultConfig();
    config.owner = { ...config.owner, name: "Maya" };
    expect(readProactivity(s)).toBe("prepare and offer");
    const tool = proactivityTool(s, config);
    expect(tool.spec.description).toContain("in everything you do for them");
    const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("");
    const ctx = {} as never;
    expect(text(await tool.spec.execute({ level: "just do it" }, ctx))).toBe("Set: just do it.");
    expect(readProactivity(s)).toBe("just do it");
    expect(text(await tool.spec.execute({}, ctx))).toBe("Now: just do it.");
    s.writeJson("proactivity.json", { level: "whatever" });
    expect(readProactivity(s)).toBe("prepare and offer");
  });
});
