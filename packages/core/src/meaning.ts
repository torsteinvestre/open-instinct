/**
 * [sunshine:meaning-search] Search by meaning over the owner's kept conversations (history.ts) and what
 * reached them from elsewhere (items.ts). Word search finds what was said in the same words; asked in
 * other words ("ring people" for phone calls, "target group" for "age groups") it misses. Tested
 * 2026-10-24/25 on 25 real questions about the owner's own work (sunshine-ops NOTES, "Memory trial" and
 * "IN-AGENT CHECK"): word search found 7, a search model 16, its 4-bit version, which fits an agent's
 * machine, 15.
 *
 * The archives stay the record. This keeps the model's meaning numbers (a vector) for each piece of
 * about PIECE_CHARS of consecutive text, keyed by a hash of the piece's text: a piece whose text changes
 * (a thread grows, the owner forgets a line) gets a new key, and vectors no piece uses any more are
 * removed, so nothing forgotten stays behind here. A search ranks the pieces by meaning and by words
 * (BM25) and merges the two (weighted, as OpenClaw's memory_search does): exact names and numbers come
 * from the word side, other wordings from the meaning side.
 */
import { createHash } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { queryWords, type HistoryArchive, type HistoryEntry, type HistoryRange } from "./history.js";
import { summaryLines, type ArchiveItem, type ItemArchive } from "./items.js";
import type { StateDir } from "./state.js";
import type { InstinctConfig } from "./types.js";

export const MEANING_FILE = "history/meaning.json";
/** About 450 tokens: the size tested (smaller pieces found more than larger ones). */
export const PIECE_CHARS = 1800;
/** A pause this long between two messages of a thread starts a new piece: another conversation. */
const PIECE_GAP_MS = 60 * 60 * 1000;
/** How many pieces each side (meaning, words) puts forward before the two lists are merged. */
const CANDIDATES = 50;
/** After a change, wait this long for more before storing (a conversation usually goes on). */
export const SYNC_DELAY_MS = 30_000;
/** The store is written after this many new vectors, so a long first run keeps its progress. */
const SAVE_EVERY = 25;

/** The search model, run wherever the server runs it. */
export interface Embedder {
  /** The model and its version: vectors made by another one are made again. */
  readonly model: string;
  /** One unit-length vector per text. A query gets the model's search instruction; a document none. */
  embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]>;
}

interface PieceBase {
  /** Hash of the piece's text: the key of its vector. */
  hash: string;
  /** When it starts (ms): for date ranges and display. */
  ts: number;
  /** The lines as stored and shown. */
  lines: string[];
}

/** A stretch of one of the owner's threads. */
export interface ChatPiece extends PieceBase {
  kind: "chat";
}

/** A stretch of an item's text, or its summary. */
export interface ItemPiece extends PieceBase {
  kind: "item";
  item: ArchiveItem;
  part: "summary" | "text";
}

export type Piece = ChatPiece | ItemPiece;

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** "[12:34] Sarah:" or "[2026-10-24 12:00] Torstein:" at a line's start, kept in front of its continuations. */
function speakerOf(line: string): string {
  return /^\[[^\]\n]{1,20}\]\s*[^:\n]{1,40}:/.exec(line)?.[0] ?? "";
}

/** A line longer than a piece, cut into piece-sized parts, each continuation marked and with its speaker. */
function splitLong(line: string): string[] {
  if (line.length <= PIECE_CHARS) return [line];
  const speaker = speakerOf(line);
  const out = [line.slice(0, PIECE_CHARS)];
  const step = PIECE_CHARS - speaker.length - 2;
  for (let at = PIECE_CHARS; at < line.length; at += step) out.push(`${speaker} …${line.slice(at, at + step)}`);
  return out;
}

/**
 * Lines gathered into pieces of at most PIECE_CHARS, in order; `breakBefore(i)` starts a new piece at
 * line i. Each piece says which line it starts in (`first`), so it can be dated.
 */
function gather(lines: string[], breakBefore: (i: number) => boolean = () => false): Array<{ lines: string[]; first: number }> {
  const pieces: Array<{ lines: string[]; first: number }> = [];
  let cur: string[] = [];
  let first = 0;
  let size = 0;
  const flush = () => {
    if (cur.length > 0) pieces.push({ lines: cur, first });
    cur = [];
    size = 0;
  };
  for (const [i, line] of lines.entries()) {
    if (breakBefore(i)) flush();
    for (const part of splitLong(line)) {
      if (cur.length > 0 && size + part.length + 1 > PIECE_CHARS) flush();
      if (cur.length === 0) first = i;
      cur.push(part);
      size += part.length + 1;
    }
  }
  flush();
  return pieces;
}

/** "[2026-10-24 12:00]" in the owner's timezone. */
function stamp(ts: number, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return `[${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}]`;
}

