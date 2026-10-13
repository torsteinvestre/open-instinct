/**
 * [sunshine:watcher] The relevance sieve. Jev (TypeSafe's decision model) answers one yes/no
 * question per headline: is this about the topic? It is cheap, so it can look at every headline,
 * and it never judges importance; Claude does that on the few that pass.
 *
 * API: POST https://api.typesafe.ai/v1/systemone with a Bearer key (docs.typesafe.ai/api).
 * One headline per request, because Jev's accuracy drops as the state grows.
 */

export interface SieveResult {
  /** Probability (0-1) that the headline is about the topic. */
  p: number;
  inputTokens: number;
}

export interface RelevanceSieve {
  readonly name: string;
  relevance(topic: string, item: { title: string; source?: string }, signal?: AbortSignal): Promise<SieveResult>;
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 20_000;

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevSieveOptions {
  apiKey: string;
  url?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Attempts after the first on 429, 529, 5xx or a network error. */
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The request body for one headline. Exported for tests and for reading the exact question. */
export function jevRequest(topic: string, item: { title: string; source?: string }, model = JEV_MODEL): Record<string, unknown> {
  return {
    model,
    state: { headline: item.title, ...(item.source ? { source: item.source } : {}) },
    questions: {
      about: {
        type: "noul",
        instructions: `Is this news headline about ${topic}?`,
        criteria: {
          true: `The headline is about ${topic}, directly or as a main part of the story.`,
          false: `The headline is about something else, even if a word looks similar.`,
        },
      },
    },
  };
}

export class JevSieve implements RelevanceSieve {
  readonly name = "jev";
  private readonly opts: Required<Omit<JevSieveOptions, "fetchImpl">> & { fetchImpl: typeof fetch };

  constructor(opts: JevSieveOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      url: opts.url ?? JEV_URL,
      model: opts.model ?? JEV_MODEL,
      retries: opts.retries ?? 2,
      retryDelayMs: opts.retryDelayMs ?? 1000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      fetchImpl: opts.fetchImpl ?? fetch,
    };
  }

  async relevance(topic: string, item: { title: string; source?: string }, signal?: AbortSignal): Promise<SieveResult> {
    const body = JSON.stringify(jevRequest(topic, item, this.opts.model));
    let last: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) await this.opts.sleep(this.opts.retryDelayMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        res = await this.opts.fetchImpl(this.opts.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        last = err;
        continue;
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        last = new JevError(`Jev HTTP ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) throw new JevError(`Jev HTTP ${res.status}${res.status === 401 ? " (check TYPESAFE_API_KEY)" : ""}`, res.status);
      const json = (await res.json().catch(() => undefined)) as { answers?: { about?: { noul?: unknown } }; usage?: { input_tokens?: unknown } } | undefined;
      const p = json?.answers?.about?.noul;
      if (typeof p !== "number" || !Number.isFinite(p)) throw new JevError("Jev returned no answer");
      const tokens = json?.usage?.input_tokens;
      return { p: Math.min(1, Math.max(0, p)), inputTokens: typeof tokens === "number" ? tokens : 0 };
    }
    throw last instanceof Error ? last : new JevError("Jev unreachable");
  }
}
