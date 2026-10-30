/**
 * [sunshine:flowing-in] What happens in the owner's apps flows into memory as it happens, instead of being searched for
 * when someone thinks to look (DESIGN-memory-in-the-flow.md, job 1). One way in for every app: the app connector
 * (Composio) reports an event, the gateway checks it and forwards it to this agent as an `app.event`, and here it becomes
 * an item through the intake, like a recording: kept, read once, taken into Hindsight, acted on when it needs the owner.
 * Each source adds only a small rule (which events count, what to strip); everything after it is shared.
 *
 * Shared by every source:
 * - No catch-up (decided 2026-10-30): memory starts with the product. What happened more than an hour before the first
 *   event this agent got from a trigger is left out, so a first delivery that brings older ones keeps none.
 * - Once: the same event delivered again is left out by its item id.
 * - Sunshine's own change coming back (the calendar reporting the event Sunshine just added) is kept as Sunshine's,
 *   from the action log (core actions.ts), and never handed over again. Google cannot tell: Sunshine acts through the
 *   owner's own account.
 * - The owner's own change (their own calendar entry) is kept without reading: there is nothing to tell them about it.
 */
import { createHash } from "node:crypto";
import type { ActionLog, AppEvent, AuditLog, InstinctConfig, ItemArchive, StateDir } from "@open-instinct/core";
import type { Intake, IntakeItem, IntakeResult } from "./intake.js";

export const FLOW_STATE_FILE = "flow-in.json";
/** A first delivery may bring what happened before it; older than the first event less this is left out. */
const CATCH_UP_SLACK_MS = 60 * 60 * 1000;
/** Sunshine's own change comes back within minutes (the triggers check every 2 by default); a wide margin. */
const OWN_CHANGE_MS = 30 * 60 * 1000;
/** An email's text kept: his inbox's median is 2,200 characters; the longest (26,000) are notices whose point is on top. */
export const BODY_MAX = 8_000;
/** Addresses shown in a To or Cc line; the invitation of 30 Oct went to 171. */
const NAMES_SHOWN = 6;
const PEOPLE_MAX = 8;
const DESCRIPTION_MAX = 1_500;
const ATTENDEES_SHOWN = 15;
/**
 * Gmail's own sorting, left out before anything reads it. Updates stay: his event confirmation and ticket order both
 * landed there (probe of 29 Oct), and 96 of his 112 kept emails are Updates.
 */
const SKIP_LABELS: ReadonlySet<string> = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH", "DRAFT"]);

/** The Composio triggers with a rule here. Another app is one more rule. */
export const TRIGGERS = {
  emailReceived: "GMAIL_NEW_GMAIL_MESSAGE",
  emailSent: "GMAIL_EMAIL_SENT_TRIGGER",
  calendar: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
} as const;

export interface FlowResult {
  outcome: "taken in" | "left out";
  why: string;
  itemId?: string;
  intake?: IntakeResult;
}

export interface FlowInDeps {
  intake: Intake;
  items: ItemArchive;
  state: StateDir;
  config: InstinctConfig;
  audit: AuditLog;
  /** What Sunshine did in the apps; without it nothing is known as Sunshine's own. */
  actions?: ActionLog;
  now?: () => number;
}

export interface FlowIn {
  receive(event: AppEvent): Promise<FlowResult>;
}

/** A calendar event as last seen, to tell what changed (the trigger sends the event, not the change). */
interface CalendarSeen {
  title: string;
  start: string;
  end: string;
  location: string;
  status: string;
  organizer: string;
  /** Attendee email -> their answer, without the owner. */
  responses: Record<string, string>;
  /** A hash: a changed description is said, not shown twice. */
  description: string;
  seenAt: number;
}

interface FlowState {
  firstSeen: Record<string, number>;
  calendar: Record<string, CalendarSeen>;
}

type Rule = { item: IntakeItem; keepOnly?: string } | { skip: string };

export interface Address {
  name?: string;
  email: string;
}

