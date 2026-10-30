/**
 * [sunshine:hindsight] Hindsight (open source, MIT, by vectorize-io; 1.1.0) is Sunshine's memory engine, used as its makers
 * intend; this is the thin layer of ours around it (decided by Torstein 2026-10-30; ~/sunshine-ops/DESIGN-memory-in-the-flow.md,
 * "Hindsight as the engine"). On his real data (30 Oct) it answered 17 of 20 questions fully and 3 in part, where Sunshine's own
 * recall failed the date questions: its facts carry the date an event HAPPENS, so "next week" is a list by date, not a guess at
 * search words; the newest version wins when something changes; deleting a source removes what it taught.
 *
 * What stays ours:
 * - What goes in. Each kept item (recordings now; email next) and the owner's own messages, a spell of conversation at a time
 *   once it has gone quiet. Not Sunshine's replies, not the runtime's notes: on 30 Oct a reply ("the calendar has no events
 *   2-8 Nov") became a fact and ranked first, and the state of another system is read live, never kept. The makers' OpenClaw
 *   plugin offers the same choice as a setting (retainRoles). A spell, not the whole thread: the makers keep one document per
 *   session and append to it, but an iMessage thread never ends and an append reads the whole document again.
 * - Our archive stays the record. Hindsight is built from it, as the meaning search's vectors are (meaning.ts): what changes
 *   there (a forgotten line) is stored again, what goes (forgotten, past the age limit) is deleted here by its document id.
 * - Local times. Each document goes in with the owner's wall-clock time and offset, and its context names their timezone.
 *   Hindsight reads a time without a zone as UTC (its stored_dates.py), and on 30 Oct the documents went in as UTC: "19:00" in
 *   the J. Cole ticket email was kept as 19:00 UTC, an hour late; the invitation that said "(CET)" came out right.
 * - Bringing it to what is new, behind the Recall seam (recall.ts): for the days asked, every fact by when it happens (a list,
 *   no ranking); for the rest, by meaning, with now as the query time.
 * - One search (Torstein, 2026-10-30: two searches over the same past can disagree and rank differently). The agent's
 *   history_search asks Hindsight too: what is known, the text it came from, and what Sunshine itself said. Sunshine's
 *   replies (and the texts it sent from elsewhere) go to a bank of their own, text only: Hindsight's "chunks" mode
 *   stores them word for word with no model call, and with observations off for that bank they never become facts. Not
 *   in the main bank: chunks are kept as ordinary "world" memories there and consolidation reads every one of them, and a
 *   per-item strategy that is missing falls back to normal extraction without a word (checked in Hindsight's code, and a
 *   live check: 0 model calls, 0 observations). The automatic recall reads only the main bank, so an old "your calendar
 *   is empty" cannot steer a new answer.
 */
import { createHash } from "node:crypto";
import type { AuditLog, ArchiveItem, HistoryArchive, HistoryEntry, InstinctConfig, ItemArchive, StateDir } from "@open-instinct/core";
import { SOURCES } from "./intake.js";
import { addDays, midnightIn, offsetAt, parseSpan } from "./lookup.js";
import type { Recall } from "./recall.js";

export const HINDSIGHT_FILE = "history/hindsight.json";
/** A pause this long between two of the owner's messages starts a new spell (as the meaning search pieces a thread). */
const SPELL_GAP_MS = 60 * 60 * 1000;
/** A spell goes in once it has been quiet this long: one reading per conversation, not one per message. */
export const SPELL_QUIET_MS = 30 * 60 * 1000;
/** After a change, wait this long for more before storing (a conversation usually goes on). */
const SYNC_DELAY_MS = 30_000;
/** After a failed store, try again this much later. */
const RETRY_MS = 10 * 60 * 1000;
/** A recall waits this long for Hindsight, then the fallback (today's meaning search) answers. */
const WAIT_MS = 30_000;
/** The makers' OpenClaw plugin composes one query of at most this many characters (recallMaxQueryChars). */
const QUERY_MAX = 800;
/** How much recall by meaning brings, in Hindsight's tokens. */
const RECALL_TOKENS = 1_500;
/** Facts listed per day or span asked, and by date in all. */
const PER_SPAN = 50;
const BY_DATE_MAX = 40;
const LINE_MAX = 300;
/** The agent's own search: facts shown, pieces of the text they came from (and how much of each), what Sunshine said. */
const SEARCH_FACTS = 15;
const CHUNK_TOKENS = 2_000;
/** Enough of an observation's source facts to find its document and text. */
const SOURCE_FACT_TOKENS = 2_000;
const SOURCE_PIECES = 3;
const SOURCE_CHARS = 1_000;
const SAID_TOKENS = 800;
const SAID_SHOWN = 4;
const SAID_CHARS = 500;

