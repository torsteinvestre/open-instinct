// [sunshine:flowing-in] What happens in the owner's apps, as Composio's triggers report it, becoming items: each source's
// small rule (what counts, what is stripped) and the shared ones (no catch-up, once, Sunshine's own, the owner's own).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionLog, AuditLog, ItemArchive, StateDir, defaultConfig, type AppEvent } from "@open-instinct/core";
import { BODY_MAX, TRIGGERS, createFlowIn, emailBody, parseAddresses, parseTime } from "../src/flowing-in.js";
import type { IntakeItem } from "../src/intake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = Date.parse("2026-10-30T09:00:00Z"); // Fri 30 Oct, 10:00 in Oslo
const MIN = 60_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "flow-in-"));
  dirs.push(dir);
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Maya", timezone: "Europe/Oslo", emails: ["maya@example.com"] };
  config.agent = { ...config.agent, name: "Sunshine" };
  let now = T;
  const items = new ItemArchive(state, { now: () => new Date(now) });
  const audit = new AuditLog(state);
  const actions = new ActionLog(state, { now: () => now });
  const taken: Array<{ item: IntakeItem; keepOnly?: string }> = [];
  const intake = {
    receive: async (item: IntakeItem, opts: { keepOnly?: string } = {}) => {
      items.add(item);
      taken.push({ item, ...(opts.keepOnly ? { keepOnly: opts.keepOnly } : {}) });
      return { outcome: opts.keepOnly ? ("kept as is" as const) : ("handed over" as const), costUsd: 0 };
    },
  };
  const flow = createFlowIn({ intake, items, state, config, audit, actions, now: () => now });
  const audits = () => audit.read().map((e) => e.detail).filter((d) => d && "flowIn" in d) as Array<Record<string, unknown>>;
  return { flow, taken, items, actions, audits, setNow: (ms: number) => (now = ms) };
}

let n = 0;
const event = (trigger: string, data: Record<string, unknown>): AppEvent => ({ type: "app.event", id: `evt_${++n}`, trigger, data });

const received = (over: Record<string, unknown> = {}) =>
  event(TRIGGERS.emailReceived, {
    id: "1a18c46d9465ea0f",
    message_id: "1a18c46d9465ea0f",
    thread_id: "1a18c46d9465ea0f",
    label_ids: ["INBOX", "CATEGORY_UPDATES", "UNREAD"],
    sender: "Oslo Startup Lab <hi@startuplab.no>",
    to: "maya@example.com",
    subject: "You're on the guest list: Founders Story",
    message_timestamp: "2026-10-30T08:55:00Z",
    message_text: "Hi Maya,\n\nSee you on Tue 3 Nov at 17:00 at StartupLab.\n\nThe team",
    ...over,
  });

const calendarEvent = (over: Record<string, unknown> = {}) =>
  event(TRIGGERS.calendar, {
    event_id: "ev123",
    event_type: "created",
    summary: "Server sync",
    start_time: "2026-11-05T14:00:00+01:00",
    end_time: "2026-11-05T15:00:00+01:00",
    status: "confirmed",
    organizer_email: "maya@example.com",
    creator_email: "maya@example.com",
    attendees: [],
    updated_at: "2026-10-30T08:58:00Z",
    created_at: "2026-10-30T08:58:00Z",
    ...over,
  });

