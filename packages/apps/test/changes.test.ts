// [sunshine:action-log] Which app actions in a tool call change something, for the action log.
import { describe, expect, it } from "vitest";
import { appChangesOf, isReadSlug, toolNameFor } from "../src/index.js";

describe("appChangesOf", () => {
  it("names the changing actions of a direct tool and of each one the multi-executor runs; reads and other tools are none", () => {
    expect(appChangesOf(toolNameFor("GOOGLECALENDAR_CREATE_EVENT"), { summary: "x" })).toEqual(["GOOGLECALENDAR_CREATE_EVENT"]);
    expect(appChangesOf(toolNameFor("GMAIL_FETCH_EMAILS"), {})).toEqual([]);
    expect(
      appChangesOf(toolNameFor("COMPOSIO_MULTI_EXECUTE_TOOL"), {
        tools: [
          { tool_slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
          { tool_slug: "googlecalendar_create_event", arguments: {} },
          { tool_slug: "GMAIL_SEND_EMAIL", arguments: {} },
          { tool_slug: "COMPOSIO_SEARCH_TOOLS", arguments: {} },
        ],
      }),
    ).toEqual(["GOOGLECALENDAR_CREATE_EVENT", "GMAIL_SEND_EMAIL"]);
    expect(appChangesOf(toolNameFor("COMPOSIO_MULTI_EXECUTE_TOOL"), { tools: "nope" })).toEqual([]);
    expect(appChangesOf("history_search", { query: "x" })).toEqual([]);
  });

  it("tells reads by their verb", () => {
    for (const s of ["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GMAIL_GET_PROFILE", "GOOGLECALENDAR_FREE_BUSY_QUERY"]) expect(isReadSlug(s), s).toBe(true);
    for (const s of ["GOOGLECALENDAR_CREATE_EVENT", "GMAIL_SEND_EMAIL", "GOOGLECALENDAR_QUICK_ADD", "NOTION_CREATE_PAGE"]) expect(isReadSlug(s), s).toBe(false);
  });
});