/** A fact as Hindsight returns it from recall or a listing (the fields this layer reads). */
export interface HindsightFact {
  id: string;
  text?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  metadata?: Record<string, unknown> | null;
  /** An observation (Hindsight's consolidated view): the facts it was built from (in a listing; in recall, source_fact_ids). */
  source_memory_ids?: string[] | null;
  source_fact_ids?: string[] | null;
  /** The piece of the document's text it was taken from. */
  chunk_id?: string | null;
}

/** The part of the makers' client (@vectorize-io/hindsight-client) this layer uses; tests pass a stand-in. */
export interface HindsightApi {
  createBank(bankId: string, options: { retainMission?: string; retainExtractionMode?: string; enableObservations?: boolean }): Promise<unknown>;
  getBankConfig(bankId: string): Promise<unknown>;
  retainBatch(
    bankId: string,
    items: Array<{ content: string; timestamp?: string; context?: string; metadata?: Record<string, string>; document_id?: string }>,
    options?: { async?: boolean },
  ): Promise<{ usage?: unknown }>;
  recall(
    bankId: string,
    query: string,
    options?: {
      budget?: "low" | "mid" | "high";
      maxTokens?: number;
      queryTimestamp?: string;
      types?: string[];
      preferObservations?: boolean;
      includeChunks?: boolean;
      maxChunkTokens?: number;
      includeSourceFacts?: boolean;
      maxSourceFactsTokens?: number;
    },
  ): Promise<{ results: HindsightFact[]; chunks?: Record<string, { id: string; text: string }> | null; source_facts?: Record<string, HindsightFact> | null }>;
  listMemories(
    bankId: string,
    options?: { timeField?: "occurred_start"; startDate?: string; endDate?: string; state?: "valid"; limit?: number },
  ): Promise<{ items: HindsightFact[] }>;
  deleteDocument(bankId: string, documentId: string): Promise<void>;
}

/** One document as it should be in Hindsight, built from the archive. */
export interface HindsightDoc {
  id: string;
  content: string;
  /** The owner's wall-clock time with its offset. */
  timestamp: string;
  context: string;
  metadata: Record<string, string>;
  hash: string;
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function parts(ms: number, tz: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}

/** `ms` as the wall-clock time in `tz` with its offset: "2026-10-30T11:06:54+01:00". */
export function localIso(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetAt(ms, tz)}`;
}

/** "[2026-10-30 11:12]" in the owner's timezone, as the meaning search stamps chat lines. */
function stamp(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `[${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}]`;
}

/** The document id of a kept item. */
export const itemDocId = (id: string) => `item:${id}`;
/** Documents of what Sunshine said start so: they live in the replies bank. */
const SAID = "said:";

/**
 * Lines of one side, a spell at a time: consecutive entries of one thread whose `who` is asked for (the owner's own
 * messages; or what Sunshine said and the runtime's notes of what it sent), a new spell after a long pause.
 */
export function spells(entries: HistoryEntry[], who: Array<HistoryEntry["who"]>): Array<{ key: string; entries: HistoryEntry[] }> {
  const threads = new Map<string, HistoryEntry[]>();
  for (const e of entries) if (who.includes(e.who) && e.text.trim()) threads.set(e.key, [...(threads.get(e.key) ?? []), e]);
  const out: Array<{ key: string; entries: HistoryEntry[] }> = [];
  for (const [key, thread] of threads) {
    let cur: HistoryEntry[] = [];
    for (const e of thread.sort((a, b) => a.ts - b.ts)) {
      if (cur.length > 0 && e.ts - cur[cur.length - 1]!.ts > SPELL_GAP_MS) {
        out.push({ key, entries: cur });
        cur = [];
      }
      cur.push(e);
    }
    if (cur.length > 0) out.push({ key, entries: cur });
  }
  return out;
}

/** The retain mission: what Hindsight keeps from what it reads (the 30 Oct test's, with the owner's name). */
export function retainMission(owner: string): string {
  return (
    `Memory for ${owner}'s personal assistant. Keep what matters for helping ${owner}: events and plans with their dates, times and ` +
    `places, tickets and bookings, deadlines and changes to their accounts and subscriptions, commitments (who owes what to whom, by ` +
    `when, and whether it is done), people and their roles, projects and decisions, and the preferences and instructions ${owner} ` +
    `gives their assistant. Leave out marketing, newsletters and routine notifications that carry nothing ${owner} must know or do.`
  );
}

