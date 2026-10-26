// [sunshine:recordings] A recording the owner sends: transcribed by the service (a stand-in here), kept through the
// intake, the audio deleted whatever happens; the owner's voice print learned and forgotten.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, StateDir, defaultConfig } from "@open-instinct/core";
import { speakersOf, type IntakeItem } from "../src/intake.js";
import { recordingsTools, type TranscribeResult } from "../src/recordings.js";

const T = Date.parse("2026-10-26T12:00:00Z");

function setup(answers: Array<TranscribeResult & { vector?: string } | number>) {
  const root = mkdtempSync(join(tmpdir(), "instinct-rec-"));
  const state = new StateDir(root);
  state.ensure();
  const workspace = state.path("workspace");
  mkdirSync(join(workspace, "inbound"), { recursive: true });
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", timezone: "Europe/Oslo" };
  const audit = new AuditLog(state);
  const received: IntakeItem[] = [];
  const notes: string[] = [];
  const jobs: Promise<void>[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://transcribe.example/run");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    sent.push(JSON.parse(String(init?.body)));
    const next = answers.shift();
    if (typeof next === "number") return new Response("busy", { status: next });
    return new Response(JSON.stringify(next ?? { status: "error", error: "no answer left" }), { status: 200 });
  }) as unknown as typeof fetch;
  const tools = recordingsTools({
    state,
    config,
    audit,
    intake: { receive: async (item) => (received.push(item), { outcome: "handed over", costUsd: 0 }) },
    runTask: async (task) => (notes.push(task.prompt), "NO_REPLY"),
    service: { url: "https://transcribe.example/", key: "k1" },
    workspace,
    fetchImpl,
    now: () => T,
    retryAfterMs: [0, 0],
    wake: { pollMs: 5, waitMs: 200 },
    track: (job) => jobs.push(job),
  });
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
  const file = (name: string, bytes = 1000) => {
    const p = join(workspace, "inbound", name);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
  };
  const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein" }, conversationKey: "imessage:c1", channel: "imessage", ownerTurn: true, now: () => new Date(T) } as never;
  return { state, audit, received, notes, jobs, sent, tool, text, file, ctx };
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
    const path = s.file("New Recording.m4a");
    const reply = s.text(await s.tool("recording_add").spec.execute({ path: "inbound/New Recording.m4a", title: "planning" }, s.ctx));
    expect(reply).toMatch(/^Transcribing it now/);
    expect(reply).toContain("voice_mine"); // their voice is not known yet
    await Promise.all(s.jobs);
    expect(s.received).toEqual([
      expect.objectContaining({ source: "recording", title: "planning", startedAt: T - 600_000, endedAt: T, people: ["Sarah"], text: OK.text }),
    ]);
    expect(s.received[0]!.id).toMatch(/^rec-[0-9a-f]{16}$/);
    expect(s.sent[0]).toMatchObject({ job: "transcribe", prints: {} });
    expect(typeof s.sent[0]!.audioBase64).toBe("string");
    expect(existsSync(path)).toBe(false);
  });

  it("sends the owner's voice print with each recording once it is learned", async () => {
    const s = setup([{ status: "ok", seconds: 40, vector: "VVVV" } as TranscribeResult & { vector: string }, OK]);
    const sample = s.file("me.m4a");
    expect(s.text(await s.tool("voice_mine").spec.execute({ path: sample }, s.ctx))).toMatch(/^Learning their voice now/);
    await Promise.all(s.jobs);
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

    const t = setup([502, 502, 502]);
    const p = t.file("b.m4a");
    await t.tool("recording_add").spec.execute({ path: p }, t.ctx);
    await Promise.all(t.jobs);
    expect(t.received).toEqual([]);
    expect(t.notes[0]).toContain("could not be transcribed");
    expect(existsSync(p)).toBe(false);
    expect(t.audit.read({ kinds: ["error"] }).some((e) => JSON.stringify(e.detail).includes("transcription service 502"))).toBe(true);
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

  it("waits out a service that is starting from zero (503) instead of giving up", async () => {
    const s = setup([503, 503, 503, 503, 503, OK]);
    s.file("cold.m4a");
    await s.tool("recording_add").spec.execute({ path: "inbound/cold.m4a" }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toHaveLength(1);
    expect(s.sent).toHaveLength(6);
  });

  it("gives up on a service that stays 'starting' past the wait, says so and deletes the audio", async () => {
    const s = setup(Array.from({ length: 500 }, () => 503));
    const p = s.file("never.m4a");
    await s.tool("recording_add").spec.execute({ path: p }, s.ctx);
    await Promise.all(s.jobs);
    expect(s.received).toEqual([]);
    expect(s.notes[0]).toContain("starting (503)");
    expect(existsSync(p)).toBe(false);
  });

  it("does not take a numbered voice for a person", () => {
    expect(speakersOf("[00:01] Speaker 1: hi\n[00:02] Sarah: hello\n[00:03] Torstein: hey", "Torstein")).toEqual(["Sarah"]);
  });
});