describe("flowing in: email received", () => {
  it("keeps an email as an item to read: who and what on top, its own words below", async () => {
    const { flow, taken, audits } = setup();
    const r = await flow.receive(received());
    expect(r).toMatchObject({ outcome: "taken in", why: "read" });
    expect(taken).toHaveLength(1);
    const { item, keepOnly } = taken[0]!;
    expect(keepOnly).toBeUndefined();
    expect(item).toMatchObject({ source: "email", title: "You're on the guest list: Founders Story", startedAt: Date.parse("2026-10-30T08:55:00Z"), people: ["Oslo Startup Lab"] });
    expect(item.id).toMatch(/^email-[0-9a-f]{12}$/);
    expect(item.text).toBe(
      ["From: Oslo Startup Lab <hi@startuplab.no>", "To: Maya", "Subject: You're on the guest list: Founders Story", "", "Hi Maya,", "", "See you on Tue 3 Nov at 17:00 at StartupLab.", "", "The team"].join("\n"),
    );
    expect(audits()).toEqual([expect.objectContaining({ flowIn: "taken in", trigger: TRIGGERS.emailReceived, why: "read", intake: "handed over" })]);
  });

  it("leaves out what Gmail sorted as promotions, social or spam, and the owner's own email (it comes as sent)", async () => {
    const { flow, taken } = setup();
    expect(await flow.receive(received({ id: "p1", label_ids: ["INBOX", "CATEGORY_PROMOTIONS"] }))).toMatchObject({ outcome: "left out", why: "Gmail sorted it as CATEGORY_PROMOTIONS" });
    expect(await flow.receive(received({ id: "s1", label_ids: ["CATEGORY_SOCIAL"] }))).toMatchObject({ outcome: "left out" });
    expect(await flow.receive(received({ id: "x1", label_ids: ["SPAM"] }))).toMatchObject({ outcome: "left out" });
    expect(await flow.receive(received({ id: "o1", sender: "Maya <MAYA@example.com>" }))).toMatchObject({ outcome: "left out", why: "Maya's own email (it comes as sent)" });
    // Updates stay: confirmations and tickets land there.
    expect(await flow.receive(received({ id: "u1", label_ids: ["CATEGORY_UPDATES"] }))).toMatchObject({ outcome: "taken in" });
    expect(taken).toHaveLength(1);
  });

  it("shortens a long recipient list and names people without the owner", async () => {
    const { flow, taken } = setup();
    const many = ["maya@example.com", ...Array.from({ length: 170 }, (_, i) => `guest${i}@x.no`)].join(", ");
    await flow.receive(received({ to: many, cc: '"Hansen, Morten" <morten@x.no>' }));
    const { item } = taken[0]!;
    expect(item.text).toContain("To: Maya, guest0@x.no, guest1@x.no, guest2@x.no, guest3@x.no, guest4@x.no, and 165 more");
    expect(item.text).toContain("Cc: Hansen, Morten");
    expect(item.people).toHaveLength(8);
    expect(item.people).not.toContain("Maya");
  });

  it("takes each email once, and nothing from before the flow started (no catch-up)", async () => {
    const { flow, taken, setNow } = setup();
    // The first delivery brings an email from yesterday: left out, and the flow starts now.
    expect(await flow.receive(received({ id: "old", message_timestamp: "2026-10-29T09:00:00Z" }))).toMatchObject({ outcome: "left out", why: "from before the flow started (no catch-up)" });
    expect(await flow.receive(received())).toMatchObject({ outcome: "taken in" });
    expect(await flow.receive(received())).toMatchObject({ outcome: "left out", why: "already kept" });
    // Later, a late delivery of something from after the start is still taken.
    setNow(T + 6 * 60 * MIN);
    expect(await flow.receive(received({ id: "late", message_timestamp: "2026-10-30T09:30:00Z" }))).toMatchObject({ outcome: "taken in" });
    expect(taken.map((t) => t.item.startedAt)).toEqual([Date.parse("2026-10-30T08:55:00Z"), Date.parse("2026-10-30T09:30:00Z")]);
  });
});

describe("flowing in: email sent", () => {
  it("keeps the owner's own email to be read, and one Sunshine sent for them as Sunshine's", async () => {
    const { flow, taken, actions } = setup();
    const sent = (id: string) =>
      event(TRIGGERS.emailSent, { message_id: id, thread_id: "t1", sender: "maya@example.com", to: "Morten <morten@x.no>", cc: "", subject: "Deck", message_timestamp: "2026-10-30T08:59:00Z", message_text: "I'll send you the deck by Friday.\n\nOn Thu, 29 Oct 2026 at 10:12, Morten <morten@x.no> wrote:\n> Can you send the deck?" });
    expect(await flow.receive(sent("m1"))).toMatchObject({ outcome: "taken in", why: "read" });
    expect(taken[0]!.item).toMatchObject({ source: "email-sent", people: ["Morten"] });
    expect(taken[0]!.item.text).toBe("From: Maya\nTo: Morten\nSubject: Deck\n\nI'll send you the deck by Friday.\n[earlier messages in the thread left out]");

    actions.append({ at: Date.parse("2026-10-30T08:58:30Z"), conversationKey: "imessage:x", tool: "app_composio_multi_execute_tool", actions: ["GMAIL_SEND_EMAIL"], ok: true, ids: ["m2", "t1"] });
    expect(await flow.receive(sent("m2"))).toMatchObject({ outcome: "taken in", why: "sent by Sunshine for Maya" });
    expect(taken[1]!.keepOnly).toBe("sent by Sunshine for Maya");
  });
});