export interface HindsightDeps {
  api: HindsightApi;
  bank: string;
  state: StateDir;
  config: InstinctConfig;
  history?: HistoryArchive;
  items?: ItemArchive;
  audit?: AuditLog;
  now?: () => Date;
}

interface Kept {
  bank: string;
  /** Document id -> hash of what was stored (ids starting "said:" in the replies bank). */
  docs: Record<string, string>;
}

/** Whether a bank's settings, as Hindsight reads them back, store text only and never make facts of it. */
export function isTextOnly(config: unknown): boolean {
  const c = ((config as { config?: unknown } | null)?.config ?? config) as Record<string, unknown> | null;
  return c?.retain_extraction_mode === "chunks" && c?.enable_observations === false;
}

export class HindsightMemory {
  private kept: Kept | undefined;
  private bankReady = false;
  private saidReady = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: HindsightDeps) {}

  /** The bank of what Sunshine said: text only, never facts. */
  get saidBank(): string {
    return `${this.deps.bank}-said`;
  }

  private bankOf(docId: string): string {
    return docId.startsWith(SAID) ? this.saidBank : this.deps.bank;
  }

  private tz(): string {
    return this.deps.config.owner.timezone || "UTC";
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  private zoneLine(): string {
    return `Times are ${this.tz()} time unless it names another zone.`;
  }

  private itemDoc(it: ArchiveItem): HindsightDoc {
    const owner = this.deps.config.owner.name;
    const words = SOURCES[it.source]?.words ?? `from ${it.source}`;
    const caveat = SOURCES[it.source]?.caveat;
    // Recordings and the band stamp each line with the time into the conversation ("[12:34]"), not the time of day.
    const intoIt = /^\[\d{1,2}:\d{2}(?::\d{2})?\]/m.test(it.text) ? "Each line starts with the time into the conversation, not the time of day. " : "";
    const withWhom = it.people?.length ? `, with ${it.people.join(", ")}` : "";
    // A source with no words of its own (email, later team chat) is named as what it is, not called a conversation.
    const what = SOURCES[it.source] ? `A conversation of ${owner}'s, ${words}${withWhom}.` : `From ${owner}'s ${it.source}.`;
    const context = `${what} ${caveat ? `${caveat} ` : ""}${intoIt}${this.zoneLine()}`;
    const timestamp = localIso(it.startedAt, this.tz());
    const metadata = { source: it.source, ...(it.title ? { title: it.title.slice(0, 200) } : {}) };
    return { id: itemDocId(it.id), content: it.text, timestamp, context, metadata, hash: hashOf(`${timestamp}|${context}|${it.text}`) };
  }

  private spellDoc(key: string, entries: HistoryEntry[]): HindsightDoc {
    const owner = this.deps.config.owner.name;
    const first = entries[0]!.ts;
    const content = entries.map((e) => `${stamp(e.ts, this.tz())} ${owner}: ${e.text.replace(/\s+/g, " ").trim()}`).join("\n");
    const context = `${owner}'s own text messages to ${this.deps.config.agent.name}, their personal AI assistant (only ${owner}'s side of the chat). ${this.zoneLine()}`;
    const timestamp = localIso(first, this.tz());
    return { id: `chat:${hashOf(key).slice(0, 6)}:${first}`, content, timestamp, context, metadata: { source: "chat" }, hash: hashOf(`${timestamp}|${context}|${content}`) };
  }

  /** What Sunshine said in a spell: its replies, the texts it sent from elsewhere and the runtime's notes of them. */
  private saidDoc(key: string, entries: HistoryEntry[]): HindsightDoc {
    const { owner, agent } = this.deps.config;
    const first = entries[0]!.ts;
    const content = entries.map((e) => `${stamp(e.ts, this.tz())} ${e.who === "note" ? "(note)" : agent.name}: ${e.text.replace(/\s+/g, " ").trim()}`).join("\n");
    const context = `What ${agent.name}, ${owner.name}'s personal AI assistant, said to ${owner.name}: its own replies and the texts it sent (as said then, not facts). ${this.zoneLine()}`;
    const timestamp = localIso(first, this.tz());
    return { id: `${SAID}${hashOf(key).slice(0, 6)}:${first}`, content, timestamp, context, metadata: { source: "said" }, hash: hashOf(`${timestamp}|${context}|${content}`) };
  }

  /**
   * What should be in Hindsight now, oldest first: every kept item, every spell of the owner's messages that has gone
   * quiet, and (in the replies bank) every quiet spell of what Sunshine said; `wakeAt`: when a spell still going on goes
   * quiet.
   */
  documents(): { docs: Array<HindsightDoc & { at: number }>; wakeAt?: number } {
    const now = this.now();
    const docs: Array<HindsightDoc & { at: number }> = [];
    let wakeAt: number | undefined;
    for (const it of this.deps.items?.all() ?? []) if (it.text.trim()) docs.push({ ...this.itemDoc(it), at: it.startedAt });
    const entries = this.deps.history?.all() ?? [];
    const sides: Array<[Array<HistoryEntry["who"]>, (key: string, e: HistoryEntry[]) => HindsightDoc]> = [
      [["owner"], (k, e) => this.spellDoc(k, e)],
      [["agent", "note"], (k, e) => this.saidDoc(k, e)],
    ];
    for (const [who, make] of sides) {
      for (const s of spells(entries, who)) {
        const quietAt = s.entries[s.entries.length - 1]!.ts + SPELL_QUIET_MS;
        if (quietAt > now) wakeAt = Math.min(wakeAt ?? quietAt, quietAt);
        else docs.push({ ...make(s.key, s.entries), at: s.entries[0]!.ts });
      }
    }
    return { docs: docs.sort((a, b) => a.at - b.at), ...(wakeAt !== undefined ? { wakeAt } : {}) };
  }

  private load(): Kept {
    if (this.kept?.bank === this.deps.bank) return this.kept;
    const saved = this.deps.state.readJson<Kept>(HINDSIGHT_FILE, { bank: this.deps.bank, docs: {} });
    // What another bank holds says nothing about this one.
    this.kept = saved.bank === this.deps.bank && saved.docs && typeof saved.docs === "object" ? saved : { bank: this.deps.bank, docs: {} };
    return this.kept;
  }

  private save(): void {
    if (this.kept) this.deps.state.writeJson(HINDSIGHT_FILE, this.kept);
  }

  private async ensureBank(): Promise<void> {
    if (this.bankReady) return;
    // The makers' integrations stamp a bank's settings on first use; "create" updates a bank that exists.
    await this.deps.api.createBank(this.deps.bank, { retainMission: retainMission(this.deps.config.owner.name), retainExtractionMode: "concise", enableObservations: true });
    this.bankReady = true;
  }

  /** The replies bank, set up text only and read back: nothing is stored there unless Hindsight confirms it. */
  private async ensureSaidBank(): Promise<void> {
    if (this.saidReady) return;
    await this.deps.api.createBank(this.saidBank, { retainExtractionMode: "chunks", enableObservations: false });
    if (!isTextOnly(await this.deps.api.getBankConfig(this.saidBank))) throw new Error(`bank ${this.saidBank} is not text only (chunks, observations off)`);
    this.saidReady = true;
  }

  /** Store after a pause, in the background; a failure is audited, never thrown. */
  schedule(delayMs = SYNC_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync().catch(() => undefined);
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /**
   * Make Hindsight follow the archive: delete what is no longer there, store what is new or changed (oldest first, as it
   * arrived, so the newest version wins), one at a time. One run at a time; a change during a run makes it run again.
   */
  async sync(): Promise<{ stored: number; deleted: number; failed: number }> {
    if (this.running) {
      this.again = true;
      await this.running;
      return { stored: 0, deleted: 0, failed: 0 };
    }
    let result = { stored: 0, deleted: 0, failed: 0 };
    this.running = (async () => {
      const started = Date.now();
      const { docs, wakeAt } = this.documents();
      const kept = this.load();
      const want = new Map(docs.map((d) => [d.id, d]));
      const gone = Object.keys(kept.docs).filter((id) => !want.has(id));
      const todo = docs.filter((d) => kept.docs[d.id] !== d.hash);
      let stored = 0;
      let deleted = 0;
      let failed = 0;
      const fail = (doc: string, error: unknown) => {
        failed++;
        this.deps.audit?.append({ kind: "error", detail: { hindsight: "store failed", doc, message: error instanceof Error ? error.message : String(error) } });
      };
      if (gone.length > 0 || todo.length > 0) {
        // Each document in its bank, the bank set up first: a replies bank that is not text only stops the replies only.
        const ready = (id: string) => (id.startsWith(SAID) ? this.ensureSaidBank() : this.ensureBank());
        for (const id of gone) {
          try {
            await ready(id);
            await this.deps.api.deleteDocument(this.bankOf(id), id);
          } catch (error) {
            // Already gone there is gone.
            if ((error as { statusCode?: number }).statusCode !== 404) {
              fail(id, error);
              continue;
            }
          }
          delete kept.docs[id];
          deleted++;
          this.save();
        }
        for (const d of todo) {
          try {
            await ready(d.id);
            const reply = await this.deps.api.retainBatch(this.bankOf(d.id), [{ content: d.content, timestamp: d.timestamp, context: d.context, metadata: d.metadata, document_id: d.id }], { async: false });
            kept.docs[d.id] = d.hash;
            stored++;
            this.save();
            this.deps.audit?.append({ kind: "policy", detail: { hindsight: { stored: d.id, chars: d.content.length, usage: reply.usage ?? null } } });
          } catch (error) {
            fail(d.id, error);
          }
        }
        this.deps.audit?.append({ kind: "policy", detail: { hindsight: { stored, deleted, failed, waiting: todo.length - stored - failed, ms: Date.now() - started } } });
      }
      result = { stored, deleted, failed };
      // A spell still going on goes in once it is quiet; a failure is tried again later.
      const next = failed > 0 ? RETRY_MS : wakeAt !== undefined ? wakeAt - this.now() : undefined;
      if (next !== undefined && !this.again) this.schedule(next);
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
    if (this.again) {
      this.again = false;
      this.schedule(0);
    }
    return result;
  }

  /**
   * Every fact whose event falls on the days asked ("2026-11-03" or "2026-11-02/2026-11-08", in the owner's days), in
   * time order. A date without a time is kept as that day's midnight UTC, so the window asked is widened to hold it
   * wherever the owner lives, then each fact is checked against the day it means. On 30 Oct one invitation email gave six
   * near-identical facts for the same evening, so: one fact per source and event time, and the facts an observation
   * (Hindsight's consolidated view) was built from left out for it, as the makers' preferObservations does in recall.
   */
  async byDate(days: string[]): Promise<HindsightFact[]> {
    const tz = this.tz();
    const out = new Map<string, HindsightFact>();
    const seen = new Set<string>();
    for (const d of days) {
      const span = parseSpan(d);
      if (!span) continue;
      const after = addDays(span.last, 1);
      const start = Math.min(Date.parse(midnightIn(span.first, tz)), Date.parse(`${span.first}T00:00:00Z`));
      const end = Math.max(Date.parse(midnightIn(after, tz)), Date.parse(`${after}T00:00:00Z`));
      const page = await this.deps.api.listMemories(this.deps.bank, { timeField: "occurred_start", startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), state: "valid", limit: PER_SPAN });
      for (const f of page.items ?? []) {
        const day = factDay(f, tz);
        // To the minute: Hindsight adds a few ms to each fact's time to keep them in order.
        const same = `${f.document_id ?? f.id}|${Math.floor(Date.parse(f.occurred_start ?? "") / 60_000)}`;
        if (!day || day < span.first || day > span.last || seen.has(same)) continue;
        seen.add(same);
        out.set(f.id, f);
      }
    }
    const consolidated = new Set([...out.values()].flatMap((f) => f.source_memory_ids ?? []));
    for (const id of consolidated) out.delete(id);
    return [...out.values()].sort((a, b) => Date.parse(a.occurred_start ?? "") - Date.parse(b.occurred_start ?? ""));
  }

  /**
   * The main bank's facts closest to `query` by Hindsight's own search (meaning, words, time and links, re-ranked), "now" as
   * given. Observations instead of the facts they were built from, as the makers' `preferObservations` does (2026-10-30, on
   * the time-check bank: one invitation 7 lines without it, 1 with it, the right fact first either way). An observation
   * names no document or text of its own, so it takes those of its first source fact.
   */
  private async recallKnown(query: string, now: Date, chunks: boolean): Promise<{ facts: HindsightFact[]; chunks: Record<string, { id: string; text: string }> }> {
    const res = await this.deps.api.recall(this.deps.bank, clip(query, QUERY_MAX), {
      budget: "mid",
      maxTokens: RECALL_TOKENS,
      queryTimestamp: localIso(now.getTime(), this.tz()),
      types: ["observation", "world", "experience"],
      preferObservations: true,
      includeSourceFacts: true,
      maxSourceFactsTokens: SOURCE_FACT_TOKENS,
      ...(chunks ? { includeChunks: true, maxChunkTokens: CHUNK_TOKENS } : {}),
    });
    const sources = res.source_facts ?? {};
    const facts = (res.results ?? []).map((f) => {
      if (f.document_id) return f;
      const from = (f.source_fact_ids ?? []).map((id) => sources[id]).find((s) => s?.document_id);
      return from ? { ...f, document_id: from.document_id, chunk_id: f.chunk_id ?? from.chunk_id ?? null, metadata: f.metadata ?? from.metadata ?? null } : f;
    });
    return { facts, chunks: res.chunks ?? {} };
  }

  /** The facts closest to `query`, for recall (recallKnown). */
  async byMeaning(query: string, now: Date): Promise<HindsightFact[]> {
    return (await this.recallKnown(query, now, false)).facts;
  }

  /** For the agent's own search: the facts closest to `query`, with the pieces of text they came from. */
  async searchKnown(query: string, now: Date): Promise<{ facts: HindsightFact[]; chunks: Record<string, { id: string; text: string }> }> {
    return this.recallKnown(query, now, true);
  }

  /** For the agent's own search: what Sunshine said closest to `query`, word for word (the replies bank). */
  async searchSaid(query: string, now: Date): Promise<HindsightFact[]> {
    const res = await this.deps.api.recall(this.saidBank, clip(query, QUERY_MAX), { budget: "mid", maxTokens: SAID_TOKENS, queryTimestamp: localIso(now.getTime(), this.tz()) });
    return res.results ?? [];
  }
}

/**
 * Whether a stored time is a date only, and whose: Hindsight keeps a date written without a zone as midnight UTC, and one
 * written with the owner's offset (as the documents now carry) as the owner's midnight (2026-10-30 check: "bought on 25
 * Feb" kept as 24 Feb 23:00 UTC); plus at most a few ms it adds for order.
 */
function dateKind(iso: string, tz: string): "utc-date" | "local-date" | "time" {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "time";
  if (ms % 86_400_000 < 1_000) return "utc-date";
  const p = parts(ms, tz);
  return p.hour === "00" && p.minute === "00" && p.second === "00" ? "local-date" : "time";
}

/** The owner's day a fact's event falls on, YYYY-MM-DD. */
function factDay(f: HindsightFact, tz: string): string | undefined {
  if (!f.occurred_start) return undefined;
  const ms = Date.parse(f.occurred_start);
  if (Number.isNaN(ms)) return undefined;
  if (ms % 86_400_000 < 1_000) return new Date(ms).toISOString().slice(0, 10);
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export interface HindsightRecallDeps {
  memory: HindsightMemory;
  config: InstinctConfig;
  items?: ItemArchive;
  audit?: AuditLog;
  /** Answers when Hindsight fails or is slow (today's recall by the agent's own meaning search). */
  fallback?: Recall;
  waitMs?: number;
  now?: () => Date;
}

/** Where a fact came from, in words: "their own texts", "recorded on their phone: Server talk", "from email: <subject>". */
function sourceOf(f: HindsightFact, items?: ItemArchive): string {
  const id = f.document_id ?? "";
  if (id.startsWith("chat:")) return "their own texts";
  const it = id.startsWith("item:") ? items?.get(id.slice("item:".length)) : undefined;
  const meta = (k: string) => (typeof f.metadata?.[k] === "string" ? (f.metadata[k] as string) : undefined);
  const source = it?.source ?? meta("source");
  const title = it?.title ?? it?.summary?.title ?? meta("title");
  if (!source) return "";
  return `${SOURCES[source]?.words ?? `from ${source}`}${title ? `: ${clip(title, 80)}` : ""}`;
}

/** A fact as one line: when it happens and when it was noted (the owner's time), the fact, where it came from. */
function factLine(config: InstinctConfig, items?: ItemArchive): (f: HindsightFact) => string {
  const tz = () => config.owner.timezone || "UTC";
  const day = (iso: string) => {
    const kind = dateKind(iso, tz());
    const date = { weekday: "short", day: "numeric", month: "short", year: "numeric" } as const;
    const at = new Date(Date.parse(iso));
    if (kind === "utc-date") return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...date }).format(at);
    if (kind === "local-date") return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), ...date }).format(at);
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), ...date, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  };
  const noted = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz(), day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.parse(iso)));
  const origin = (f: HindsightFact): string => {
    const s = sourceOf(f, items);
    return s ? ` (${s})` : "";
  };
  return (f: HindsightFact): string => {
    const when = [
      ...(f.occurred_start && !Number.isNaN(Date.parse(f.occurred_start)) ? [`happens ${day(f.occurred_start)}`] : []),
      ...(f.mentioned_at && !Number.isNaN(Date.parse(f.mentioned_at)) ? [`noted ${noted(f.mentioned_at)}`] : []),
    ].join("; ");
    return `${when ? `[${when}] ` : ""}${clip(f.text ?? "", LINE_MAX)}${origin(f)}`;
  };
}

