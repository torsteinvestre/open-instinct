// [sunshine:in-the-flow] Email and calendar read by code before a hand-off: what each search and day shows, "nothing
// found" told apart from "not looked at", the owner's midnights across daylight saving, bounds on size, and the
// Composio plugs' requests and answers.
import { describe, expect, it } from "vitest";
import { AuditLog, StateDir, defaultConfig } from "@open-instinct/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMAILS_PER_SEARCH, EVENTS_PER_SPAN, composioSources, createLookUp, midnightIn, parseSpan, plainText, weeksLine, type AppsRunner, type EmailHit, type EventHit, type LiveSources } from "../src/lookup.js";

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
    // Each search and day once (one email more than is shown, to know of a cut); the day from the owner's midnight to the next.
    expect(searched).toEqual([{ query: '"3 November" OR "Nov 3"', max: EMAILS_PER_SEARCH + 1 }, { query: "J. Cole", max: EMAILS_PER_SEARCH + 1 }]);
    expect(asked).toEqual([
      { from: "2026-11-03T00:00:00+01:00", to: "2026-11-04T00:00:00+01:00" },
      { from: "2026-11-12T00:00:00+01:00", to: "2026-11-13T00:00:00+01:00" },
    ]);
    expect(lookUps()).toEqual([{ lookUp: expect.objectContaining({ searches: 2, spans: 2, emails: 1, events: 1, failed: 0 }) }]);
  });

  it("over a span each event names its day; an all-day event says so; a span past a month is cut and says so", async () => {
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
    // "The concert in November" is asked as the whole month (2026-10-29) and read whole.
    await lookUp({ searches: [], days: ["2026-11-01/2026-11-30"] });
    expect(asked[1]).toEqual({ from: "2026-11-01T00:00:00+01:00", to: "2026-12-01T00:00:00+01:00" });
    const cut = await lookUp({ searches: [], days: ["2026-11-01/2026-12-31"] });
    expect(asked[2]).toEqual({ from: "2026-11-01T00:00:00+01:00", to: "2026-12-02T00:00:00+01:00" });
    expect(cut).toMatch(/^Calendar, Sun, 1 Nov 2026 to Tue, 1 Dec 2026 \(asked to Thu, 31 Dec 2026; the days after not looked at\):\n/);
  });

  it("says when more emails or events matched than are shown", async () => {
    const standup: EventHit = { title: "Standup", start: "2026-11-05T10:00:00+01:00" };
    const { lookUp } = setup({
      // "busy" fills what is asked for (one more than is shown); "exact" has just as many as are shown.
      searchEmail: async (query, max) => Array.from({ length: query === "busy" ? max : EMAILS_PER_SEARCH }, () => FOUNDERS),
      events: async (_from, _to, max) => Array.from({ length: max }, () => standup),
    });
    const text = (await lookUp({ searches: ["busy", "exact"], days: ["2026-11-02/2026-11-08"] }))!;
    expect(text).toContain(`(the newest ${EMAILS_PER_SEARCH} shown; older matches not looked at)`);
    expect(text.split("(the newest").length).toBe(2); // only for the search that had more
    expect(text).toContain(`(the first ${EVENTS_PER_SPAN} shown; later events from Thu, 5 Nov 2026 on not looked at)`);
    expect(text.split("\n").filter((l) => l.includes("Standup"))).toHaveLength(EVENTS_PER_SPAN);
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
    expect(parseSpan("2026-11-01/2026-11-30")).toEqual({ first: "2026-11-01", last: "2026-11-30" });
    expect(parseSpan("2026-11-01/2026-12-31")).toEqual({ first: "2026-11-01", last: "2026-12-01", askedLast: "2026-12-31" });
    for (const bad of ["next week", "2026-02-30", "2026-11-08/2026-11-02", "3 Nov", "2026-11-03/soon"]) expect(parseSpan(bad)).toBeUndefined();
  });

  it("starts each day at the owner's midnight, on both sides of a daylight-saving switch", () => {
    expect(midnightIn("2026-10-25", "Europe/Oslo")).toBe("2026-10-25T00:00:00+02:00"); // summer time ends at 03:00 that night
    expect(midnightIn("2026-10-26", "Europe/Oslo")).toBe("2026-10-26T00:00:00+01:00");
    expect(midnightIn("2026-03-29", "Europe/Oslo")).toBe("2026-03-29T00:00:00+01:00"); // summer time starts at 02:00
    expect(midnightIn("2026-11-01", "America/New_York")).toBe("2026-11-01T00:00:00-04:00");
    expect(midnightIn("2026-11-03", "UTC")).toBe("2026-11-03T00:00:00+00:00");
  });

  // [sunshine:grounding] The weeks a model is given, Monday to Sunday, by the owner's own day.
  it("names this week and next, Monday to Sunday, by the day in the owner's zone", () => {
    const week44 = "This week: Mon 26 Oct to Sun 1 Nov (2026-10-26/2026-11-01). Next week: Mon 2 Nov to Sun 8 Nov (2026-11-02/2026-11-08).";
    expect(weeksLine(new Date("2026-10-29T10:41:00Z"), "Europe/Oslo")).toBe(week44); // a Thursday
    expect(weeksLine(new Date("2026-10-26T00:30:00+01:00"), "Europe/Oslo")).toBe(week44); // Monday just after midnight
    expect(weeksLine(new Date("2026-11-01T22:30:00Z"), "Europe/Oslo")).toBe(week44); // Sunday 23:30 in Oslo
    expect(weeksLine(new Date("2026-11-01T23:30:00Z"), "Europe/Oslo")).toMatch(/^This week: Mon 2 Nov to Sun 8 Nov \(2026-11-02\/2026-11-08\)\. Next week: Mon 9 Nov/); // Monday 00:30 in Oslo, still Sunday in UTC
    expect(weeksLine(new Date("2026-12-31T12:00:00Z"), "UTC")).toBe("This week: Mon 28 Dec to Sun 3 Jan (2026-12-28/2027-01-03). Next week: Mon 4 Jan to Sun 10 Jan (2027-01-04/2027-01-10).");
  });
});

describe("look-up text", () => {
  it("decodes HTML entities and drops invisible padding, as seen in real Gmail snippets (2026-10-29)", () => {
    expect(plainText("See what&#39;s new &amp; how to manage your data ͏ ͏‌")).toBe("See what's new & how to manage your data  ");
    expect(plainText("&quot;Hi&quot; &lt;b&gt; &#x27;x&#x27; &nbsp;soft­hyphen")).toBe('"Hi" <b> \'x\'  softhyphen');
    expect(plainText("&unknown; &#0; 5 & 6")).toBe("&unknown; &#0; 5 & 6");
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
            { messageTimestamp: "not a date", sender: "a@b.no", subject: "Plain &amp; simple", preview: "it&#39;s plain͏" },
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
      { from: "a@b.no", subject: "Plain & simple", preview: "it's plain" },
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