describe("flowing in: calendar", () => {
  it("keeps the owner's own entry without reading it, then only what changes, said as a change", async () => {
    const { flow, taken } = setup();
    expect(await flow.receive(calendarEvent())).toMatchObject({ outcome: "taken in", why: "Maya's own entry" });
    expect(taken[0]!.item).toMatchObject({ source: "calendar", title: "Server sync", startedAt: Date.parse("2026-10-30T08:58:00Z") });
    expect(taken[0]!.item.text).toBe(["Calendar event: Server sync", "Change: new in the calendar", "When: Thu, 5 Nov 2026, 14:00-15:00 (Europe/Oslo)", "Organizer: Maya"].join("\n"));

    // The trigger reports the event again with nothing that matters changed (a reminder setting): nothing kept.
    expect(await flow.receive(calendarEvent({ event_type: "updated", updated_at: "2026-10-30T09:05:00Z" }))).toMatchObject({ outcome: "left out", why: "nothing that matters changed" });

    // She moves it: kept as her own change, with where it was.
    const moved = await flow.receive(calendarEvent({ event_type: "updated", start_time: "2026-11-06T10:00:00+01:00", end_time: "2026-11-06T11:00:00+01:00", location: "Room 2", updated_at: "2026-10-30T09:10:00Z" }));
    expect(moved).toMatchObject({ outcome: "taken in", why: "Maya's own change" });
    expect(taken[1]!.item.text).toContain("Change: moved from Thu, 5 Nov 2026, 14:00-15:00; place added\nWhen: Fri, 6 Nov 2026, 10:00-11:00 (Europe/Oslo)\nWhere: Room 2");
    expect(taken[1]!.item.id).not.toBe(taken[0]!.item.id);
  });

  it("reads someone else's invitation, and others answering the owner's event", async () => {
    const { flow, taken } = setup();
    const invite = calendarEvent({
      event_id: "inv1",
      summary: "Founders Story",
      organizer_email: "seeck@google.com",
      organizer_name: "Erik Seeck",
      location: "StartupLab, Oslo",
      start_time: "2026-11-03T17:00:00+01:00",
      end_time: "2026-11-03T20:00:00+01:00",
      attendees: [
        { email: "maya@example.com", responseStatus: "needsAction", self: true },
        { email: "seeck@google.com", displayName: "Erik Seeck", responseStatus: "accepted", organizer: true },
      ],
      hangout_link: "https://meet.google.com/abc",
      description: "<p>Founders tell their story.</p>",
    });
    expect(await flow.receive(invite)).toMatchObject({ outcome: "taken in", why: "read" });
    expect(taken[0]!.item.text).toBe(
      [
        "Calendar event: Founders Story",
        "Change: new in the calendar",
        "When: Tue, 3 Nov 2026, 17:00-20:00 (Europe/Oslo)",
        "Where: StartupLab, Oslo",
        "Organizer: Erik Seeck <seeck@google.com>",
        "Attendees: Maya (no answer yet), Erik Seeck (accepted)",
        "Video call: yes",
        "Description: Founders tell their story.",
      ].join("\n"),
    );
    expect(taken[0]!.item.people).toEqual(["Erik Seeck"]);

    // Her own dinner; Zia declines: the change is someone else's, so it is read.
    await flow.receive(calendarEvent({ event_id: "din", summary: "Dinner", attendees: [{ email: "zia@x.se", displayName: "Zia", responseStatus: "needsAction" }] }));
    const declined = await flow.receive(calendarEvent({ event_id: "din", summary: "Dinner", event_type: "updated", updated_at: "2026-10-30T09:20:00Z", attendees: [{ email: "zia@x.se", displayName: "Zia", responseStatus: "declined" }] }));
    expect(declined).toMatchObject({ outcome: "taken in", why: "read" });
    expect(taken.at(-1)!.item.text).toContain("Change: Zia declined");
  });

  it("knows Sunshine's own change coming back, and a cancellation by the organizer", async () => {
    const { flow, taken, actions } = setup();
    actions.append({ at: Date.parse("2026-10-30T08:57:50Z"), conversationKey: "system:intake-email-1", tool: "app_googlecalendar_create_event", actions: ["GOOGLECALENDAR_CREATE_EVENT"], ok: true, ids: ["primary", "ev123"] });
    expect(await flow.receive(calendarEvent())).toMatchObject({ outcome: "taken in", why: "added by Sunshine" });
    expect(taken[0]!.keepOnly).toBe("added by Sunshine");

    await flow.receive(calendarEvent({ event_id: "inv2", summary: "Board call", organizer_email: "ceo@x.no", updated_at: "2026-10-30T09:01:00Z" }));
    const cancelled = await flow.receive(calendarEvent({ event_id: "inv2", summary: "Board call", organizer_email: "ceo@x.no", event_type: "deleted", status: "cancelled", updated_at: "2026-10-30T09:30:00Z" }));
    expect(cancelled).toMatchObject({ outcome: "taken in", why: "read" });
    expect(taken.at(-1)!.item.text).toContain("Change: cancelled");
  });

  it("writes all-day events as days, the last day being the one before Google's end", async () => {
    const { flow, taken } = setup();
    await flow.receive(calendarEvent({ event_id: "trip", summary: "Trip", start_time: "2026-11-06", end_time: "2026-11-09" }));
    expect(taken[0]!.item.text).toContain("When: Fri, 6 Nov 2026 to Sun, 8 Nov 2026, all day (Europe/Oslo)");
    await flow.receive(calendarEvent({ event_id: "bday", summary: "Birthday", start_time: "2026-11-10", end_time: "2026-11-11" }));
    expect(taken[1]!.item.text).toContain("When: Tue, 10 Nov 2026, all day (Europe/Oslo)");
  });
});