/**
 * Recall through Hindsight, the same seam as recall.ts: for the days asked (opts.days), every fact by when it happens; for
 * the rest, the queries as one search by meaning. The item itself and chats from `chatsBefore` on left out. The main bank
 * only: what Sunshine said is not brought along unasked.
 */
export function createHindsightRecall(deps: HindsightRecallDeps): Recall {
  const now = () => deps.now?.() ?? new Date();
  const show = factLine(deps.config, deps.items);

  return async (queries, opts = {}) => {
    const asked = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
    const days = opts.days?.filter((d) => d.trim()) ?? [];
    if (asked.length === 0 && days.length === 0) return undefined;
    const keep = (f: HindsightFact) =>
      Boolean(f.text?.trim()) &&
      !(opts.exclude !== undefined && f.document_id === itemDocId(opts.exclude)) &&
      !(opts.chatsBefore !== undefined && f.document_id?.startsWith("chat:") && Date.parse(f.mentioned_at ?? "") >= opts.chatsBefore);
    const started = Date.now();
    let dated: HindsightFact[];
    let near: HindsightFact[];
    try {
      [dated, near] = await within(
        Promise.all([days.length > 0 ? deps.memory.byDate(days) : Promise.resolve([]), asked.length > 0 ? deps.memory.byMeaning(asked.join("; "), now()) : Promise.resolve([])]),
        deps.waitMs ?? WAIT_MS,
      );
    } catch (error) {
      deps.audit?.append({ kind: "error", detail: { recall: deps.fallback ? "Hindsight failed, meaning search answered" : "Hindsight failed", message: error instanceof Error ? error.message : String(error) } });
      return deps.fallback ? deps.fallback(queries, opts) : undefined;
    }
    const byDate = dated.filter(keep).slice(0, BY_DATE_MAX);
    // Shown once: what the date list holds, and the facts its observations were built from.
    const listed = new Set([...byDate.map((f) => f.id), ...byDate.flatMap((f) => f.source_memory_ids ?? [])]);
    const related = near.filter((f) => keep(f) && !listed.has(f.id));
    deps.audit?.append({ kind: "policy", detail: { recall: { engine: "hindsight", days: days.length, byDate: byDate.length, related: related.length, ms: Date.now() - started } } });
    const blocks = [
      ...(byDate.length > 0 ? [["On the days it concerns, by when each thing happens:", ...byDate.map(show)].join("\n")] : []),
      ...(related.length > 0 ? [["Related, best first:", ...related.map(show)].join("\n")] : []),
    ];
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };
}

