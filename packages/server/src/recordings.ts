/**
 * [sunshine:recordings] A recording the owner sends (a meeting in Voice Memos, sent on iMessage now and from the
 * app's chat later) becomes a conversation Sunshine knows. The audio goes to the transcription service
 * (~/sunshine-audio service/http_host.py: who spoke when, what was said, the owner's lines named from their voice
 * print, everyone else "Speaker 1, 2..."), the transcript into the archive through the intake ([sunshine:intake]:
 * kept, summarized once, acted on), and the audio file is deleted whatever happens (decided 2026-10-26: audio is not
 * kept). The owner's print comes from a short recording of them alone (voice_mine); it stays on this agent and goes to
 * the service with each job. The service keeps nothing and holds no keys to this agent.
 *
 * Why the agent and not a central backend (2026-10-26): files sent on iMessage already land in the agent's workspace,
 * and the app's chat can send them the same way, so one path serves both; recordings and prints stay with each
 * person's own agent; testers can use it before the app exists.
 *
 * Settings: TRANSCRIBE_URL (the service's base URL) and TRANSCRIBE_KEY (secret). Without both there are no tools.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, textResult, type AuditLog, type InstinctConfig, type RegisteredTool, type StateDir } from "@open-instinct/core";
import { resolveInsideWorkspace } from "./file-tools.js";
import type { Intake } from "./intake.js";

const OWNER_PRINT_FILE = "voice/owner.json";
/** The service refuses larger files (about 8 hours of phone-quality audio). */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
/** A job includes fetching and decoding the audio; a 1-hour recording takes about 6 minutes on the CPU service. */
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
/** A failed call (an error answer, the network) is tried again after these pauses. */
const RETRY_AFTER_MS = [30_000, 120_000];
/**
 * A service scaled to zero answers 503 at once while it starts (OVHcloud AI Deploy, measured 2026-10-26: "The
 * resources needed to serve your request are being initialized", about 3 minutes from standby): asked again every
 * WAKE_POLL_MS until WAKE_WAIT_MS has passed.
 */
const WAKE_POLL_MS = 30_000;
const WAKE_WAIT_MS = 10 * 60 * 1000;

class StartingError extends Error {}

export interface TranscribeResult {
  status: "ok" | "no speech" | "unsupported language" | "error" | string;
  error?: string;
  seconds?: number;
  language?: string;
  people?: string[];
  text?: string;
  voices?: Array<{ shown: string; owner: boolean }>;
}

export interface RecordingsDeps {
  state: StateDir;
  config: InstinctConfig;
  audit: AuditLog;
  intake: Intake;
  /** The agent's turn on a note for the owner (a recording that could not be used): runtime.runSystemTask. */
  runTask: (task: { id: string; name?: string; prompt: string }) => Promise<string>;
  /** The service's base URL and key. */
  service: { url: string; key: string };
  workspace: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests: no pauses between tries. */
  retryAfterMs?: number[];
  /** Tests: shorter waiting for a service that is starting. */
  wake?: { pollMs: number; waitMs: number };
  /** Tests: each background job, to await it. */
  track?: (job: Promise<void>) => void;
}

interface OwnerPrint {
  vector: string;
  model?: string;
  at: string;
}

