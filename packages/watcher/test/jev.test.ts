// [sunshine:watcher]
import { describe, expect, it } from "vitest";
import { JEV_URL, JevSieve, jevRequest } from "../src/jev.js";

function jevFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const answer = (p: number) => ({ model: "jev-1.13.0", answers: { about: { type: "noul", noul: p } }, usage: { input_tokens: 120, output_tokens: 10 } });

describe("Jev relevance sieve", () => {
  it("asks one yes/no question per headline, with only the headline as state", () => {
    const body = jevRequest("Brann, the Bergen football club", { title: "Brann signs striker", source: "NRK" });
    expect(body).toMatchObject({
      model: "jev-latest",
      state: { headline: "Brann signs striker", source: "NRK" },
      questions: { about: { type: "noul", instructions: "Is this news headline about Brann, the Bergen football club?" } },
    });
  });

  it("returns the probability and the tokens, with the key as a Bearer header", async () => {
    const { fetchImpl, calls } = jevFetch([{ status: 200, body: answer(0.91) }]);
    const sieve = new JevSieve({ apiKey: "ts_test", fetchImpl });
    await expect(sieve.relevance("Brann", { title: "Brann wins" })).resolves.toEqual({ p: 0.91, inputTokens: 120 });
    expect(calls[0]!.url).toBe(JEV_URL);
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ts_test");
  });

  it("retries when busy, then answers", async () => {
    const { fetchImpl, calls } = jevFetch([{ status: 429 }, { status: 529 }, { status: 200, body: answer(0.2) }]);
    const waits: number[] = [];
    const sieve = new JevSieve({ apiKey: "k", fetchImpl, sleep: async (ms) => void waits.push(ms) });
    await expect(sieve.relevance("Brann", { title: "x" })).resolves.toMatchObject({ p: 0.2 });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("does not retry a bad key, and says which setting to check", async () => {
    const { fetchImpl, calls } = jevFetch([{ status: 401 }]);
    const sieve = new JevSieve({ apiKey: "k", fetchImpl, sleep: async () => undefined });
    await expect(sieve.relevance("Brann", { title: "x" })).rejects.toThrow(/401.*TYPESAFE_API_KEY/);
    expect(calls).toHaveLength(1);
  });

  it("refuses an answer without a probability", async () => {
    const { fetchImpl } = jevFetch([{ status: 200, body: { answers: {} } }]);
    await expect(new JevSieve({ apiKey: "k", fetchImpl }).relevance("Brann", { title: "x" })).rejects.toThrow(/no answer/);
  });
});