export interface HindsightSearchDeps {
  memory: HindsightMemory;
  config: InstinctConfig;
  items?: ItemArchive;
  audit?: AuditLog;
  now?: () => Date;
}

/**
 * The agent's own search (history_search) through Hindsight, the one search: what is known, best first; the pieces of text
 * the best facts came from (who said what, as said); what Sunshine itself said, word for word, from the replies bank.
 * `range` (ms) keeps what was said or noted in it. The main bank failing is thrown (word search over the archive then
 * answers); the replies bank failing leaves its part out.
 */
export function createHindsightSearch(deps: HindsightSearchDeps): (query: string, range?: { since?: number; until?: number }) => Promise<string | undefined> {
  const { owner, agent } = deps.config;
  const now = () => deps.now?.() ?? new Date();
  const show = factLine(deps.config, deps.items);
  return async (query, range = {}) => {
    const inRange = (f: HindsightFact) => {
      const at = Date.parse(f.mentioned_at ?? f.occurred_start ?? "");
      return Number.isNaN(at) || ((range.since === undefined || at > range.since) && (range.until === undefined || at <= range.until));
    };
    const started = Date.now();
    const [known, said] = await Promise.all([
      deps.memory.searchKnown(query, now()),
      deps.memory.searchSaid(query, now()).catch((error: unknown) => {
        deps.audit?.append({ kind: "error", detail: { memorySearch: "replies bank left out", message: error instanceof Error ? error.message : String(error) } });
        return [] as HindsightFact[];
      }),
    ]);
    const facts = known.facts.filter((f) => f.text?.trim() && inRange(f)).slice(0, SEARCH_FACTS);
    // The text behind the best facts, each piece once.
    const pieces: string[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      const c = f.chunk_id ? known.chunks[f.chunk_id] : undefined;
      if (!c?.text?.trim() || seen.has(c.id) || pieces.length >= SOURCE_PIECES) continue;
      seen.add(c.id);
      const text = c.text.trim().length <= SOURCE_CHARS ? c.text.trim() : `${c.text.trim().slice(0, SOURCE_CHARS - 1)}…`;
      pieces.push([`(${sourceOf(f, deps.items) || "kept"})`, ...text.split("\n").map((l) => `  ${l}`)].join("\n"));
    }
    const ownWords = said.filter((f) => f.text?.trim() && inRange(f)).slice(0, SAID_SHOWN).map((f) => clip(f.text ?? "", SAID_CHARS));
    deps.audit?.append({ kind: "policy", detail: { memorySearch: { facts: facts.length, pieces: pieces.length, said: ownWords.length, ms: Date.now() - started } } });
    const blocks = [
      ...(facts.length > 0 ? [[`What you know, best first (from what ${owner.name} told you and what reached them; dated, so things may have changed since):`, ...facts.map(show)].join("\n")] : []),
      ...(pieces.length > 0 ? [["The text it came from:", ...pieces].join("\n")] : []),
      ...(ownWords.length > 0 ? [[`What you (${agent.name}) said to ${owner.name} before, word for word (your words then, not facts: check anything about other systems again):`, ...ownWords].join("\n")] : []),
    ];
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };
}
