// [sunshine:prune] After old tool results are shortened, does Sunshine still answer follow-ups right?
// Runs the real AgentRuntime (real system prompt, core tools, the owner's chat thread) against Sonnet 5.5
// with a canned email search (8 emails, about 12,000 characters, like a real Gmail result). The owner
// asks for emails, says thanks, then after a 10-minute pause (the clock is moved; the cache lapses) asks
// about details of that list, which by then has been shortened. Prints per message: tools used, the
// reply, whether results were shortened, and each call's cache use and cost; then whether the follow-ups
// were right (from its own earlier reply or by searching again) and not made up. Once with pruning on,
// once off for comparison. Nothing is sent anywhere. Usage (from packages/server, after `pnpm build`,
// ANTHROPIC_API_KEY set): node scenarios/prune.mjs [on|off|both]
import {
  AgentRuntime, ApprovalStore, AuditLog, ContactStore, DEFAULT_PERSONA, MemoryStore, PolicyEngine, Scheduler, StateDir,
  ToolRegistry, coreTools, defaultConfig, defaultPolicy, defineTool, resolveModel, textResult,
} from "@open-instinct/core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const which = process.argv[2] ?? "both";

// Realistic, varied emails in the shape Composio's Gmail fetch returns (metadata-heavy JSON). A first
// version gave every email the same filler body, and the model rightly called it filler: an artifact.
const EMAILS = [
  ["msg_18f2a01", "DNB <noreply@dnb.no>", "Your card statement for September is ready", "2026-10-12T06:14:09Z",
    "Hi Torstein, your statement for DNB Mastercard (ending 4471) for the period 1-30 September is now available in the app and online bank. Amount due: NOK 8,412.50, due date 26 October. If you have set up eFaktura with AvtaleGiro, the amount will be deducted automatically. Questions? Chat with us in the DNB app."],
  ["msg_18f2a7c", "Skatteetaten <ikke-svar@skatteetaten.no>", "Skattemelding 2025: endelig skatteoppgjør", "2026-10-12T09:02:41Z",
    "Hei. Skatteoppgjøret ditt for 2025 er klart. Du får tilbake 3 218 kroner, som blir utbetalt til kontonummeret som er registrert hos oss innen tre uker. Du finner oppgjøret ved å logge inn på skatteetaten.no. Dette er en automatisk melding og kan ikke besvares."],
  ["msg_18f2b33", "Ingrid Haugen <ingrid.haugen@gmail.com>", "Hytta i november?", "2026-10-13T17:47:12Z",
    "Heisann! Mamma spør om vi skal ta en tur på hytta i Hemsedal helgen 13.-15. november. Jonas og Marte kommer, og vi tenkte å fyre opp badstua og ta en tur opp til Totten hvis det er snø. Kan du ta med deg tacoboksen og noe å drikke? Si fra innen søndag så jeg kan svare mamma. Klem, Ingrid"],
  ["msg_18f2c90", "Ticketmaster <noreply@ticketmaster.no>", "Your J. Cole tickets: venue update", "2026-10-14T07:30:55Z",
    "Important update about your order 23-48112/OSL. J. Cole, The Fall Off Tour, 14 November 2026 has moved from Telenor Arena to Unity Arena, Fornebu. Your tickets remain valid for the new venue; no action is needed. Doors open 18:30. Mobile tickets will appear in the Ticketmaster app 48 hours before the event."],
  ["msg_18f2d15", "Norwegian <noreply@norwegian.no>", "Booking confirmation OSL-BCN, 6 Nov", "2026-10-14T12:05:03Z",
    "Thank you for your booking, Torstein. Booking reference: K7HQ2P. Outbound DY1876 Oslo Gardermoen 07:05 - Barcelona El Prat 10:55, Friday 6 November. Return DY1877 Barcelona 11:40 - Oslo 15:35, Monday 9 November. 1 adult, LowFare+ with one checked bag. Check-in opens 30 days before departure in the Norwegian app."],
  ["msg_18f2e02", "Startup Norway <hello@startupnorway.com>", "Pitch night 22 Oct: final speaker list", "2026-10-15T05:55:38Z",
    "The speaker list for Pitch Night at MESH Youngstorget on Thursday 22 October is set: Solvera (pre-seed, climate data), Fjordkraft Labs, Nookie Health and Brygg. Doors 17:30, pitches from 18:00, networking after. You registered as an attendee; bring the QR code from your ticket email. See you there!"],
  ["msg_18f2e4b", "Nordnet <kundeservice@nordnet.no>", "Endringer i vilkår for Aksjesparekonto", "2026-10-15T08:20:17Z",
    "Hei Torstein. Fra 1. desember 2026 gjør vi endringer i vilkårene for Aksjesparekonto (ASK). Kurtasjeklassen Mini endres fra 0,06 % til 0,05 %, og valutapåslaget ved handel i utenlandske aksjer settes ned til 0,20 %. Endringene krever ingen handling fra deg. Fullstendige vilkår finner du under Min side > Dokumenter."],
  ["msg_18f2f11", "Martin Lie <martin@lie-consulting.no>", "Re: Fundraising deck feedback", "2026-10-15T11:41:50Z",
    "Hey Torstein, went through the deck. Strong problem slide, but the market sizing on slide 6 mixes TAM for all of Europe with a Nordic SAM, investors will poke at that. I'd also move traction before the team slide and cut the roadmap to one slide. Happy to do a 30 min call Monday or Tuesday if useful. Best, Martin"],
];
const HEADERS = (from, subject, date) => [
  { name: "Delivered-To", value: "torstein.test@gmail.com" }, { name: "Received", value: `by 2002:a05:6a10:8e0c:b0:5a2:1f3 with SMTP id k12csp4471pxb; ${date}` },
  { name: "ARC-Seal", value: "i=1; a=rsa-sha256; t=1760000000; cv=none; d=google.com; s=arc-20240605; b=Qm9ndXMgc2lnbmF0dXJlIGZvciB0ZXN0aW5n" },
  { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; c=relaxed/relaxed; s=selector1; h=from:to:subject:date:message-id; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" },
  { name: "From", value: from }, { name: "To", value: "Torstein <torstein.test@gmail.com>" }, { name: "Subject", value: subject }, { name: "Date", value: date },
  { name: "Content-Type", value: "multipart/alternative; boundary=\"000000000000a1b2c3d4e5f6\"" },
];
const INBOX = EMAILS.map(([id, from, subject, date, text]) => JSON.stringify({
  messageId: id, threadId: id.replace("msg_", "thr_"), messageTimestamp: date, labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  sender: from, to: "torstein.test@gmail.com", subject, preview: { subject, body: text.slice(0, 120) }, messageText: text,
  payload: { mimeType: "multipart/alternative", headers: HEADERS(from, subject, date) }, attachmentList: [],
})).join(",\n");
const SEARCH_RESULT = `{"data":{"messages":[\n${INBOX}\n],"nextPageToken":"","resultSizeEstimate":8},"successful":true,"error":null}`;

const STEPS = [
  { text: "what emails did I get this week?", pauseMin: 0 },
  { text: "thanks!", pauseMin: 1 },
  { text: "what was the exact subject of the one from Nordnet?", pauseMin: 10, expect: "Endringer i vilkår for Aksjesparekonto" },
  { text: "and what's the message id of the Norwegian booking one? need it for something", pauseMin: 1, expect: "msg_18f2d15" },
];

async function play(prune) {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  const state = new StateDir(dir); state.ensure();
  writeFileSync(join(dir, "PERSONA.md"), DEFAULT_PERSONA);
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", phones: ["+4790000000"], timezone: "Europe/Oslo" };
  config.agent = { ...config.agent, name: "Sunshine" };
  config.features = { ...config.features, pruneToolResults: prune };
  const memory = new MemoryStore(state);
  const scheduler = new Scheduler(state), approvals = new ApprovalStore(state), audit = new AuditLog(state), contacts = new ContactStore(state);
  const outbox = { send: async () => {} };
  const registry = new ToolRegistry();
  registry.registerMany(coreTools({ memory, scheduler, approvals, audit, config, outbox }));
  let searches = 0;
  registry.registerMany([defineTool({
    name: "gmail_fetch_emails",
    label: "Fetch emails",
    description: "Fetch emails from the owner's Gmail inbox. Returns id, sender, subject, date and a snippet for each.",
    parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Gmail search query, e.g. newer_than:7d" })) }),
    meta: { capabilities: ["converse"], group: "apps" },
    execute: async () => { searches++; return textResult(SEARCH_RESULT); },
  })]);
  let offset = 0;
  const runtime = new AgentRuntime({
    state, config, policy: new PolicyEngine(defaultPolicy()), approvals, audit, scheduler, contacts, memory, registry,
    model: resolveModel("anthropic/claude-sonnet-5-5"), outbox, streamFn: streamSimple, getApiKey: () => apiKey, replyBudgetMs: 180_000,
    now: () => new Date(Date.now() + offset),
  });
  const rows = [];
  let seenCalls = 0;
  for (const [i, step] of STEPS.entries()) {
    offset += step.pauseMin * 60_000;
    const searchesBefore = searches;
    const auditBefore = audit.read({ limit: 1000 }).length;
    const res = await runtime.handleInbound({ id: `m${prune}${i}`, channel: "chat", from: "owner", conversationKey: "chat:main", text: step.text, replyRef: {}, receivedAt: new Date().toISOString() });
    const conv = runtime.conversation("chat:main", runtime.ownerPrincipal());
    const calls = conv.agent.state.messages.filter((m) => m.role === "assistant" && m.usage && m.usage.totalTokens > 0);
    const pruned = audit.read({ limit: 1000 }).slice(auditBefore).find((e) => e.detail?.prunedToolResults);
    const reply = String(res.reply ?? "");
    rows.push({
      step, reply, searchedAgain: searches > searchesBefore, usage: calls.slice(seenCalls).map((m) => m.usage),
      pruned: pruned ? `${pruned.detail.prunedToolResults} result(s), ${pruned.detail.prunedChars} chars` : "",
      right: step.expect ? reply.includes(step.expect) : undefined,
    });
    seenCalls = calls.length;
  }
  rmSync(dir, { recursive: true, force: true });
  return rows;
}

let total = 0;
for (const prune of which === "both" ? [true, false] : [which === "on"]) {
  const rows = await play(prune);
  console.log(`\n===== pruning ${prune ? "ON (new)" : "OFF (old)"}`);
  let sum = 0;
  for (const r of rows) {
    console.log(`\n  > ${r.step.text}${r.step.pauseMin >= 5 ? `   (after ${r.step.pauseMin} min)` : ""}`);
    if (r.pruned) console.log(`    shortened before the call: ${r.pruned}`);
    for (const u of r.usage) {
      sum += u.cost?.total ?? 0;
      console.log(`    read ${String(u.cacheRead).padStart(6)}  written ${String(u.cacheWrite).padStart(6)}  uncached ${String(u.input).padStart(5)}  out ${String(u.output).padStart(4)}  $${(u.cost?.total ?? 0).toFixed(4)}`);
    }
    // The follow-ups are what this checks, so their replies are printed whole.
    console.log(`    reply: "${r.reply.replace(/\n/g, " / ").slice(0, r.step.expect ? undefined : 260)}"`);
    if (r.right !== undefined) console.log(`    right answer: ${r.right ? "YES" : "NO"}   searched again: ${r.searchedAgain ? "yes" : "no"}`);
  }
  console.log(`  total $${sum.toFixed(4)}`);
  total += sum;
}
console.log(`\nCost: $${total.toFixed(4)}`);
