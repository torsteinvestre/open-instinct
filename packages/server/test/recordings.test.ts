// [sunshine:recordings] A recording the owner sends: transcribed by the service (a stand-in here), kept through the
// intake, the audio deleted whatever happens; the owner's voice print learned and forgotten.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, Scheduler, StateDir, defaultConfig } from "@open-instinct/core";
import { speakersOf, type IntakeItem } from "../src/intake.js";
import { RECORDINGS_GATE, createRecordings, type TranscribeResult } from "../src/recordings.js";

const T = Date.parse("2026-10-26T12:00:00Z");

/** How the stand-in service handles one job: its result, or an HTTP status for the job's first request. */
type Answer =
  | (TranscribeResult & { vector?: string })
  | number
  | {
      result: TranscribeResult;
      /** What the questions about the job get first: an HTTP status, or a running job's seconds so far. */
      asked?: Array<number | { runningSeconds: number }>;
    };

/**
 * `answers`: how the stand-in service handles each job, in order. `pings`: what it answers to the small wake-up
 * requests (a number: that status; when they run out, it is up).
 */
function setup(answers: Answer[], pings: number[] = []) {
  const root = mkdtempSync(join(tmpdir(), "instinct-rec-"));
  const state = new StateDir(root);
  state.ensure();
  const workspace = state.path("workspace");
  mkdirSync(join(workspace, "inbound"), { recursive: true });
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const audit = new AuditLog(state);
  const scheduler = new Scheduler(state);
  const received: IntakeItem[] = [];
  const notes: string[] = [];
  const jobs: Promise<void>[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const uploads: number[] = [];
  const calls: string[] = [];
  /** Keep-awake schedules there were each time a job was asked about. */
  const awakeWhileAsked: number[] = [];
  const live = new Map<string, { result: TranscribeResult; asked: Array<number | { runningSeconds: number }> }>();
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    expect(url.startsWith("https://transcribe.example/")).toBe(true);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    const path = url.slice("https://transcribe.example".length);
    const method = init?.method ?? "GET";
    if (path === "/ping") {
      calls.push("ping");
      const status = pings.shift();
      return status ? new Response("starting", { status }) : json({ ok: true });
    }
    if (path === "/jobs" && method === "POST") {
      calls.push("jobs");
      sent.push(JSON.parse(String(init?.body)));
      const next = answers.shift();
      if (typeof next === "number") return new Response("busy", { status: next });
      const id = `${++n}`.padStart(32, "0");
      const job = next && "result" in next ? { result: next.result, asked: [...(next.asked ?? [])] } : { result: (next as TranscribeResult) ?? { status: "error", error: "no answer left" }, asked: [] };
      live.set(id, job);
      return json({ id, state: "waiting for audio" }, 201);
    }
    const m = path.match(/^\/jobs\/(\d{32})(\/audio)?$/);
    if (m && method === "PUT" && m[2]) {
      calls.push("audio");
      uploads.push((init?.body as Blob).size);
      return json({ id: m[1], state: "queued", seconds: 600 }, 202);
    }
    if (m && method === "GET" && !m[2]) {
      calls.push("ask");
      awakeWhileAsked.push(scheduler.list().filter((e) => e.gate === RECORDINGS_GATE).length);
      const job = live.get(m[1]!);
      if (!job) return json({ error: "unknown job" }, 404);
      const first = job.asked.shift();
      if (typeof first === "number") {
        if (first === 404) live.delete(m[1]!);
        return new Response("…", { status: first });
      }
      if (first) return json({ id: m[1], state: "running", seconds: 600, runningSeconds: first.runningSeconds });
      return json({ id: m[1], state: "done", seconds: 600, result: job.result });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as unknown as typeof fetch;
  const recordings = createRecordings({
    state,
    config,
    audit,
    intake: { receive: async (item) => (received.push(item), { outcome: "handed over", costUsd: 0 }) },
    runTask: async (task) => (notes.push(task.prompt), "NO_REPLY"),
    service: { url: "https://transcribe.example/", key: "k1" },
    workspace,
    scheduler,
    fetchImpl,
    now: () => T,
    retryAfterMs: [0, 0],
    wake: { pollMs: 5, waitMs: 200 },
    pollMs: 1,
    track: (job) => jobs.push(job),
  });
  const tool = (name: string) => recordings.tools.find((t) => t.spec.name === name)!;
  const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
  const file = (name: string, bytes = 1000) => {
    const p = join(workspace, "inbound", name);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
  };
  const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein" }, conversationKey: "imessage:c1", channel: "imessage", ownerTurn: true, now: () => new Date(T) } as never;
  return { state, audit, scheduler, recordings, received, notes, jobs, sent, uploads, calls, awakeWhileAsked, tool, text, file, ctx };
}

const OK: TranscribeResult = {
  status: "ok",
  seconds: 600,
  language: "en",
  people: ["Sarah"],
  text: "[00:07] Torstein: Shall we start?\n[00:10] Sarah: Yes. I'll send the deck on Friday.",
  voices: [{ shown: "Torstein", owner: true }, { shown: "Sarah", owner: false }],
};

describe("recordings", () => {
  it("transcribes in the background, hands the transcript to the intake and deletes the audio", async () => {
    const s = setup([OK]);
    const path = s.file("New Recording.m4a", 4321);
    const reply = s.text(await s.tool("recording_add").spec.execute({ path: "inbound/New Recording.m4a", title: "planning" }, s.ctx));
    expect(reply).toMatch(/^Started: it is being transcribed/);
    expect(reply).not.toMatch(/speaker n|MB/i); // no internal labels or sizes for the agent to pass on
    expect(reply).toContain("voice_mine"); // their voice is not known yet
    await Promise.all(s.jobs);
    expect(s.received).toEqual([
      expect.objectContaining({ source: "recording", title: "planning", startedAt: T - 600_000, endedAt: T, people: ["Sarah"], text: OK.text }),
    ]);
    expect(s.received[0]!.id).toMatch(/^rec-[0-9a-f]{16}$/);
    expect(s.sent[0]).toEqual({ job: "transcribe", prints: {} });
    expect(s.uploads).toEqual([4321]); // the audio as it is, not inside the JSON
    expect(s.calls).toEqual(["ping", "jobs", "audio", "ask"]);
    expect(existsSync(path)).toBe(false);
  });

  it("sends the owner's voice print with each recording once it is learned", async () => {
    const s = setup([{ status: "ok", seconds: 40, vector: "VVVV" } as TranscribeResult & { vector: string }, OK]);
    const sample = s.file("me.m4a");
    expect(s.text(await s.tool("voice_mine").spec.execute({ path: sample }, s.ctx))).toMatch(/^Started: their voice is being learned.*you tell them then/);
    await Promise.all(s.jobs);
    expect(s.sent[0]).toEqual({ job: "enrol" });
    expect(s.notes[0]).toContain("Torstein's voice is learned");
    expect(existsSync(sample)).toBe(false);
    s.file("meeting.m4a");
    const reply = s.text(await s.tool("recording_add").spec.execute({ path: "inbound/meeting.m4a" }, s.ctx));
    expect(reply).not.toContain("voice_mine");
    await Promise.all(s.jobs);
    expect(s.sent[1]).toMatchObject({ job: "transcribe", prints: { Torstein: { vector: "VVVV", owner: true } } });
    expect(s.text(await s.tool("voice_mine").spec.execute({ forget: true }, s.ctx))).toMatch(/^Forgotten/);
    expect(s.state.exists("voice/owner.json")).toBe(false);
  });

  it("tells the owner when there was no speech or the language is not supported, and keeps nothing", async () => {
    const s = setup([{ status: "no speech" }, { status: "unsupported language", language: "no" }]);
    const a = s.file("pocket.m4a");
    await s.tool("recording_add").spec.execute({ path: a }, s.ctx);
    const b = s.file("norsk.m4a");
    await s.tool("recording_add").spec.execute({ path: b }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toEqual([]);
    expect(s.notes[0]).toContain("no speech");
    expect(s.notes[1]).toContain("Norwegian does not yet");
    expect(existsSync(a) || existsSync(b)).toBe(false);
  });

  it("tries a failing service again, and when it keeps failing says so and still deletes the audio", async () => {
    const s = setup([502, OK]);
    s.file("a.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/a.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toHaveLength(1);

    const t = setup([500, 500, 500]);
    const p = t.file("b.m4a");
    await t.tool("recording_add").spec.execute({ path: p }, t.ctx);
    await Promise.all(t.jobs);
    expect(t.received).toEqual([]);
    expect(t.notes[0]).toContain("could not be transcribed");
    expect(existsSync(p)).toBe(false);
    expect(t.audit.read({ kinds: ["error"] }).some((e) => JSON.stringify(e.detail).includes("transcription service 500"))).toBe(true);
  });

  it("refuses files outside the workspace and refuses a print with two voices", async () => {
    const s = setup([{ status: "more than one voice" }]);
    expect(s.text(await s.tool("recording_add").spec.execute({ path: "/etc/passwd" }, s.ctx))).toBe("That file is not in your workspace.");
    expect(s.text(await s.tool("recording_add").spec.execute({ path: "inbound/nothing.m4a" }, s.ctx))).toBe("That file is not there any more.");
    s.file("two.m4a");
    await s.tool("voice_mine").spec.execute({ path: "inbound/two.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.notes[0]).toContain("more than one person talks");
    expect(s.state.exists("voice/owner.json")).toBe(false);
  });

  it("wakes a service in standby with small requests and sends the audio only once it answers", async () => {
    // Live 2026-10-27: the recording itself, sent to the app in standby, got 502 and did not wake it.
    const s = setup([OK], [503, 502, 503, 504, 503]);
    s.file("cold.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/cold.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toHaveLength(1);
    expect(s.calls).toEqual(["ping", "ping", "ping", "ping", "ping", "ping", "jobs", "audio", "ask"]);
  });

  it("gives up on a service that stays 'starting' past the wait, says so and deletes the audio", async () => {
    const s = setup([OK], Array.from({ length: 500 }, () => 503));
    const p = s.file("never.m4a");
    await s.tool("recording_add").spec.execute({ path: p }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toEqual([]);
    expect(s.notes[0]).toContain("did not start in time");
    expect(s.notes[0]).not.toContain("503"); // the technical reason stays in the audit
    expect(existsSync(p)).toBe(false);
  });

  it("asks about a long job until it is done, and waits out a service that restarts in between", async () => {
    // A long recording: running for a while, the host briefly gone (502), then done; one job, not sent twice.
    const s = setup([{ result: OK, asked: [{ runningSeconds: 60 }, { runningSeconds: 120 }, 502, { runningSeconds: 240 }] }]);
    s.file("long.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/long.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toHaveLength(1);
    expect(s.calls).toEqual(["ping", "jobs", "audio", "ask", "ask", "ask", "ping", "ask", "ask"]);
  });

  it("sends a job again when the service lost it (it restarted), and gives up on one that runs far too long", async () => {
    const s = setup([{ result: OK, asked: [{ runningSeconds: 60 }, 404] }, OK]);
    s.file("lost.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/lost.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toHaveLength(1);
    expect(s.calls.filter((c) => c === "jobs")).toHaveLength(2);

    // 600 s of audio may run 10 minutes plus 5: at 2 hours it is stuck, and it is not sent again (the asking keeps the
    // service up, so a stuck job would cost on).
    const t = setup([{ result: OK, asked: [{ runningSeconds: 7200 }] }, OK]);
    const p = t.file("stuck.m4a");
    await t.tool("recording_add").spec.execute({ path: p }, t.ctx);
    await Promise.all(t.jobs);
    expect(t.received).toEqual([]);
    expect(t.notes[0]).toContain("took far longer than it should");
    expect(t.calls.filter((c) => c === "jobs")).toHaveLength(1);
    expect(existsSync(p)).toBe(false);
  });

  it("keeps the agent awake with a schedule in code while a job is out, and removes it after", async () => {
    const s = setup([{ result: OK, asked: [{ runningSeconds: 30 }] }]);
    s.file("x.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/x.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.awakeWhileAsked).toEqual([1, 1]);
    expect(s.scheduler.list()).toEqual([]);

    // Its runs never call the model, and one left from before a restart goes.
    const left = s.scheduler.create({ name: "recording in progress", prompt: "Keep awake.", cron: "*/5 * * * *", enabled: true, gate: RECORDINGS_GATE });
    expect(await s.recordings.gate(left)).toBe(false);
    expect(s.scheduler.list()).toEqual([]);
  });

  it("does not take a numbered voice for a person", () => {
    expect(speakersOf("[00:01] Speaker 1: hi\n[00:02] Sarah: hello\n[00:03] Torstein: hey", "Torstein")).toEqual(["Sarah"]);
  });
});
