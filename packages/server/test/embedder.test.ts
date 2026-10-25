// [sunshine:meaning-search] The search model on the agent's machine: loaded when needed, one text at a time,
// released when idle, never loaded without enough free memory. A stand-in replaces the real model here.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Embedder } from "@open-instinct/core";
import { boot } from "../src/boot.js";
import { createLocalEmbedder, type Extractor } from "../src/embedder.js";

const GB = 1024 ** 3;

function standIn() {
  const seen: string[] = [];
  let loads = 0;
  let disposed = 0;
  let busy = 0;
  let overlapped = false;
  const load = async (): Promise<Extractor> => {
    loads++;
    const run = (async (text: string) => {
      if (busy++ > 0) overlapped = true;
      seen.push(text);
      await new Promise((r) => setTimeout(r, 5));
      busy--;
      return { data: new Float32Array([1, 0]) };
    }) as Extractor;
    run.dispose = async () => {
      disposed++;
    };
    return run;
  };
  return { load, seen, stats: () => ({ loads, disposed, overlapped }) };
}

describe("local search model", () => {
  it("loads only when first used; a query gets the model's instruction, a document none", async () => {
    const s = standIn();
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load: s.load, availableBytes: () => 3 * GB });
    expect(s.stats().loads).toBe(0);
    await e.embed(["what did we decide"], "query");
    await e.embed(["[00:07] Sarah: hello"], "document");
    expect(s.seen).toEqual(["Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:what did we decide", "[00:07] Sarah: hello"]);
    expect(s.stats().loads).toBe(1);
    expect(e.model).toBe("onnx-community/Qwen3-Embedding-0.6B-ONNX@c25a394d:q4");
    await e.close();
  });

  it("runs one text at a time, even when storing and a search ask together", async () => {
    const s = standIn();
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load: s.load, availableBytes: () => 3 * GB });
    await Promise.all([e.embed(["a", "b"], "document"), e.embed(["q"], "query"), e.embed(["c"], "document")]);
    expect(s.stats().overlapped).toBe(false);
    expect(s.seen).toHaveLength(4);
    await e.close();
  });

  it("releases the model when idle and loads it again when needed", async () => {
    const s = standIn();
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load: s.load, availableBytes: () => 3 * GB, idleMs: 20 });
    await e.embed(["a"], "document");
    await new Promise((r) => setTimeout(r, 60));
    expect(s.stats().disposed).toBe(1);
    await e.embed(["b"], "document");
    expect(s.stats().loads).toBe(2);
    await e.close();
  });

  it("does not load without enough free memory, and waits before trying again", async () => {
    const s = standIn();
    let free = 1 * GB;
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load: s.load, availableBytes: () => free });
    await expect(e.embed(["a"], "query")).rejects.toThrow(/not enough free memory/);
    free = 3 * GB;
    await expect(e.embed(["a"], "query")).rejects.toThrow(/failed recently/);
    expect(s.stats().loads).toBe(0);
  });

  it("when the model's process ends unexpectedly (out of memory), waits before starting another", async () => {
    let loads = 0;
    let alive = true;
    const load = async (): Promise<Extractor> => {
      loads++;
      const run = (async () => ({ data: new Float32Array([1]) })) as Extractor;
      run.dispose = async () => {};
      run.alive = () => alive;
      return run;
    };
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load, availableBytes: () => 3 * GB });
    await e.embed(["a"], "document");
    alive = false; // the process was stopped from outside
    await expect(e.embed(["b"], "document")).rejects.toThrow(/failed recently/);
    expect(loads).toBe(1);
    await e.close();
  });

  it("a failed load (no network) is not retried at once", async () => {
    let tries = 0;
    const e = createLocalEmbedder({ cacheDir: "/nowhere", load: () => (tries++, Promise.reject(new Error("fetch failed"))), availableBytes: () => 3 * GB });
    await expect(e.embed(["a"], "query")).rejects.toThrow(/fetch failed/);
    await expect(e.embed(["a"], "query")).rejects.toThrow(/failed recently/);
    expect(tries).toBe(1);
  });
});

describe("boot: meaning search", () => {
  async function bootWith(extraEnv: NodeJS.ProcessEnv, embedder?: Embedder) {
    const dataDir = mkdtempSync(join(tmpdir(), "instinct-meaning-"));
    const env: NodeJS.ProcessEnv = {
      INSTINCT_DATA_DIR: dataDir,
      INSTINCT_OWNER_NAME: "Maria",
      INSTINCT_OWNER_PHONE: "+15550001111",
      INSTINCT_OWNER_TIMEZONE: "America/New_York",
      INSTINCT_AGENT_NAME: "Instinct",
      INSTINCT_MODEL: "faux/faux-1",
      INSTINCT_COMPUTER: "none",
      INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
      ...extraEnv,
    };
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const logs: string[] = [];
    const app = await boot(env, { model: faux.getModel("faux-1"), streamFn: models.streamSimple.bind(models) as unknown as StreamFn, logger: (m) => logs.push(m), ...(embedder ? { embedder } : {}) });
    await app.close();
    return logs;
  }

  it("is off unless INSTINCT_MEANING_SEARCH=1 or a search model is passed in", async () => {
    expect((await bootWith({})).some((l) => l.startsWith("meaning search"))).toBe(false);
    const embedder: Embedder = { model: "stand-in@1", embed: async (texts) => texts.map(() => new Float32Array([1])) };
    expect(await bootWith({}, embedder)).toContain("meaning search: on (0 of 0 pieces stored)");
  });
});