describe("flowing in: shared", () => {
  it("leaves out a trigger with no rule, and says so in the audit log", async () => {
    const { flow, taken, audits } = setup();
    expect(await flow.receive(event("SLACK_RECEIVE_MESSAGE", { text: "hi" }))).toEqual({ outcome: "left out", why: "no rule for this trigger yet" });
    expect(taken).toHaveLength(0);
    expect(audits()).toEqual([expect.objectContaining({ flowIn: "left out", trigger: "SLACK_RECEIVE_MESSAGE", why: "no rule for this trigger yet" })]);
  });
});

describe("flowing in: email text", () => {
  it("makes HTML plain, cuts the quoted thread in the languages his mail comes in, and cuts long text with the cut said", () => {
    expect(emailBody("<html><head><style>p{}</style></head><body><p>Hei &amp; velkommen</p><div>Linje&nbsp;2<br>Linje 3</div></body></html>")).toBe("Hei & velkommen\nLinje 2\nLinje 3");
    expect(emailBody("Ja, det passer.\n\ntor. 29. okt. 2026 kl. 10:12 skrev Morten Hansen <m@x.no>:\n> Passer torsdag?")).toBe("Ja, det passer.\n[earlier messages in the thread left out]");
    expect(emailBody("Sure.\n\nOn Thu, 29 Oct 2026 at 10:12, Morten Hansen <\nm@x.no> wrote:\n> Thursday?")).toBe("Sure.\n[earlier messages in the thread left out]");
    expect(emailBody("Fine.\n\nFrom: Morten\nSent: Thursday\nSubject: Re: x\n\nOld text")).toBe("Fine.\n[earlier messages in the thread left out]");
    // A forwarded message is the content itself, its own From/Date header block included.
    const fwd = "See below.\n---------- Forwarded message ---------\nFrom: Ticketmaster <t@tm.no>\nDate: Thu, 29 Oct 2026 at 10:12\nSubject: Your tickets\n\nYour tickets: J. Cole, 12 Nov 19:00";
    expect(emailBody(fwd)).toBe(fwd);
    // A sentence that ends "wrote:" is not a quote's start: no clock time or address on it.
    expect(emailBody("Here is what I wrote:\nThree things.")).toBe("Here is what I wrote:\nThree things.");
    expect(emailBody("In 2025 I wrote: three things")).toBe("In 2025 I wrote: three things");
    // Long tracking links are shortened to their site; short ones stay as they are.
    expect(emailBody(`Legg til: https://calendar.google.com/calendar/event?action=RESPOND&eid=${"Q".repeat(120)}&rst=1 or https://x.no/a`)).toBe("Legg til: https://calendar.google.com/… or https://x.no/a");
    const long = emailBody("x".repeat(BODY_MAX + 500));
    expect(long).toHaveLength(BODY_MAX + "\n[cut: the email goes on for 500 more characters]".length);
  });

  it("reads addresses and times as the connector gives them", () => {
    expect(parseAddresses('"Hansen, Morten" <Morten@X.no>, soan@netlight.com, Erik Seeck <seeck@google.com>')).toEqual([
      { name: "Hansen, Morten", email: "morten@x.no" },
      { email: "soan@netlight.com" },
      { name: "Erik Seeck", email: "seeck@google.com" },
    ]);
    expect(parseTime("2026-10-30T08:55:00Z")).toBe(Date.parse("2026-10-30T08:55:00Z"));
    expect(parseTime("1761814500")).toBe(1761814500_000);
    expect(parseTime(1761814500123)).toBe(1761814500123);
    expect(parseTime("Fri, 30 Oct 2026 09:55:00 +0100")).toBe(Date.parse("2026-10-30T08:55:00Z"));
    expect(parseTime("")).toBeUndefined();
  });
});