/** "Erik Seeck <seeck@google.com>, soan@netlight.com" as addresses; commas inside quotes or <> do not split. */
export function parseAddresses(list: string | undefined): Address[] {
  if (!list) return [];
  const out: Address[] = [];
  const push = (s: string): void => {
    const t = s.trim();
    if (!t) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(t);
    if (m) {
      const name = m[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
      out.push({ ...(name ? { name } : {}), email: m[2]!.trim().toLowerCase() });
    } else {
      out.push({ email: t.replace(/^mailto:/i, "").toLowerCase() });
    }
  };
  let cur = "";
  let quoted = false;
  let angled = false;
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angled = true;
    else if (ch === ">") angled = false;
    if (ch === "," && !quoted && !angled) {
      push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  push(cur);
  return out;
}

/** A time in ms from ISO text, RFC 2822 text, or seconds or ms as a number or digits; undefined if none. */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const t = v.trim();
  if (/^\d+$/.test(t)) return parseTime(Number(t));
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function hashOf(text: string, n = 12): string {
  return createHash("sha1").update(text).digest("hex").slice(0, n);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** HTML mail as plain lines: blocks become line breaks, tags go, the common entities are decoded (&amp; last). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ");
}

/**
 * Where a reply's quote of the earlier messages starts: "On Thu, 29 Oct 2026 at 10:12, Morten <m@x.no> wrote:" or
 * "tor. 29. okt. 2026 kl. 10:12 skrev Morten <m@x.no>:" in the languages his mail comes in (Gmail's header may wrap onto
 * a second line; a clock time or an address on it, so a sentence ending "I wrote:" is not one), "-----Original
 * Message-----", or Outlook's "From: / Sent:" block.
 */
function quoteStarts(line: string, next: string | undefined): boolean {
  if (/^\s*-{2,}\s*(original message|opprinnelig melding|ursprüngliche nachricht)\s*-{2,}/i.test(line)) return true;
  if (/^\s*(from|fra|von):\s/i.test(line) && /^\s*(sent|sendt|gesendet|date|dato):\s/i.test(next ?? "")) return true;
  const verb = /\b(wrote|skrev|schrieb|écrit|escribió|scrisse|schreef|kirjoitti|napisał)\b/i;
  for (const l of [line, `${line} ${next ?? ""}`]) {
    const t = l.trim();
    if (t.length < 300 && /:$/.test(t) && verb.test(t) && (/\d{1,2}[:.]\d{2}/.test(t) || /<[^<>\s]+@[^<>\s]+>/.test(t))) return true;
  }
  return false;
}

/** A forwarded message is the content itself (a forwarded ticket): from its marker on, nothing is cut. */
const FORWARDED = /^\s*-{2,}\s*(forwarded message|videresendt melding|weitergeleitete nachricht|message transféré)\s*-{2,}/i;

/**
 * A link longer than this is shortened to its site: in his 112 emails (30 Oct), links were 41% of the kept text, median
 * 133 characters (tracking and calendar links), and say nothing a reader needs; the email itself stays in Gmail.
 */
export const LINK_MAX = 60;

function shortLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/g, (link) => {
    if (link.length <= LINK_MAX) return link;
    try {
      return `${new URL(link).origin}/…`;
    } catch {
      return `${link.slice(0, LINK_MAX)}…`;
    }
  });
}

