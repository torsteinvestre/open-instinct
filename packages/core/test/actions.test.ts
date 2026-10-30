// [sunshine:action-log] What Sunshine did in the owner's apps, written by code, and the ids found in an app's answer.
import { describe, expect, it } from "vitest";
import { ACTIONS_FILE, ActionLog, idsIn } from "../src/actions.js";
import { tempState } from "./helpers.js";

const T = Date.parse("2026-10-30T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("ActionLog", () => {
  it("appends, reads back from a time on, and finds Sunshine's own successful change by an id", () => {
    const state = tempState();
    let now = T;
    const log = new ActionLog(state, { now: () => now });
    log.append({ conversationKey: "chat:main", tool: "app_googlecalendar_create_event", actions: ["GOOGLECALENDAR_CREATE_EVENT"], ok: true, ids: ["ev123"] });
    now = T + 60_000;
    log.append({ conversationKey: "chat:main", tool: "app_gmail_send_email", actions: ["GMAIL_SEND_EMAIL"], ok: false, ids: [] });
    log.append({ at: T - 400 * DAY, conversationKey: "chat:main", tool: "app_x", actions: ["X_CREATE"], ok: true, ids: ["old"] });
    state.appendLine(ACTIONS_FILE, "{torn");

    expect(log.since(0).map((e) => e.tool)).toEqual(["app_googlecalendar_create_event", "app_gmail_send_email"]);
    expect(log.since(T + 1).map((e) => e.tool)).toEqual(["app_gmail_send_email"]);
    expect(log.did("ev123", T - 30 * 60_000)).toMatchObject({ tool: "app_googlecalendar_create_event", at: T });
    expect(log.did("ev123", T + 1)).toBeUndefined();
    expect(log.did("old", 0)).toBeUndefined(); // past the age limit
    expect(log.did("", 0)).toBeUndefined();
  });
});

describe("idsIn", () => {
  it("finds ids at any depth, in JSON text too, and leaves other values alone", () => {
    const answer = [
      { type: "text", text: JSON.stringify({ successful: true, data: { results: [{ response: { data: { id: "ev123", htmlLink: "https://x", summary: "Founders" } } }] } }) },
    ];
    expect(idsIn(answer)).toEqual(["ev123"]);
    expect(idsIn({ messageId: "18c46d9465ea", thread_id: "18c46d946000", labelIDs: "x", id: 4242, name: "abcdef", tiny_id: "ab" })).toEqual(["18c46d9465ea", "18c46d946000", "4242"]);
    expect(idsIn("not json")).toEqual([]);
    expect(idsIn(undefined)).toEqual([]);
  });
});
