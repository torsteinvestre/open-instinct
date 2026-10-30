import { describe, expect, it } from "vitest";
import { appEventOf, decodeEvent, encodeEvent, intakeItemOf, isEnvelope, systemTaskOf } from "../src/envelope.js"; // [sunshine:flowing-in] appEventOf
import { EVENT_ENVELOPE_PREFIX } from "../src/types.js";

describe("envelope", () => {
  it("round-trips an event", () => {
    const event = {
      id: "evt_123",
      event_type: "imessage.received",
      data: { message: { id: "m1", conversation_id: "c1", content: "hi @@instinct-event@@ not a prefix", media: [] } },
    };
    const wire = encodeEvent(event);
    expect(wire.startsWith(EVENT_ENVELOPE_PREFIX)).toBe(true);
    expect(isEnvelope(wire)).toBe(true);
    expect(decodeEvent(wire)).toEqual(event);
  });

  it("returns undefined for plain text and broken payloads", () => {
    expect(decodeEvent("hello there")).toBeUndefined();
    expect(decodeEvent("")).toBeUndefined();
    expect(decodeEvent(EVENT_ENVELOPE_PREFIX)).toBeUndefined();
    expect(decodeEvent(EVENT_ENVELOPE_PREFIX + "{not json")).toBeUndefined();
    expect(decodeEvent("x" + EVENT_ENVELOPE_PREFIX + "{}")).toBeUndefined();
    expect(isEnvelope("plain")).toBe(false);
    // @ts-expect-error runtime guard for untyped callers
    expect(decodeEvent(undefined)).toBeUndefined();
  });

  it("tolerates leading whitespace and primitive payloads", () => {
    expect(decodeEvent("  " + encodeEvent({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeEvent(encodeEvent("text"))).toBe("text");
    expect(decodeEvent(encodeEvent(null))).toBeNull();
  });
});

describe("systemTaskOf", () => {
  it("accepts a well-formed task and rejects anything else", () => {
    expect(systemTaskOf({ type: "system.task", id: "conference-prepare", prompt: "Research the owner", name: "Prepare", quiet: true })).toEqual({
      type: "system.task",
      id: "conference-prepare",
      prompt: "Research the owner",
      name: "Prepare",
      quiet: true,
    });
    expect(systemTaskOf({ type: "system.task", id: "x", prompt: "go", quiet: "yes" })).toEqual({ type: "system.task", id: "x", prompt: "go" });
    expect(systemTaskOf({ type: "system.task", id: "bad id!", prompt: "go" })).toBeUndefined();
    expect(systemTaskOf({ type: "system.task", id: "x", prompt: "   " })).toBeUndefined();
    expect(systemTaskOf({ type: "imessage.received", id: "x", prompt: "go" })).toBeUndefined();
    expect(systemTaskOf("system.task")).toBeUndefined();
  });
});

// [sunshine:intake]
describe("intakeItemOf", () => {
  const ok = { type: "intake.item", id: "es2004b", source: "band", startedAt: "2026-10-24T08:14:00Z", text: "[00:07] Sarah: Hello." };
  it("accepts a well-formed item and rejects anything else", () => {
    expect(intakeItemOf({ ...ok, endedAt: "2026-10-24T08:53:00Z", title: " Design meeting ", people: ["Sarah", " ", 3, "Ian"] })).toEqual({
      ...ok,
      endedAt: "2026-10-24T08:53:00Z",
      title: "Design meeting",
      people: ["Sarah", "Ian"],
    });
    expect(intakeItemOf({ ...ok, source: "BAND", endedAt: "soon" })).toEqual(ok);
    expect(intakeItemOf({ ...ok, id: "bad id!" })).toBeUndefined();
    expect(intakeItemOf({ ...ok, source: "a source" })).toBeUndefined();
    expect(intakeItemOf({ ...ok, startedAt: "yesterday" })).toBeUndefined();
    expect(intakeItemOf({ ...ok, text: "  " })).toBeUndefined();
    expect(intakeItemOf({ ...ok, type: "system.task" })).toBeUndefined();
  });
});

// [sunshine:flowing-in]
describe("appEventOf", () => {
  const ok = { type: "app.event", id: "trg_evt_01.x:1", trigger: "GMAIL_NEW_GMAIL_MESSAGE", data: { id: "1a18c46d9465ea0f" } };
  it("accepts an app event with its fields and rejects anything else", () => {
    expect(appEventOf({ ...ok, at: "2026-10-30T09:00:00Z" })).toEqual({ ...ok, at: "2026-10-30T09:00:00Z" });
    expect(appEventOf({ ...ok, trigger: "gmail_new_gmail_message", at: "soon" })).toEqual(ok);
    expect(appEventOf({ ...ok, id: "bad id!" })).toBeUndefined();
    expect(appEventOf({ ...ok, trigger: "GMAIL NEW" })).toBeUndefined();
    expect(appEventOf({ ...ok, data: [1] })).toBeUndefined();
    expect(appEventOf({ ...ok, data: undefined })).toBeUndefined();
    expect(appEventOf({ ...ok, type: "intake.item" })).toBeUndefined();
  });
});
