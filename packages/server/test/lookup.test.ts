// [sunshine:in-the-flow] Email and calendar read by code before a hand-off: what each search and day shows, "nothing
// found" told apart from "not looked at", the owner's midnights across daylight saving, bounds on size, and the
// Composio plugs' requests and answers.
import { describe, expect, it } from "vitest";
import { AuditLog, StateDir, defaultConfig } from "@open-instinct/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMAILS_PER_SEARCH, composioSources, createLookUp, midnightIn, parseSpan, type AppsRunner, type EmailHit, type EventHit, type LiveSources } from "../src/lookup.js";

const FOUNDERS: EmailHit = { at: Date.parse("2026-10-17T09:12:00Z"), from: "Oslo Startup Lab <hello@oslostartuplab.no>", subject: "You're on the guestlist for Founders Story Oslo", preview: "See you Tuesday 3 November at 18:00, Startup Lab, Gaustadalleen 21." };
const JCOLE: EventHit = { title: "J. Cole: The Fall-Off Tour", start: "2026-11-12T19:00:00+01:00", end: "2026-11-12T22:00:00+01:00", location: "Unity Arena" };

function setup(sources: LiveSources, waitMs?: number) {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "lookup-")));
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const audit = new AuditLog(state);
  const lookUps = () => audit.read().map((e) => e.detail).filter((d) => d && "lookUp" in d) as Array<Record<string, unknown>>;
  return { lookUp: createLookUp({ sources, config, audit, ...(waitMs ? { waitMs } : {}) }), lookUps };
}