/** The owner's threads as pieces: consecutive messages of one thread, a new piece after a long pause. */
export function chatPieces(entries: HistoryEntry[], config: InstinctConfig): ChatPiece[] {
  const tz = config.owner.timezone || "UTC";
  const name = (e: HistoryEntry) => (e.who === "owner" ? config.owner.name : e.who === "agent" ? config.agent.name : "(note)");
  const threads = new Map<string, HistoryEntry[]>();
  for (const e of entries) threads.set(e.key, [...(threads.get(e.key) ?? []), e]);
  const out: ChatPiece[] = [];
  for (const thread of threads.values()) {
    const lines = thread.map((e) => `${stamp(e.ts, tz)} ${name(e)}: ${e.text.replace(/\s+/g, " ")}`);
    for (const piece of gather(lines, (i) => i > 0 && thread[i]!.ts - thread[i - 1]!.ts > PIECE_GAP_MS)) {
      out.push({ kind: "chat", hash: hashOf(piece.lines.join("\n")), ts: thread[piece.first]!.ts, lines: piece.lines });
    }
  }
  return out;
}

/** An item as pieces: its summary (with the title) as one, then its text in stretches. */
export function itemPieces(item: ArchiveItem): ItemPiece[] {
  const out: ItemPiece[] = [];
  const title = item.title ?? item.summary?.title;
  if (item.summary) {
    const lines = [...(title ? [title] : []), ...summaryLines(item.summary)];
    if (lines.length > 0) out.push({ kind: "item", item, part: "summary", hash: hashOf(lines.join("\n")), ts: item.startedAt, lines });
  }
  const text = item.text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const piece of gather(text)) out.push({ kind: "item", item, part: "text", hash: hashOf(piece.lines.join("\n")), ts: item.startedAt, lines: piece.lines });
  return out;
}

/** Words for BM25: letters and digits in any script, as word search reads a query. */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
}

/** BM25 scores of each document for the query words (k1 1.2, b 0.75); words common to most pieces count little. */
function bm25(docs: string[][], words: string[]): number[] {
  const n = docs.length;
  if (n === 0 || words.length === 0) return docs.map(() => 0);
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const counts = docs.map((d) => {
    const c = new Map<string, number>();
    for (const w of d) c.set(w, (c.get(w) ?? 0) + 1);
    return c;
  });
  const idf = new Map(words.map((w) => {
    const df = counts.filter((c) => c.has(w)).length;
    return [w, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  return counts.map((c, i) => {
    let score = 0;
    for (const w of words) {
      const tf = c.get(w) ?? 0;
      if (tf > 0) score += idf.get(w)! * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * docs[i]!.length) / avg)));
    }
    return score;
  });
}

function toBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