/** An email's own words: HTML made plain, the quoted earlier messages left out, long links shortened, long text cut. */
export function emailBody(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  if (/<(html|body|div|p|br|table|span|a|td)\b/i.test(text)) text = htmlToText(text);
  const lines = text.split("\n");
  const kept: string[] = [];
  let quoted = false;
  let forwarded = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    forwarded ||= FORWARDED.test(line);
    if (forwarded) {
      kept.push(line.replace(/\s+$/, ""));
      continue;
    }
    if (quoteStarts(line, lines[i + 1])) {
      quoted = true;
      break;
    }
    if (/^\s*>/.test(line)) {
      quoted = true;
      continue;
    }
    kept.push(line.replace(/\s+$/, ""));
  }
  let body = shortLinks(kept.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
  if (quoted) body += `${body ? "\n" : ""}[earlier messages in the thread left out]`;
  if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}\n[cut: the email goes on for ${body.length - BODY_MAX} more characters]`;
  return body;
}

function attachmentNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((a) => (typeof a === "string" ? a : str((a as Record<string, unknown> | null)?.filename) ?? str((a as Record<string, unknown> | null)?.name)))
    .filter((n): n is string => Boolean(n))
    .slice(0, 10);
}

export function createFlowIn(deps: FlowInDeps): FlowIn {
  const owner = deps.config.owner.name;
  const agent = deps.config.agent.name;
  const now = () => deps.now?.() ?? Date.now();
  const tz = () => deps.config.owner.timezone || "UTC";
  const ownerEmails = () => new Set(deps.config.owner.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isOwner = (email: string | undefined) => Boolean(email && ownerEmails().has(email.trim().toLowerCase()));

  const readState = (): FlowState => {
    const s = deps.state.readJson<Partial<FlowState>>(FLOW_STATE_FILE, {});
    return { firstSeen: s.firstSeen ?? {}, calendar: s.calendar ?? {} };
  };
  const writeState = (s: FlowState): void => deps.state.writeJson(FLOW_STATE_FILE, s);

  const nameOf = (a: Address) => (isOwner(a.email) ? owner : (a.name ?? a.email));
  const showAddresses = (list: Address[], withEmail = false) => {
    const shown = list.slice(0, NAMES_SHOWN).map((a) => (withEmail && a.name && !isOwner(a.email) ? `${a.name} <${a.email}>` : nameOf(a)));
    return `${shown.join(", ")}${list.length > NAMES_SHOWN ? `, and ${list.length - NAMES_SHOWN} more` : ""}`;
  };
  const peopleOf = (list: Address[]) => [...new Set(list.filter((a) => !isOwner(a.email)).map(nameOf))].slice(0, PEOPLE_MAX);

  /** The email as kept: who and what in a few header lines, then its own words. */
  const emailText = (d: Record<string, unknown>): string => {
    const head: string[] = [];
    const from = parseAddresses(str(d.sender));
    if (from.length) head.push(`From: ${showAddresses(from, true)}`);
    const to = parseAddresses(str(d.to));
    if (to.length) head.push(`To: ${showAddresses(to)}`);
    const cc = parseAddresses(str(d.cc));
    if (cc.length) head.push(`Cc: ${showAddresses(cc)}`);
    const subject = str(d.subject);
    if (subject) head.push(`Subject: ${subject}`);
    const files = attachmentNames(d.attachment_list);
    if (files.length) head.push(`Attachments: ${files.join(", ")}`);
    const preview = d.preview && typeof d.preview === "object" ? str((d.preview as Record<string, unknown>).body) : str(d.preview);
    return [...head, "", emailBody(str(d.message_text) ?? preview ?? "")].join("\n").trim();
  };

  // --- The sources' rules -------------------------------------------------------------------------------------------

  function emailReceived(d: Record<string, unknown>, at: number): Rule {
    const id = str(d.id) ?? str(d.message_id);
    if (!id) return { skip: "no message id" };
    const label = (Array.isArray(d.label_ids) ? d.label_ids.map(String) : []).find((l) => SKIP_LABELS.has(l));
    if (label) return { skip: `Gmail sorted it as ${label}` };
    const from = parseAddresses(str(d.sender));
    if (from.some((a) => isOwner(a.email))) return { skip: `${owner}'s own email (it comes as sent)` };
    const people = peopleOf([...from, ...parseAddresses(str(d.to)), ...parseAddresses(str(d.cc))]);
    const title = str(d.subject);
    return { item: { id: `email-${hashOf(id)}`, source: "email", ...(title ? { title: clip(title, 200) } : {}), startedAt: at, ...(people.length ? { people } : {}), text: emailText(d) } };
  }

  function emailSent(d: Record<string, unknown>, at: number): Rule {
    const id = str(d.message_id) ?? str(d.id);
    if (!id) return { skip: "no message id" };
    const people = peopleOf([...parseAddresses(str(d.to)), ...parseAddresses(str(d.cc))]);
    const title = str(d.subject);
    const item: IntakeItem = { id: `email-${hashOf(id)}`, source: "email-sent", ...(title ? { title: clip(title, 200) } : {}), startedAt: at, ...(people.length ? { people } : {}), text: emailText(d) };
    const own = deps.actions?.did(id, at - OWN_CHANGE_MS);
    return own ? { item, keepOnly: `sent by ${agent} for ${owner}` } : { item };
  }

  const day = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  const clock = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const allDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const dayOnly = (s: string, back = 0) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.parse(`${s}T00:00:00Z`) - back * 86_400_000));

  /** "Fri 6 Nov 2026, 10:00-11:00", "Fri 6 Nov 2026, all day", in the owner's time. */
  const when = (start: string, end: string): string => {
    if (!start) return "no time given";
    if (allDay(start)) {
      // Google's all-day end is the day after.
      const last = end && allDay(end) ? dayOnly(end, 1) : dayOnly(start);
      return last === dayOnly(start) ? `${dayOnly(start)}, all day` : `${dayOnly(start)} to ${last}, all day`;
    }
    const s = Date.parse(start);
    const e = end ? Date.parse(end) : NaN;
    if (Number.isNaN(s)) return start;
    if (Number.isNaN(e)) return `${day(s)}, ${clock(s)}`;
    return day(e) === day(s) ? `${day(s)}, ${clock(s)}-${clock(e)}` : `${day(s)}, ${clock(s)} to ${day(e)}, ${clock(e)}`;
  };

  const ANSWERS: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "answered maybe", needsAction: "no answer yet" };

  function attendeesOf(v: unknown): Array<Address & { response: string; self: boolean }> {
    if (!Array.isArray(v)) return [];
    return v
      .map((a) => {
        if (typeof a === "string") return { email: a.trim().toLowerCase(), response: "needsAction", self: false };
        const r = (a ?? {}) as Record<string, unknown>;
        const email = (str(r.email) ?? "").toLowerCase();
        const name = str(r.displayName) ?? str(r.display_name) ?? str(r.name);
        return { ...(name ? { name } : {}), email, response: str(r.responseStatus) ?? str(r.response_status) ?? "needsAction", self: r.self === true };
      })
      .filter((a) => a.email);
  }

  function calendar(d: Record<string, unknown>, at: number, st: FlowState): Rule {
    const eventId = str(d.event_id) ?? str(d.id);
    if (!eventId) return { skip: "no event id" };
    const cancelled = str(d.event_type) === "deleted" || str(d.status) === "cancelled";
    const attendees = attendeesOf(d.attendees);
    const organizer = (str(d.organizer_email) ?? "").toLowerCase();
    const responses: Record<string, string> = {};
    for (const a of attendees) if (!a.self && !isOwner(a.email)) responses[a.email] = a.response;
    const description = (str(d.description) ?? "").replace(/\s+/g, " ").trim();
    const cur: CalendarSeen = {
      title: str(d.summary) ?? "(no title)",
      start: str(d.start_time) ?? "",
      end: str(d.end_time) ?? "",
      location: str(d.location) ?? "",
      status: cancelled ? "cancelled" : (str(d.status) ?? "confirmed"),
      organizer,
      responses,
      description: description ? hashOf(description) : "",
      seenAt: now(),
    };
    const prev = st.calendar[eventId];
    st.calendar[eventId] = cur;

    // What changed since it was last seen, in words; responses apart (others answering is not the owner's change).
    const changes: string[] = [];
    const answers: string[] = [];
    if (prev) {
      if (prev.status !== "cancelled" && cur.status === "cancelled") changes.push("cancelled");
      else if (prev.status === "cancelled" && cur.status !== "cancelled") changes.push("back on, no longer cancelled");
      if (prev.title !== cur.title) changes.push(`renamed from "${prev.title}"`);
      if (prev.start !== cur.start || prev.end !== cur.end) changes.push(`moved from ${when(prev.start, prev.end)}`);
      if (prev.location !== cur.location) changes.push(prev.location ? (cur.location ? `place changed from ${prev.location}` : `place removed (was ${prev.location})`) : "place added");
      if (prev.description !== cur.description) changes.push("description changed");
      for (const a of attendees) {
        if (a.self || isOwner(a.email)) continue;
        const before = prev.responses[a.email];
        if (before !== a.response && a.response !== "needsAction") answers.push(`${a.name ?? a.email} ${ANSWERS[a.response] ?? a.response}`);
      }
      if (changes.length === 0 && answers.length === 0) return { skip: "nothing that matters changed" };
    }

    const name = cur.title;
    const change = !prev ? (cancelled ? "cancelled" : "new in the calendar") : [...changes, ...answers].join("; ");
    const organizerName = str(d.organizer_name);
    const lines = [
      `Calendar event: ${name}`,
      `Change: ${change}`,
      `When: ${when(cur.start, cur.end)} (${tz()})`,
      ...(cur.location ? [`Where: ${cur.location}`] : []),
      ...(organizer ? [`Organizer: ${isOwner(organizer) ? owner : organizerName ? `${organizerName} <${organizer}>` : organizer}`] : []),
      ...(attendees.length
        ? [`Attendees: ${attendees.slice(0, ATTENDEES_SHOWN).map((a) => `${a.self || isOwner(a.email) ? owner : (a.name ?? a.email)} (${ANSWERS[a.response] ?? a.response})`).join(", ")}${attendees.length > ATTENDEES_SHOWN ? `, and ${attendees.length - ATTENDEES_SHOWN} more` : ""}`]
        : []),
      ...(str(d.hangout_link) || (d.conference_data && typeof d.conference_data === "object") ? ["Video call: yes"] : []),
      ...(str(d.recurring_event_id) ? ["Repeats: part of a repeating series"] : []),
      ...(description ? [`Description: ${clip(emailBody(description), DESCRIPTION_MAX)}`] : []),
    ];
    const people = [
      ...new Set([...(organizer && !isOwner(organizer) ? [organizerName ?? organizer] : []), ...attendees.filter((a) => !a.self && !isOwner(a.email)).map((a) => a.name ?? a.email)]),
    ].slice(0, PEOPLE_MAX);
    const item: IntakeItem = { id: `cal-${hashOf(eventId)}-${at.toString(36)}`, source: "calendar", title: clip(name, 200), startedAt: at, ...(people.length ? { people } : {}), text: lines.join("\n") };

    // Whose change: Sunshine's (it is in the action log), someone else's (their event, or only others answering), or the owner's.
    if (deps.actions?.did(eventId, at - OWN_CHANGE_MS)) return { item, keepOnly: `${prev ? "changed" : "added"} by ${agent}` };
    const othersEvent = Boolean(organizer) && !isOwner(organizer) && !attendees.some((a) => a.self && a.email === organizer);
    if (othersEvent || (prev && changes.length === 0)) return { item };
    return { item, keepOnly: `${owner}'s own ${prev ? "change" : "entry"}` };
  }

  // --- Shared ------------------------------------------------------------------------------------------------------

  const record = (ev: AppEvent, result: FlowResult): FlowResult => {
    deps.audit.append({
      kind: "policy",
      conversationKey: "system:flow-in",
      principal: "owner",
      detail: { flowIn: result.outcome, trigger: ev.trigger, event: ev.id, why: result.why, ...(result.itemId ? { item: result.itemId } : {}), ...(result.intake ? { intake: result.intake.outcome } : {}) },
    });
    return result;
  };

  return {
    async receive(ev) {
      const at = (d: Record<string, unknown>) =>
        parseTime(ev.trigger === TRIGGERS.calendar ? (d.updated_at ?? d.created_at) : d.message_timestamp) ?? parseTime(ev.at) ?? now();
      const happened = at(ev.data);
      // Everything up to the intake is synchronous, so two events at once cannot overwrite each other's state.
      const st = readState();
      st.firstSeen[ev.trigger] ??= now();
      let rule: Rule;
      switch (ev.trigger) {
        case TRIGGERS.emailReceived:
          rule = emailReceived(ev.data, happened);
          break;
        case TRIGGERS.emailSent:
          rule = emailSent(ev.data, happened);
          break;
        case TRIGGERS.calendar:
          rule = calendar(ev.data, happened, st);
          break;
        default:
          rule = { skip: "no rule for this trigger yet" };
      }
      writeState(st);
      if ("skip" in rule) return record(ev, { outcome: "left out", why: rule.skip });
      if (happened < st.firstSeen[ev.trigger]! - CATCH_UP_SLACK_MS) return record(ev, { outcome: "left out", why: "from before the flow started (no catch-up)", itemId: rule.item.id });
      if (deps.items.get(rule.item.id)) return record(ev, { outcome: "left out", why: "already kept", itemId: rule.item.id });
      const result = await deps.intake.receive(rule.item, rule.keepOnly ? { keepOnly: rule.keepOnly } : {});
      return record(ev, { outcome: "taken in", why: rule.keepOnly ?? "read", itemId: rule.item.id, intake: result });
    },
  };
}