describe("look-up", () => {
  it("shows what each email search and each day's calendar holds, nothing found included", async () => {
    const searched: Array<{ query: string; max: number }> = [];
    const asked: Array<{ from: string; to: string }> = [];
    const { lookUp, lookUps } = setup({
      searchEmail: async (query, max) => (searched.push({ query, max }), query.includes("November") ? [FOUNDERS] : []),
      events: async (from, to) => (asked.push({ from, to }), from.startsWith("2026-11-12") ? [JCOLE] : []),
    });
    const text = await lookUp({ searches: ['"3 November" OR "Nov 3"', "J. Cole", " J. Cole "], days: ["2026-11-03", "2026-11-12", "2026-11-03"] });
    expect(text).toBe(
      [
        'Email, searched for "3 November" OR "Nov 3":',
        "- Sat, 17 Oct 2026, from Oslo Startup Lab <hello@oslostartuplab.no>: You're on the guestlist for Founders Story Oslo | See you Tuesday 3 November at 18:00, Startup Lab, Gaustadalleen 21.",
        "Email, searched for J. Cole: nothing found.",
        "Calendar, Tue, 3 Nov 2026: nothing in the calendar.",
        "Calendar, Thu, 12 Nov 2026:",
        "- 19:00-22:00 J. Cole: The Fall-Off Tour (Unity Arena)",
      ].join("\n"),
    );
    // Each search and day once; the day from the owner's midnight to the next.
    expect(searched).toEqual([{ query: '"3 November" OR "Nov 3"', max: EMAILS_PER_SEARCH }, { query: "J. Cole", max: EMAILS_PER_SEARCH }]);
    expect(asked).toEqual([
      { from: "2026-11-03T00:00:00+01:00", to: "2026-11-04T00:00:00+01:00" },
      { from: "2026-11-12T00:00:00+01:00", to: "2026-11-13T00:00:00+01:00" },
    ]);
    expect(lookUps()).toEqual([{ lookUp: expect.objectContaining({ searches: 2, spans: 2, emails: 1, events: 1, failed: 0 }) }]);
  });

  it("over a span each event names its day; an all-day event says so; a span past two weeks is cut", async () => {
    const asked: Array<{ from: string; to: string }> = [];
    const { lookUp } = setup({
      events: async (from, to) => {
        asked.push({ from, to });
        return [
          { title: "Standup", start: "2026-11-05T10:00:00+01:00", end: "2026-11-05T10:15:00+01:00" },
          { title: "Founders' day", start: "2026-11-06", end: "2026-11-07" },
        ];
      },
    });
    expect(await lookUp({ searches: [], days: ["2026-11-02/2026-11-08"] })).toBe(
      ["Calendar, Mon, 2 Nov 2026 to Sun, 8 Nov 2026:", "- Thu, 5 Nov 2026 10:00-10:15 Standup", "- Fri, 6 Nov 2026 all day Founders' day"].join("\n"),
    );
    await lookUp({ searches: [], days: ["2026-11-01/2026-12-31"] });
    expect(asked[1]).toEqual({ from: "2026-11-01T00:00:00+01:00", to: "2026-11-15T00:00:00+01:00" });
  });

  it("tells a failed or slow source apart from nothing found, and still shows the rest", async () => {
    const { lookUp, lookUps } = setup(
      {
        searchEmail: async (query) => {
          if (query === "broken") throw new Error("401");
          if (query === "slow") return new Promise<EmailHit[]>(() => {});
          return [FOUNDERS];
        },
        events: async () => {
          throw new Error("calendar down");
        },
      },
      20,
    );
    const text = await lookUp({ searches: ["broken", "slow", "Founders"], days: ["2026-11-03"] });
    expect(text).toContain("Email, searched for broken: the search did not work just now (not looked at).");
    expect(text).toContain("Email, searched for slow: the search did not work just now (not looked at).");
    expect(text).toContain("Email, searched for Founders:\n- Sat, 17 Oct 2026, from Oslo Startup Lab");
    expect(text).toContain("Calendar, Tue, 3 Nov 2026: the calendar could not be read just now (not looked at).");
    expect(lookUps()[0]).toMatchObject({ lookUp: { failed: 3, emails: 1 } });
  });

  it("looks up nothing when nothing was asked or no source can answer it", async () => {
    let calls = 0;
    const count = async () => (calls++, []);
    expect(await setup({ searchEmail: count, events: count }).lookUp({ searches: [" "], days: ["next week", "2026-02-30"] })).toBeUndefined();
    expect(await setup({ events: count }).lookUp({ searches: ["J. Cole"], days: [] })).toBeUndefined();
    expect(await setup({}).lookUp({ searches: ["J. Cole"], days: ["2026-11-03"] })).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("keeps what it shows bounded, cutting at a whole line", async () => {
    const long: EmailHit = { ...FOUNDERS, subject: "S".repeat(500), preview: "P".repeat(2_000) };
    const { lookUp } = setup({ searchEmail: async () => Array.from({ length: 50 }, () => long) });
    const text = (await lookUp({ searches: Array.from({ length: 20 }, (_, i) => `q${i}`), days: [] }))!;
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toMatch(/\n\(more left out; search again for the rest\)$/);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).not.toHaveLength(0);
    // Subject and preview clipped.
    expect(text.split("\n")[1]).toContain(`${"S".repeat(139)}… | ${"P".repeat(299)}…`);
  });
});

describe("look-up dates", () => {
  it("reads one day or a span, and nothing that is not a real date", () => {
    expect(parseSpan("2026-11-03")).toEqual({ first: "2026-11-03", last: "2026-11-03" });
    expect(parseSpan(" 2026-11-02/2026-11-08 ")).toEqual({ first: "2026-11-02", last: "2026-11-08" });
    for (const bad of ["next week", "2026-02-30", "2026-11-08/2026-11-02", "3 Nov", "2026-11-03/soon"]) expect(parseSpan(bad)).toBeUndefined();
  });

  it("starts each day at the owner's midnight, on both sides of a daylight-saving switch", () => {
    expect(midnightIn("2026-10-25", "Europe/Oslo")).toBe("2026-10-25T00:00:00+02:00"); // summer time ends at 03:00 that night
    expect(midnightIn("2026-10-26", "Europe/Oslo")).toBe("2026-10-26T00:00:00+01:00");
    expect(midnightIn("2026-03-29", "Europe/Oslo")).toBe("2026-03-29T00:00:00+01:00"); // summer time starts at 02:00
    expect(midnightIn("2026-11-01", "America/New_York")).toBe("2026-11-01T00:00:00-04:00");
    expect(midnightIn("2026-11-03", "UTC")).toBe("2026-11-03T00:00:00+00:00");
  });
});

describe("look-up through Composio", () => {
  function runner(answers: Record<string, { data: Record<string, unknown>; error: string | null }>, toolkits = ["gmail", "googlecalendar"], allToolkits = false) {
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const apps: AppsRunner = {
      toolkitSlugs: toolkits,
      allToolkits,
      execute: async (slug, args) => (calls.push({ slug, args }), answers[slug] ?? { data: {}, error: null }),
    };
    return { apps, calls };
  }

  it("searches Gmail without promotions and reads the messages Composio returns", async () => {
    const { apps, calls } = runner({
      GMAIL_FETCH_EMAILS: {
        data: {
          messages: [
            { messageTimestamp: "2026-10-17T09:12:00Z", sender: "Oslo Startup Lab <hello@oslostartuplab.no>", subject: "Guestlist", preview: { body: "See you 3 November", subject: "Guestlist" } },
            { messageTimestamp: "not a date", sender: "a@b.no", subject: "Plain", preview: "plain preview" },
            { sender: "c@d.no", subject: "Text only", messageText: "the text" },
          ],
          resultSizeEstimate: 3,
        },
        error: null,
      },
    });
    const hits = await composioSources(apps, () => "Europe/Oslo").searchEmail!('"3 November" OR "Nov 3"', 5);
    expect(calls).toEqual([{ slug: "GMAIL_FETCH_EMAILS", args: { query: '("3 November" OR "Nov 3") -category:promotions', max_results: 5, include_payload: false, verbose: false } }]);
    expect(hits).toEqual([
      { at: Date.parse("2026-10-17T09:12:00Z"), from: "Oslo Startup Lab <hello@oslostartuplab.no>", subject: "Guestlist", preview: "See you 3 November" },
      { from: "a@b.no", subject: "Plain", preview: "plain preview" },
      { from: "c@d.no", subject: "Text only", preview: "the text" },
    ]);
  });

  it("lists the primary calendar's events in the owner's zone, leaving out cancelled ones", async () => {
    const { apps, calls } = runner({
      GOOGLECALENDAR_EVENTS_LIST: {
        data: {
          items: [
            { summary: "J. Cole: The Fall-Off Tour", start: { dateTime: "2026-11-12T19:00:00+01:00" }, end: { dateTime: "2026-11-12T22:00:00+01:00" }, location: "Unity Arena" },
            { summary: "Cancelled thing", status: "cancelled", start: { dateTime: "2026-11-12T08:00:00+01:00" } },
            { summary: "Holiday", start: { date: "2026-11-12" }, end: { date: "2026-11-13" } },
          ],
        },
        error: null,
      },
    });
    const events = await composioSources(apps, () => "Europe/Oslo").events!("2026-11-12T00:00:00+01:00", "2026-11-13T00:00:00+01:00", 25);
    expect(calls).toEqual([
      { slug: "GOOGLECALENDAR_EVENTS_LIST", args: { calendarId: "primary", timeMin: "2026-11-12T00:00:00+01:00", timeMax: "2026-11-13T00:00:00+01:00", timeZone: "Europe/Oslo", singleEvents: true, orderBy: "startTime", maxResults: 25 } },
    ]);
    expect(events).toEqual([JCOLE, { title: "Holiday", start: "2026-11-12", end: "2026-11-13" }]);
  });

  it("turns Composio's error into a failed source, and plugs in only the toolkits the agent has", async () => {
    const { apps } = runner({ GMAIL_FETCH_EMAILS: { data: {}, error: "Connection not found" } });
    await expect(composioSources(apps, () => "UTC").searchEmail!("x", 5)).rejects.toThrow("Connection not found");
    expect(Object.keys(composioSources(runner({}, ["googlecalendar"]).apps, () => "UTC"))).toEqual(["events"]);
    expect(Object.keys(composioSources(runner({}, ["googlecontacts"]).apps, () => "UTC"))).toEqual([]);
    expect(Object.keys(composioSources(runner({}, ["*"], true).apps, () => "UTC")).sort()).toEqual(["events", "searchEmail"]);
  });
});