function fromBase64(s: string): Float32Array {
  const bytes = Buffer.from(s, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

interface Store {
  model: string;
  vectors: Record<string, string>;
}

export interface MeaningSearchDeps {
  state: StateDir;
  embedder: Embedder;
  config: InstinctConfig;
  history?: HistoryArchive;
  items?: ItemArchive;
  audit?: AuditLog;
}

/**
 * "both": meaning and words merged, 0.7 x closeness of meaning + 0.3 x the word score scaled to the best
 * closeness (OpenClaw's way). On the 25 questions through this code (2026-10-25) it found 16 / 17 (as
 * asked / either of two searches), meaning alone 16 / 17, rank fusion (Hindsight's way: places count,
 * not how close) 15 / 16, words alone (BM25) 11 / 11; merged keeps exact names and numbers findable,
 * which meaning alone misses. "meaning" or "words": one side only, for comparing.
 */
export type SearchMode = "both" | "meaning" | "words";
/** OpenClaw's default share of meaning in the merge. */
const MEANING_WEIGHT = 0.7;

export class MeaningSearch {
  private store: Store | undefined;
  private decoded = new Map<string, Float32Array>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: MeaningSearchDeps) {}

  /** Every piece of the archives as they are now. */
  pieces(): Piece[] {
    const chat = this.deps.history ? chatPieces(this.deps.history.all(), this.deps.config) : [];
    const items = this.deps.items ? this.deps.items.all().flatMap(itemPieces) : [];
    return [...chat, ...items];
  }

  private load(): Store {
    const model = this.deps.embedder.model;
    if (this.store?.model === model) return this.store;
    const saved = this.deps.state.readJson<Store>(MEANING_FILE, { model, vectors: {} });
    // Vectors from another model (or version) mean nothing to this one: start again.
    this.store = saved.model === model && saved.vectors && typeof saved.vectors === "object" ? saved : { model, vectors: {} };
    this.decoded.clear();
    return this.store;
  }

  private save(): void {
    if (this.store) this.deps.state.writeText(MEANING_FILE, JSON.stringify(this.store));
  }

  private vector(hash: string): Float32Array | undefined {
    let v = this.decoded.get(hash);
    if (!v) {
      const s = this.load().vectors[hash];
      if (!s) return undefined;
      v = fromBase64(s);
      this.decoded.set(hash, v);
    }
    return v;
  }

  /** How many pieces exist and how many have their vector. */
  status(): { pieces: number; stored: number } {
    const hashes = new Set(this.pieces().map((p) => p.hash));
    const store = this.load();
    return { pieces: hashes.size, stored: [...hashes].filter((h) => store.vectors[h]).length };
  }

  /** Remove at once the vectors no piece uses any more (after a forget); no model needed. Returns how many. */
  prune(): number {
    const want = new Set(this.pieces().map((p) => p.hash));
    const store = this.load();
    let removed = 0;
    for (const h of Object.keys(store.vectors)) {
      if (want.has(h)) continue;
      delete store.vectors[h];
      this.decoded.delete(h);
      removed++;
    }
    if (removed > 0) this.save();
    return removed;
  }

  /** Store the vectors of new pieces after a pause, in the background; a failure is audited, never thrown. */
  schedule(delayMs = SYNC_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  /**
   * Remove vectors no piece uses, then make the missing ones, newest pieces first, one at a time (a search
   * can slip in between). One run at a time; a change during a run makes it run again afterwards.
   */
  async sync(): Promise<{ added: number; removed: number }> {
    if (this.running) {
      this.again = true;
      await this.running;
      return { added: 0, removed: 0 };
    }
    let result = { added: 0, removed: 0 };
    this.running = (async () => {
      const started = Date.now();
      const removed = this.prune();
      const store = this.load();
      // One per text (two pieces with the same text share a vector), newest first.
      const byHash = new Map<string, Piece>();
      for (const p of this.pieces()) if (!store.vectors[p.hash] && !byHash.has(p.hash)) byHash.set(p.hash, p);
      const missing = [...byHash.values()].sort((a, b) => b.ts - a.ts);
      let added = 0;
      try {
        for (const p of missing) {
          const [v] = await this.deps.embedder.embed([p.lines.join("\n")], "document");
          if (!v) continue;
          // The model may have changed under a long run (a new version deployed): then stop.
          if (this.store !== store) break;
          store.vectors[p.hash] = toBase64(v);
          added++;
          if (added % SAVE_EVERY === 0) this.save();
        }
      } catch (error) {
        this.deps.audit?.append({ kind: "error", detail: { meaningIndex: "storing failed", message: error instanceof Error ? error.message : String(error), added, missing: missing.length } });
      } finally {
        if (added > 0) this.save();
      }
      if (added > 0 || removed > 0) {
        this.deps.audit?.append({ kind: "policy", detail: { meaningIndex: { added, removed, missing: missing.length - added, ms: Date.now() - started } } });
      }
      result = { added, removed };
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
   * The pieces in the range, best first: by meaning and by words, merged (see SearchMode). Throws when
   * the query cannot be turned into a vector.
   */
  async search(query: string, range: HistoryRange = {}, mode: SearchMode = "both"): Promise<Piece[]> {
    return (await this.searchScored(query, range, mode)).map((h) => h.piece);
  }

  /**
   * [sunshine:in-the-flow] As `search`, with each piece's merged score and how close its meaning is to the query
   * (cosine, 0-1; absent in word mode or for a piece not stored yet), so a caller can leave out weak matches.
   */
  async searchScored(query: string, range: HistoryRange = {}, mode: SearchMode = "both"): Promise<Array<{ piece: Piece; score: number; near?: number }>> {
    const inRange = (p: Piece) => (range.since === undefined || p.ts > range.since) && (range.until === undefined || p.ts <= range.until);
    const pieces = this.pieces().filter(inRange);
    if (pieces.length === 0 || !query.trim()) return [];
    let near: Array<[Piece, number]> = [];
    if (mode !== "words") {
      const [q] = await this.deps.embedder.embed([query], "query");
      if (!q) throw new Error("the search model returned nothing");
      for (const p of pieces) {
        const v = this.vector(p.hash);
        if (!v || v.length !== q.length) continue;
        let dot = 0;
        for (let k = 0; k < v.length; k++) dot += v[k]! * q[k]!;
        near.push([p, dot]);
      }
      near = near.sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES);
    }
    let wordy: Array<[Piece, number]> = [];
    if (mode !== "meaning") {
      const scores = bm25(pieces.map((p) => tokens(p.lines.join("\n"))), queryWords(query));
      wordy = pieces
        .map((p, i): [Piece, number] => [p, scores[i]!])
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1] || b[0].ts - a[0].ts)
        .slice(0, CANDIDATES);
    }

    // The word score is scaled so the best word match counts at most as much as the closest meaning.
    const score = new Map<Piece, number>();
    const bestNear = near[0]?.[1] ?? 1;
    const bestWords = wordy[0]?.[1] ?? 1;
    for (const [p, s] of near) score.set(p, MEANING_WEIGHT * s);
    for (const [p, s] of wordy) score.set(p, (score.get(p) ?? 0) + (1 - MEANING_WEIGHT) * (s / bestWords) * bestNear);
    const closeness = new Map(near);
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([piece, s]) => ({ piece, score: s, ...(closeness.has(piece) ? { near: closeness.get(piece)! } : {}) }));
  }
}
