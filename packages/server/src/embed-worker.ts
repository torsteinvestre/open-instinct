/**
 * [sunshine:meaning-search] The search model's own process (started by embedder.ts). Measured on the live agent
 * (2026-10-25): released inside the agent's process, the model left about 0.75 GB held (RSS 160 MB before, 1,788 MB
 * loaded, 923 MB after the release), so the machine had 0.7 GB less room all the time. A process that exits gives
 * all of its memory back; and if memory ever runs out, Linux stops the biggest process, which is then this one,
 * not the agent (it also offers itself first: oom_score_adj 500).
 *
 * Messages from the parent: { type: "init", ... } once, then { type: "embed", id, text }; answers
 * { type: "ready" } / { type: "error", message } / { type: "vector", id, data } / { type: "failed", id, message }.
 */
import fs from "node:fs";

interface Init {
  type: "init";
  cacheDir: string;
  model: string;
  revision: string;
  dtype: string;
  threads: number;
}
interface Embed {
  type: "embed";
  id: number;
  text: string;
}

type Extract = (text: string, opts: { pooling: "last_token"; normalize: true }) => Promise<{ data: Float32Array | ArrayLike<number> }>;
let extract: Extract | undefined;

const send = (message: unknown) => process.send?.(message);

try {
  fs.writeFileSync("/proc/self/oom_score_adj", "500");
} catch {
  // Not Linux, or not allowed: the agent is still protected by this process being the biggest.
}

process.on("message", async (raw: Init | Embed) => {
  if (raw.type === "init") {
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = raw.cacheDir;
      extract = (await pipeline("feature-extraction", raw.model, {
        revision: raw.revision,
        dtype: raw.dtype as "q4",
        device: "cpu",
        session_options: { intraOpNumThreads: raw.threads, interOpNumThreads: 1 },
      })) as unknown as Extract;
      send({ type: "ready" });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (raw.type === "embed") {
    try {
      if (!extract) throw new Error("the search model is not loaded");
      const out = await extract(raw.text, { pooling: "last_token", normalize: true });
      send({ type: "vector", id: raw.id, data: out.data instanceof Float32Array ? out.data : Float32Array.from(out.data) });
    } catch (error) {
      send({ type: "failed", id: raw.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
});

// The parent going away leaves nothing to serve.
process.on("disconnect", () => process.exit(0));
