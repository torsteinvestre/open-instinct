/**
 * [sunshine:watcher] Reading and checking the models' answers. The models reply in JSON; this
 * file turns that into a plan and refuses anything that breaks a fact the code can check: a story
 * already told under the same link, an "update" to a card that does not exist or with nothing
 * changed, or a "new" story whose headline is nearly the same as one already told.
 */
import type { StoryCard } from "./store.js";

export interface ScreenResult {
  pass: number[];
  note: string;
}

export interface NewStory {
  headline: number;
  card: "new";
  subject: string;
  event: string;
  status: string;
  /** Why a headline that reads like a told one is a different event ("a different match"). */
  distinct?: string;
}

export interface StoryUpdate {
  headline: number;
  card: string;
  changed: string;
  status: string;
}

export interface Decision {
  message: null | { text: string; stories: Array<NewStory | StoryUpdate> };
  keep: Array<{ headline: number; why?: string }>;
  note: string;
}

export const TEXT_MAX_CHARS = 1200;
/**
 * Word overlap above which a "new" story's headline reads like a told one. Numbers count as words,
 * so "won 2-1 against Molde" and "won 3-0 against Viking" stay apart.
 */
export const SAME_HEADLINE_OVERLAP = 0.7;

/** The first JSON object in a reply, tolerating prose or code fences around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : undefined);

export function parseScreen(text: string, count: number): ScreenResult {
  const raw = extractJson(text) as { pass?: unknown; note?: unknown };
  if (!Array.isArray(raw.pass)) throw new Error('the reply has no "pass" list');
  const pass = [...new Set(raw.pass.map(int).filter((n): n is number => n !== undefined && n >= 1 && n <= count))].sort((a, b) => a - b);
  return { pass, note: str(raw.note) };
}

export function parseDecision(text: string): Decision {
  const raw = extractJson(text) as { message?: unknown; keep?: unknown; note?: unknown };
  let message: Decision["message"] = null;
  if (raw.message && typeof raw.message === "object") {
    const m = raw.message as { text?: unknown; stories?: unknown };
    const stories = (Array.isArray(m.stories) ? m.stories : []).map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const headline = int(o["headline"]) ?? -1;
      const card = str(o["card"]) || "new";
      return card === "new"
        ? ({ headline, card: "new", subject: str(o["subject"]), event: str(o["event"]), status: str(o["status"]), ...(str(o["distinct"]) ? { distinct: str(o["distinct"]) } : {}) } satisfies NewStory)
        : ({ headline, card, changed: str(o["changed"]), status: str(o["status"]) } satisfies StoryUpdate);
    });
    message = { text: str(m.text), stories };
  }
  const keep = (Array.isArray(raw.keep) ? raw.keep : [])
    .map((k) => ({ headline: int((k as Record<string, unknown>)?.["headline"]) ?? -1, why: str((k as Record<string, unknown>)?.["why"]) }))
    .filter((k) => k.headline > 0);
  return { message, keep, note: str(raw.note) };
}

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((w) => w.length >= 3 || /\d/.test(w)),
  );
}

/** Share of words two headlines have in common (Jaccard). */
export function headlineOverlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** Problems with a decision, in words the model can act on. Empty means it may go out. */
export function checkDecision(d: Decision, headlines: Map<number, { title: string; link: string }>, cards: StoryCard[]): string[] {
  const problems: string[] = [];
  for (const k of d.keep) if (!headlines.has(k.headline)) problems.push(`"keep" names headline ${k.headline}, which is not in the list.`);
  if (!d.message) return problems;
  const { text, stories } = d.message;
  if (!text) problems.push("The message has no text.");
  if (text.length > TEXT_MAX_CHARS) problems.push(`The message is ${text.length} characters; keep it under ${TEXT_MAX_CHARS}.`);
  if (stories.length === 0) problems.push('The message lists no stories. Every story it mentions must be under "stories".');
  const toldLinks = new Map(cards.flatMap((c) => c.links.map((l) => [l, c] as const)));
  const used = new Set<number>();
  for (const s of stories) {
    const h = headlines.get(s.headline);
    if (!h) {
      problems.push(`Story for headline ${s.headline}: there is no such headline.`);
      continue;
    }
    if (used.has(s.headline)) problems.push(`Headline ${s.headline} is listed twice.`);
    used.add(s.headline);
    const toldUnder = toldLinks.get(h.link);
    if (toldUnder) {
      problems.push(`Headline ${s.headline} is the exact article you already told them about (card ${toldUnder.id}). Leave it out.`);
      continue;
    }
    if (s.card === "new") {
      const n = s as NewStory;
      if (!n.subject || !n.event || !n.status) problems.push(`Headline ${s.headline} is a new story but is missing subject, event or status.`);
      const near = cards.find((c) => c.titles.some((t) => headlineOverlap(t, h.title) >= SAME_HEADLINE_OVERLAP));
      if (near && !n.distinct) {
        problems.push(
          `Headline ${s.headline} reads almost like the story on card ${near.id} (${near.subject}: ${near.event}). If it is a real development, send it as an update to ${near.id} with what changed. If nothing changed, leave it out. If it is truly a different event, keep it as "new" and add "distinct": "how it differs from ${near.id}".`,
        );
      }
    } else {
      const u = s as StoryUpdate;
      if (!cards.some((c) => c.id === u.card)) problems.push(`Headline ${s.headline} is sent as an update to ${u.card}, but there is no such card.`);
      if (!u.changed) problems.push(`Headline ${s.headline} is an update to ${u.card} but says nothing about what changed. If nothing changed, leave it out.`);
      if (!u.status) problems.push(`Headline ${s.headline} is an update but has no status.`);
    }
  }
  return problems;
}
