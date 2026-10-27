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
 * Long recordings (2026-10-27, Torstein: "it has to work for longer recordings"; a 23-minute call was 11 MB, and the
 * service scaled to zero in the middle of a job because only new requests count as use): a job goes over in short
 * requests and is asked about every POLL_MS (service/http_host.py), so no request lasts as long as the job and the
 * asking itself keeps the service up exactly while it works; the audio goes as it is, read from the file as it is sent;
 * while a job is out, a schedule in code keeps this agent awake (Maritime snapshots an agent after 15 minutes without
 * requests, which would stop the asking); the owner's attachments are downloaded up to MAX_SENT_RECORDING_BYTES
 * (boot.ts; upstream's 10 MB stays for everyone else).
 *
 * Settings: TRANSCRIBE_URL (the service's base URL) and TRANSCRIBE_KEY (secret). Without both there are no tools.
 */
import { createHash } from "node:crypto";
import { openAsBlob, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, textResult, type AuditLog, type InstinctConfig, type RegisteredTool, type ScheduleEntry, type Scheduler, type StateDir } from "@open-instinct/core";
import { resolveInsideWorkspace } from "./file-tools.js";
import type { Intake } from "./intake.js";

const OWNER_PRINT_FILE = "voice/owner.json";
/** The service refuses larger files (about 8 hours of phone-quality audio). */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
/**
 * The owner's attachments are downloaded up to this size (boot.ts): a Voice Memos recording is about 0.5 MB a minute
 * (3 hours: about 90 MB); neither Apple nor Inkbox publishes how large an iMessage attachment may be (reports: 100-220
 * MB); the download is held in memory once. A Voice Memos file arrives without a name or a type the agent knows, so
 * the size is the owner's, not only for audio.
 */
export const MAX_SENT_RECORDING_BYTES = 200 * 1024 * 1024;
/** How often a job is asked about; the asking is also what keeps a scale-to-zero service up while it works. */
const POLL_MS = 30_000;
/**
 * A job counts as stuck after running 10 minutes plus half the recording's length (measured 2026-10-26: a tenth of its
 * length on the CPU service). The asking keeps the service up, so a stuck job has to be given up on; and in all, waiting
 * in line included, after TOTAL_WAIT_MS.
 */
const runLimitMs = (seconds: number | undefined) => 10 * 60_000 + (seconds ?? 4 * 3600) * 500;
const TOTAL_WAIT_MS = 4 * 60 * 60_000;
/** Sending the audio may take this long (500 MB on a slow line). */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
/** A failed attempt (the network, an error answer, a job the service lost when it restarted) is tried again after these pauses. */
const RETRY_AFTER_MS = [30_000, 120_000];
/**
 * A service scaled to zero answers 503 at once while it starts (OVHcloud AI Deploy, measured 2026-10-26: "The
 * resources needed to serve your request are being initialized", about 3 minutes from standby): woken with a tiny
 * request, asked again every WAKE_POLL_MS until WAKE_WAIT_MS has passed (see `ready`).
 */
const WAKE_POLL_MS = 30_000;
const WAKE_WAIT_MS = 10 * 60 * 1000;
/** The schedule that keeps this agent awake while a job is out runs this gate (boot.ts), in code only. */
export const RECORDINGS_GATE = "recordings";
/** Maritime wakes an agent, or keeps it up, for its schedules: every 5 minutes is well inside its 15 idle minutes. */
const AWAKE_CRON = "*/5 * * * *";

class StartingError extends Error {}
class StuckError extends Error {}

export interface TranscribeResult {
  status: "ok" | "no speech" | "unsupported language" | "error" | string;
  error?: string;
  seconds?: number;
  language?: string;
  people?: string[];
  text?: string;
  voices?: Array<{ shown: string; owner: boolean }>;
}

/** What the service says about a job (GET /jobs/<id>). */
interface JobView {
  state: "waiting for audio" | "receiving audio" | "queued" | "running" | "done";
  /** The recording's length, once the service has it. */
  seconds?: number;
  runningSeconds?: number;
  result?: TranscribeResult;
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
  /** Where the keep-awake schedule goes while a job is out. */
  scheduler?: Pick<Scheduler, "list" | "create" | "delete">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests: no pauses between tries. */
  retryAfterMs?: number[];
  /** Tests: shorter waiting for a service that is starting. */
  wake?: { pollMs: number; waitMs: number };
  /** Tests: asking about a job more often. */
  pollMs?: number;
  /** Tests: each background job, to await it. */
  track?: (job: Promise<void>) => void;
}

interface OwnerPrint {
  vector: string;
  model?: string;
  at: string;
}

export interface Recordings {
  tools: RegisteredTool[];
  /** The keep-awake schedule's gate: never wakes the model; removes the schedule when no job is out. */
  gate: (entry: ScheduleEntry) => Promise<boolean>;
}

export function createRecordings(deps: RecordingsDeps): Recordings {
  const f = deps.fetchImpl ?? globalThis.fetch;
  const now = () => deps.now?.() ?? Date.now();
  const owner = deps.config.owner.name;
  const base = deps.service.url.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${deps.service.key}` };
  // The real clock for waiting (deps.now dates what is kept).
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wake the service with a tiny request and wait until the service itself answers, before any audio goes: measured
   * 2026-10-27, a 6 MB recording sent to the app in standby got 502 at once, three times, and did not wake it (it
   * started minutes later), while a small request gets 503 and wakes it. 502, 503, 504 and network errors mean it is
   * still starting.
   */
  const ready = async (): Promise<void> => {
    const wake = deps.wake ?? { pollMs: WAKE_POLL_MS, waitMs: WAKE_WAIT_MS };
    const started = Date.now();
    for (;;) {
      let res: Response | undefined;
      try {
        res = await f(`${base}/ping`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60_000) });
      } catch {
        // The network or a timeout while it starts: ask again.
      }
      if (res?.ok) return;
      if (res && ![502, 503, 504].includes(res.status)) throw new Error(`transcription service ${res.status}`);
      if (Date.now() - started >= wake.waitMs) throw new StartingError("transcription service did not start in time");
      await sleep(wake.pollMs);
    }
  };

  /** Hand a job over: its settings, then the audio as it is, read from the file while it is sent. Returns its id. */
  const submit = async (spec: Record<string, unknown>, path: string): Promise<string> => {
    const made = await f(`${base}/jobs`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(spec), signal: AbortSignal.timeout(60_000) });
    if (!made.ok) throw new Error(`transcription service ${made.status}`);
    const { id } = (await made.json()) as { id: string };
    const sent = await f(`${base}/jobs/${id}/audio`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: await openAsBlob(path),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!sent.ok) throw new Error(`transcription service ${sent.status}`);
    return id;
  };

  /** Ask about a job every POLL_MS until it is done; a service starting again in between is waited out. */
  const outcome = async (id: string): Promise<TranscribeResult> => {
    const started = Date.now();
    for (;;) {
      await sleep(deps.pollMs ?? POLL_MS);
      let res: Response | undefined;
      try {
        res = await f(`${base}/jobs/${id}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
      } catch {
        // The network: as with a service that is starting.
      }
      if (!res || [502, 503, 504].includes(res.status)) {
        await ready();
        continue;
      }
      if (res.status === 404) throw new Error("the transcription service lost the job (it restarted)");
      if (!res.ok) throw new Error(`transcription service ${res.status}`);
      const job = (await res.json()) as JobView;
      if (job.state === "done") return job.result ?? { status: "error", error: "no result" };
      if (job.state === "running" && (job.runningSeconds ?? 0) * 1000 > runLimitMs(job.seconds)) {
        throw new StuckError(`the job ran ${job.runningSeconds}s on ${job.seconds ?? "?"}s of audio`);
      }
      if (Date.now() - started > TOTAL_WAIT_MS) throw new StuckError("the job waited and ran over 4 hours");
    }
  };

  /** One job from file to result, once the service is up; a failed attempt is tried again after RETRY_AFTER_MS. */
  const runJob = async (spec: Record<string, unknown>, path: string): Promise<TranscribeResult> => {
    const pauses = deps.retryAfterMs ?? RETRY_AFTER_MS;
    let failures = 0;
    for (;;) {
      try {
        await ready();
        return await outcome(await submit(spec, path));
      } catch (error) {
        if (error instanceof StartingError || error instanceof StuckError || failures >= pauses.length) throw error;
        await sleep(pauses[failures++]!);
      }
    }
  };

  // While a job is out, a schedule keeps this agent awake: each of its wakes is a request to the agent, which is what
  // Maritime counts. It goes when the last job ends, or at its next run when none is out (the agent restarted).
  let out = 0;
  const keepAwake = (on: boolean) => {
    const s = deps.scheduler;
    if (!s) return;
    const entries = s.list().filter((e) => e.gate === RECORDINGS_GATE);
    if (on && entries.length === 0) {
      s.create({
        name: "recording in progress",
        prompt: "Keep the agent awake while a recording is transcribed. (Runs in code; the model is not called.)",
        cron: AWAKE_CRON,
        enabled: true,
        gate: RECORDINGS_GATE,
        toolRepliesOnly: true,
      });
    }
    if (!on) for (const e of entries) s.delete(e.id);
  };
  const whileOut = async (work: () => Promise<void>): Promise<void> => {
    if (out++ === 0) keepAwake(true);
    try {
      await work();
    } finally {
      if (--out === 0) keepAwake(false);
    }
  };
  keepAwake(false); // left from before a restart

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
      const result = await runJob({ job: "transcribe", prints: print ? { [owner]: { vector: print.vector, owner: true } } : {} }, path);
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
      // The technical reason stays in the audit; the note says what it means.
      const why =
        error instanceof StartingError
          ? "the transcription service did not start in time"
          : error instanceof StuckError
            ? "the transcription took far longer than it should"
            : "the transcription failed";
      await note(id, `The recording ${owner} sent could not be transcribed (${why}), so nothing was kept; they still have it on their phone and can send it again.`);
    } finally {
      remove(path);
    }
  };

  const recordingAdd = defineTool({
    name: "recording_add",
    label: "Keep a recording",
    description:
      `When ${owner} sends an audio file (a recorded meeting or conversation, a voice memo): have it transcribed with who said what and kept with their conversations. ` +
      "It runs in the background, usually a few minutes; you then get its summary to act on, as with any conversation from elsewhere. The audio itself is deleted afterwards.",
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
      const job = whileOut(() => transcribeAndKeep(file.path, file.bytes, start, title?.trim() || undefined));
      deps.track?.(job);
      // [2026-10-27] Facts for the agent in what they mean for the owner, no internal labels or sizes: live, "Speaker N"
      // and a hedged "I'll tell you if it doesn't work" were passed straight on to the owner.
      const voice = ownerPrint() ? "" : ` You cannot yet tell ${owner}'s voice from the other voices in recordings; a short recording of just them talking (20-60 seconds) would let you (voice_mine).`;
      return textResult(`Started: it is being transcribed in the background (usually a few minutes); its summary comes to you then, to act on as with any conversation from elsewhere.${voice}`);
    },
  });

  const voiceMine = defineTool({
    name: "voice_mine",
    label: "Recognise their voice",
    description:
      `When ${owner} sends a short recording of just themselves talking so you can tell their voice apart from the other voices in recordings, or asks you to forget their voice. ` +
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
      const job = whileOut(() => learnVoice(file.path));
      deps.track?.(job);
      return textResult("Started: their voice is being learned in the background (usually 1-5 minutes); the outcome comes to you as a note, and you tell them then.");
    },
  });

  /** The owner's voice print from their recording; the outcome reaches the agent as a note; the recording is deleted. */
  const learnVoice = async (path: string): Promise<void> => {
    let outcome: string;
    try {
      const r = (await runJob({ job: "enrol" }, path)) as TranscribeResult & { vector?: string; model?: string };
      deps.audit.append({ kind: "policy", principal: "owner", detail: { voicePrint: r.status, seconds: r.seconds } });
      if (r.status === "ok" && r.vector) {
        deps.state.writeJson(OWNER_PRINT_FILE, { vector: r.vector, ...(r.model ? { model: r.model } : {}), at: new Date(now()).toISOString() } satisfies OwnerPrint);
        outcome = `${owner}'s voice is learned: in recordings you can now tell them apart from the other voices, so what they say and take on is theirs.`;
      } else if (r.status === "more than one voice") {
        outcome = `Learning ${owner}'s voice did not work: more than one person talks in the recording; it needs to be just them.`;
      } else if (r.status === "too little speech") {
        outcome = `Learning ${owner}'s voice did not work: too little speech in it; 20-60 seconds of just them talking works.`;
      } else {
        outcome = `Learning ${owner}'s voice did not work (${r.error ?? r.status}); they can send another recording.`;
      }
    } catch (error) {
      deps.audit.append({ kind: "error", principal: "owner", detail: { voicePrint: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 300) } });
      outcome = `Learning ${owner}'s voice did not work: the transcription service did not answer; they can send it again later.`;
    } finally {
      remove(path);
    }
    await deps.runTask({ id: `voice-${now()}`, name: "voice", prompt: `${outcome} Tell ${owner} in one short text if it matters to them; otherwise end with exactly NO_REPLY.` }).catch(() => undefined);
  };

  return {
    tools: [recordingAdd, voiceMine],
    gate: async () => {
      // Its run is a request to the agent, which already did the job of keeping it awake.
      if (out === 0) keepAwake(false);
      return false;
    },
  };
}
