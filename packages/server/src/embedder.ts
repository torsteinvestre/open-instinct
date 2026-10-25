/**
 * [sunshine:meaning-search] The search model on the agent's own machine: Qwen3-Embedding-0.6B (Apache
 * 2.0, multilingual) in its 4-bit ONNX version, run by Transformers.js on the CPU. Chosen 2026-10-25 by
 * a free test on 25 real questions run the way this file runs it (sunshine-ops NOTES "IN-AGENT CHECK"):
 * the 4-bit version found 15 / 17 against 16 / 18 for the full model, peaking at about 2.0 GB of memory;
 * the 8-bit one lost too many answers (9 / 14), half precision left too little memory (2.65 GB of about
 * 3 GB free).
 *
 * Nothing loads until a search or storing needs it (the import alone pulls in the ONNX runtime), and the
 * model is released after IDLE_MS without use, so most of the time it costs no memory. It is loaded
 * only when the machine has MIN_AVAILABLE_BYTES free, so it never pushes the agent itself out of
 * memory; word search answers meanwhile. One text at a time: two at once would double the peak.
 * The files (about 0.9 GB) are fetched once into the agent's data folder, at a pinned revision.
 */
import fs from "node:fs";
import type { Embedder } from "@open-instinct/core";

export const EMBED_MODEL = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
/** The repository's commit when tested (2026-10-25); a new one is tested before it is used. */
export const EMBED_REVISION = "c25a394dd583836952667c12f008335071b3f43d";
export const EMBED_DTYPE = "q4";
/** The model's own instruction for queries (its sentence-transformers "query" prompt); documents get none. */
const QUERY_INSTRUCTION = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
/** Released after this long without use. */
const IDLE_MS = 10 * 60 * 1000;
/** The peak measured (2.0 GB) plus room for the rest of the agent. */
const MIN_AVAILABLE_BYTES = 2.3 * 1024 ** 3;
/** After a failed load (no memory, no network), word search answers for this long before loading is tried again. */
const RETRY_MS = 5 * 60 * 1000;

/** What Transformers.js's feature-extraction pipeline offers, as used here. */
export interface Extractor {
  (text: string, opts: { pooling: "last_token"; normalize: true }): Promise<{ data: Float32Array | ArrayLike<number> }>;
  dispose(): Promise<void>;
}

export interface LocalEmbedderOptions {
  /** Where the model files are kept (the agent's data folder). */
  cacheDir: string;
  /** Threads for the model; the agent's machine has 2 cores. */
  threads?: number;
  idleMs?: number;
  /** Tests: a stand-in for loading the model. */
  load?: () => Promise<Extractor>;
  /** Tests: free memory in bytes; default from /proc/meminfo (MemAvailable). */
  availableBytes?: () => number | undefined;
  log?: (message: string) => void;
}

/** MemAvailable from /proc/meminfo in bytes; undefined where there is none (not Linux). */
function memAvailable(): number | undefined {
  try {
    const kb = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1];
    return kb ? Number(kb) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function createLocalEmbedder(opts: LocalEmbedderOptions): Embedder & { close(): Promise<void> } {
  const log = opts.log ?? (() => {});
  const idleMs = opts.idleMs ?? IDLE_MS;
  const load =
    opts.load ??
    (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = opts.cacheDir;
      const extractor = await pipeline("feature-extraction", EMBED_MODEL, {
        revision: EMBED_REVISION,
        dtype: EMBED_DTYPE,
        device: "cpu",
        session_options: { intraOpNumThreads: opts.threads ?? 2, interOpNumThreads: 1 },
      });
      return extractor as unknown as Extractor;
    });

  let extractor: Extractor | undefined;
  let loading: Promise<Extractor> | undefined;
  let failedAt = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const release = async () => {
    const e = extractor;
    extractor = undefined;
    if (e) {
      await e.dispose().catch(() => undefined);
      log("search model released (idle)");
    }
  };

  const ready = async (): Promise<Extractor> => {
    if (extractor) return extractor;
    if (Date.now() - failedAt < RETRY_MS) throw new Error("search model unavailable (failed recently)");
    const free = (opts.availableBytes ?? memAvailable)();
    if (free !== undefined && free < MIN_AVAILABLE_BYTES) {
      failedAt = Date.now();
      throw new Error(`not enough free memory for the search model (${Math.round(free / 1024 ** 2)} MiB)`);
    }
    loading ??= load()
      .then((e) => {
        log("search model loaded");
        return e;
      })
      .finally(() => {
        loading = undefined;
      });
    try {
      extractor = await loading;
      return extractor;
    } catch (error) {
      failedAt = Date.now();
      throw error;
    }
  };

  const one = async (text: string): Promise<Float32Array> => {
    const e = await ready();
    const out = await e(text, { pooling: "last_token", normalize: true });
    return out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  };

  return {
    model: `${EMBED_MODEL}@${EMBED_REVISION.slice(0, 8)}:${EMBED_DTYPE}`,
    embed(texts, kind) {
      const run = queue.then(async () => {
        if (idle) clearTimeout(idle);
        try {
          const out: Float32Array[] = [];
          for (const t of texts) out.push(await one(kind === "query" ? `${QUERY_INSTRUCTION}${t}` : t));
          return out;
        } finally {
          idle = setTimeout(() => void release(), idleMs);
          idle.unref?.();
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    async close() {
      if (idle) clearTimeout(idle);
      await queue;
      await release();
    },
  };
}