export function recordingsTools(deps: RecordingsDeps): RegisteredTool[] {
  const f = deps.fetchImpl ?? globalThis.fetch;
  const now = () => deps.now?.() ?? Date.now();
  const owner = deps.config.owner.name;
  const runUrl = `${deps.service.url.replace(/\/+$/, "")}/run`;

  const callService = async (job: Record<string, unknown>): Promise<TranscribeResult> => {
    const res = await f(runUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.service.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
    });
    if (res.status === 503) throw new StartingError("transcription service starting (503)");
    if (!res.ok) throw new Error(`transcription service ${res.status}`);
    return (await res.json()) as TranscribeResult;
  };

  /** One job: waits out a service that is starting, and tries other failures again after RETRY_AFTER_MS. */
  const withRetries = async (job: Record<string, unknown>): Promise<TranscribeResult> => {
    const pauses = deps.retryAfterMs ?? RETRY_AFTER_MS;
    const wake = deps.wake ?? { pollMs: WAKE_POLL_MS, waitMs: WAKE_WAIT_MS };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // The real clock: how long it has waited (deps.now dates what is kept).
    const started = Date.now();
    let failures = 0;
    for (;;) {
      try {
        return await callService(job);
      } catch (error) {
        if (error instanceof StartingError && Date.now() - started < wake.waitMs) {
          await sleep(wake.pollMs);
          continue;
        }
        if (error instanceof StartingError || failures >= pauses.length) throw error;
        await sleep(pauses[failures++]!);
      }
    }
  };

  /** A file the owner sent, inside the workspace, not too large. */
  const fileOf = (requested: string): { path: string; bytes: number } | string => {
    const path = resolveInsideWorkspace(deps.workspace, requested);
    if (!path) return "That file is not in your workspace.";
    try {
      const bytes = statSync(path).size;
      if (bytes > MAX_RECORDING_BYTES) return "That recording is too large (over 500 MB).";
      return { path, bytes };
    } catch {
      return "That file is not there any more.";
    }
  };

  const remove = (path: string) => rmSync(path, { force: true });
  const ownerPrint = () => deps.state.readJson<OwnerPrint | undefined>(OWNER_PRINT_FILE, undefined);

  const note = async (id: string, text: string) => {
    await deps.runTask({ id: `recording-${id}`, name: "recording", prompt: `${text} Tell ${owner} in one short text if it matters to them; otherwise end with exactly NO_REPLY.` }).catch(() => undefined);
  };

  /** Transcribe, hand over, delete: in the background, so the owner's reply is not held up. */
  const transcribeAndKeep = async (path: string, bytes: number, startedAt: number | undefined, title: string | undefined): Promise<void> => {
    const id = `rec-${createHash("sha256").update(`${path}|${bytes}`).digest("hex").slice(0, 16)}`;
    const t0 = now();
    try {
      const print = ownerPrint();
      const result = await withRetries({
        job: "transcribe",
        audioBase64: readFileSync(path).toString("base64"),
        prints: print ? { [owner]: { vector: print.vector, owner: true } } : {},
      });
      deps.audit.append({ kind: "policy", principal: "owner", detail: { recording: { id, status: result.status, seconds: result.seconds, language: result.language, voices: result.voices?.length, ms: now() - t0 } } });
      if (result.status === "ok" && result.text?.trim()) {
        const seconds = result.seconds ?? 0;
        const start = startedAt ?? now() - seconds * 1000;
        await deps.intake.receive({
          id,
          source: "recording",
          ...(title ? { title } : {}),
          startedAt: start,
          endedAt: start + seconds * 1000,
          ...(result.people?.length ? { people: result.people } : {}),
          text: result.text,
        });
      } else if (result.status === "no speech") {
        await note(id, `The recording ${owner} sent had no speech in it, so nothing was kept.`);
      } else if (result.status === "unsupported language") {
        await note(id, `The recording ${owner} sent was in a language that cannot be transcribed yet (detected: ${result.language ?? "unknown"}; English and most European languages work, Norwegian does not yet), so nothing was kept.`);
      } else {
        throw new Error(result.error ?? `status ${result.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.audit.append({ kind: "error", principal: "owner", detail: { recording: id, message: message.slice(0, 300) } });
      await note(id, `The recording ${owner} sent could not be transcribed (${message.slice(0, 120)}), so nothing was kept; they still have it on their phone and can send it again.`);
    } finally {
      remove(path);
    }
  };

  const recordingAdd = defineTool({
    name: "recording_add",
    label: "Keep a recording",
    description:
      `When ${owner} sends an audio file (a recorded meeting or conversation, a voice memo): have it transcribed with who said what and kept with their conversations. ` +
      "It runs in the background, usually a minute or two; you then get its summary to act on, as with any conversation from elsewhere. The audio itself is deleted afterwards.",
    parameters: Type.Object({
      path: Type.String({ description: "The attachment's path, as shown in the message" }),
      title: Type.Optional(Type.String({ description: "What it is, if they said (e.g. \"weekly planning\")" })),
      startedAt: Type.Optional(Type.String({ description: "When it was recorded, ISO time, if they said; else it counts as just recorded" })),
    }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `transcribe and keep a recording: ${basename(String((a as { path?: unknown }).path ?? ""))}` },
    execute: async ({ path, title, startedAt }) => {
      const file = fileOf(path);
      if (typeof file === "string") return textResult(file);
      const start = startedAt && !Number.isNaN(Date.parse(startedAt)) ? Date.parse(startedAt) : undefined;
      const job = transcribeAndKeep(file.path, file.bytes, start, title?.trim() || undefined);
      deps.track?.(job);
      const voice = ownerPrint() ? "" : ` Their own voice is not known yet, so their lines show as "Speaker N": a short recording of just them talking (20-60 seconds) lets you recognise it (voice_mine).`;
      return textResult(`Transcribing it now (${(file.bytes / 1e6).toFixed(1)} MB); the summary reaches you when it is done.${voice}`);
    },
  });

  const voiceMine = defineTool({
    name: "voice_mine",
    label: "Recognise their voice",
    description:
      `When ${owner} sends a short recording of just themselves talking so you recognise their voice in recordings (their lines are then theirs, not "Speaker N"), or asks you to forget their voice. ` +
      "The voice print stays on this agent; the recording is deleted.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "The attachment's path, as shown in the message" })),
      forget: Type.Optional(Type.Boolean({ description: "true to forget their voice" })),
    }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => ((a as { forget?: unknown }).forget ? "forget the owner's voice" : "learn the owner's voice") },
    execute: async ({ path, forget }) => {
      if (forget) {
        rmSync(deps.state.path(OWNER_PRINT_FILE), { force: true });
        deps.audit.append({ kind: "policy", principal: "owner", detail: { voicePrint: "forgotten" } });
        return textResult("Forgotten: their voice is no longer recognised.");
      }
      if (!path) return textResult("Give the path of their recording, or forget: true.");
      const file = fileOf(path);
      if (typeof file === "string") return textResult(file);
      // In the background too: a service scaled to zero takes minutes to start, which the owner should not wait out.
      const job = learnVoice(file.path);
      deps.track?.(job);
      return textResult("Learning their voice now; you hear how it went in a minute or a few.");
    },
  });

  /** The owner's voice print from their recording; the outcome reaches the agent as a note; the recording is deleted. */
  const learnVoice = async (path: string): Promise<void> => {
    let outcome: string;
    try {
      const r = (await withRetries({ job: "enrol", audioBase64: readFileSync(path).toString("base64") })) as TranscribeResult & { vector?: string; model?: string };
      deps.audit.append({ kind: "policy", principal: "owner", detail: { voicePrint: r.status, seconds: r.seconds } });
      if (r.status === "ok" && r.vector) {
        deps.state.writeJson(OWNER_PRINT_FILE, { vector: r.vector, ...(r.model ? { model: r.model } : {}), at: new Date(now()).toISOString() } satisfies OwnerPrint);
        outcome = `${owner}'s voice is learned: their lines in recordings will carry their name from now on.`;
      } else if (r.status === "more than one voice") {
        outcome = `Learning ${owner}'s voice did not work: more than one person talks in the recording; it needs to be just them.`;
      } else if (r.status === "too little speech") {
        outcome = `Learning ${owner}'s voice did not work: too little speech in it; 20-60 seconds of just them talking works.`;
      } else {
        outcome = `Learning ${owner}'s voice did not work (${r.error ?? r.status}); they can send another recording.`;
      }
    } catch (error) {
      outcome = `Learning ${owner}'s voice did not work: the transcription service did not answer (${error instanceof Error ? error.message : String(error)}); they can send it again later.`;
    } finally {
      remove(path);
    }
    await deps.runTask({ id: `voice-${now()}`, name: "voice", prompt: `${outcome} Tell ${owner} in one short text if it matters to them; otherwise end with exactly NO_REPLY.` }).catch(() => undefined);
  };

  return [recordingAdd, voiceMine];
}
