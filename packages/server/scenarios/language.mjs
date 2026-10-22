// [sunshine:language] Does Sunshine answer in the language of the message it answers, also after reading
// material in another language, and when the person switches language mid-conversation?
// Boots the real server in a throwaway folder (owner Torstein, Oslo; Gmail and Calendar through Composio's
// router with the real tool definitions, shown as connected) on the prompt as deployed, then plays
// conversations through the real runtime and Sonnet 5.5. Every tool except load_tools and load_skill answers
// from a script (a made-up Norwegian newsletter, English weather and news): nothing reaches Gmail, the web
// or anyone's phone.
//
// What it answers (checked 2026-10-22, $0.18): with even one or two English messages before it, an English
// question about a Norwegian email is answered in English (2/2), and English -> Norwegian -> English is
// followed turn by turn. The live thread has far more history, so this is the harder case; the live history
// agreed (13/13 clear pairs). PLAN=fresh plays single messages in EMPTY threads: there the Oslo cues and
// Norwegian material can win (a Norwegian answer to an English question, seen 2/3); a rule in the system
// prompt did not change that (0/2) and was not shipped. A new person's first text sets their language.
//
// Usage (from packages/server, after `pnpm build`, ANTHROPIC_API_KEY and COMPOSIO_API_KEY set):
//   node scenarios/language.mjs                 the conversations (about 18 cents)
//   PLAN=fresh node scenarios/language.mjs      single messages in empty threads (about 10 cents)
//   MEMORY_FILE=<copy of the owner's MEMORY.md>  instead of the made-up notes
//   GRADER_CHECK=1                               only checks the language guesser on known texts (free)
//   MAX_USD=0.2 stops before the next message once the spend passes it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComposioApps } from "@open-instinct/apps";
import { boot } from "../dist/boot.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const composioKey = process.env.COMPOSIO_API_KEY?.trim();
if (!apiKey || !composioKey) throw new Error("ANTHROPIC_API_KEY and COMPOSIO_API_KEY must be set");
const MAX_USD = Number(process.env.MAX_USD ?? 0.2);
const SKILLS = fileURLToPath(new URL("../../../skills", import.meta.url));
const OWNER = "+4790000000";
ComposioApps.prototype.connectedToolkits = async function () {
  return [{ slug: "gmail", connected: true }, { slug: "googlecalendar", connected: true }];
};

const dir = mkdtempSync(join(tmpdir(), "language-"));
mkdirSync(join(dir, "memory"), { recursive: true });
writeFileSync(join(dir, "memory", "MEMORY.md"), process.env.MEMORY_FILE ? readFileSync(process.env.MEMORY_FILE, "utf8") : "## About\n- Torstein lives in Oslo.\n\n## People\n- Sanna: girlfriend.\n- Martin Berg: friend from work (martin.berg@example.no).\n");
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, INSTINCT_DATA_DIR: dir, INSTINCT_SKILLS_DIR: SKILLS,
  INSTINCT_WATCHER: "1", INSTINCT_COMPUTER: "auto", MARITIME_DESKTOP: "1",
  INSTINCT_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: apiKey,
  INSTINCT_OWNER_NAME: "Torstein", INSTINCT_OWNER_PHONE: OWNER, INSTINCT_OWNER_TIMEZONE: "Europe/Oslo", INSTINCT_AGENT_NAME: "Sunshine",
  INKBOX_API_KEY: "dummy", INKBOX_AGENT_HANDLE: "sunshine-language-test", INKBOX_IDENTITY_ID: "00000000-0000-0000-0000-000000000000",
  BRAVE_SEARCH_API_KEY: "dummy", COMPOSIO_API_KEY: composioKey, COMPOSIO_TOOLKITS: "gmail,googlecalendar", COMPOSIO_MODE: "router",
};
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (url.startsWith("http://127.0.0.1:5911/health")) return new Response(JSON.stringify({ ok: true, data_ready: true, mode: "agent", size: [1280, 800] }), { status: 200, headers: { "content-type": "application/json" } });
  if (/composio/.test(url)) return realFetch(input, init); // the router's tool definitions
  throw new Error(`offline: ${url}`);
};
const sent = [];
const app = await boot(env, { fetchImpl, outbox: { send: async (m) => void sent.push(m), typing: async () => {} }, logger: () => {} });
const { registry } = app.runtime.deps;

// Made-up material in another language than the request.
const NORWEGIAN_EMAIL = `From: Delphi Fondene <nyhetsbrev@delphi.example>\nSubject: Huset vinner alltid. Eller?\nDate: today 07:45\n\nHei Torstein,\n\nDenne uken ser vi nærmere på hvorfor aksjemarkedet har holdt stand selv om renten fortsatt er høy. Mange investorer har ventet på et fall som aldri kom. Vi mener det handler om at selskapenes inntjening har vært sterkere enn ventet, særlig innen teknologi og energi.\n\nSamtidig ser vi økende uro i kredittmarkedene, og vi har derfor redusert risikoen litt i våre globale fond. Vi tror ikke på et krakk, men vi vil heller være forsiktige enn å jage de siste prosentene.\n\nLes mer i ukens analyse på delphi.example.\n\nVennlig hilsen\nDelphi Fondene`;
const ENGLISH_XRP = "CoinDesk, today 09:12: XRP rose 4% to $1.34 after Ripple said a court filing in its long-running case was settled. Analysts said the move was driven by derivatives traders closing short positions; spot volume stayed flat.";
const ENGLISH_WEATHER = "yr.no (English): Oslo tomorrow: cloudy in the morning, light rain from 14:00, 7-9°C, wind 4 m/s from the south-west. Clearing in the evening.";
const drafts = [];
function scripted(name, args) {
  const a = JSON.stringify(args ?? {});
  if (name === "app_composio_search_tools") return "GMAIL_FETCH_EMAILS: list recent emails (max_results, query)\nGMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: one email in full\nGMAIL_CREATE_EMAIL_DRAFT: draft an email (recipient_email, subject, body)\nGMAIL_SEND_EMAIL: send an email";
  if (name === "app_composio_get_tool_schemas") return "Schemas as listed; all arguments are strings unless noted.";
  if (name === "app_composio_multi_execute_tool") {
    if (/DRAFT/i.test(a)) { drafts.push(args); return "Done: the draft was saved in Gmail (not sent)."; }
    if (/SEND/i.test(a)) return "Done: sent.";
    return NORWEGIAN_EMAIL;
  }
  if (name === "app_composio_manage_connections" || name === "apps_list") return "Connected: gmail, googlecalendar.";
  if (name === "web_search") return /xrp|ripple/i.test(a) ? ENGLISH_XRP : /weather|vær|oslo/i.test(a) ? ENGLISH_WEATHER : "No useful results.";
  if (name === "web_fetch") return /yr|weather|vær/i.test(a) ? ENGLISH_WEATHER : /xrp|coindesk/i.test(a) ? ENGLISH_XRP : "Page text: (nothing relevant)";
  if (name === "history_search") return "No matches.";
  if (name.startsWith("memory_") || name === "journal_append") return "Saved.";
  if (name === "react") return "Reacted.";
  return "Done.";
}
for (const t of registry.all()) {
  if (t.spec.name === "load_tools" || t.spec.name === "load_skill") continue;
  const name = t.spec.name;
  t.spec.execute = async (args) => scripted(name, args);
}

// A rough language guess from short words only one language uses (enough to tell these three apart).
const WORDS = {
  en: ["the", "and", "you", "is", "are", "it", "to", "of", "that", "this", "your", "about", "with", "from", "will", "what", "there", "has", "have", "be"],
  no: ["og", "ikke", "jeg", "er", "til", "deg", "meg", "et", "dette", "fra", "hva", "hvordan", "også", "nå", "bare", "være", "været", "regn", "skyet", "kveld"],
  sv: ["och", "inte", "jag", "är", "till", "dig", "mig", "ett", "detta", "från", "vad", "hur", "också", "nu", "bara", "vara", "idag", "steg", "efter", "kväll"],
};
function language(text) {
  const words = String(text).toLowerCase().normalize("NFKC").split(/[^\p{L}]+/u);
  const score = Object.fromEntries(Object.entries(WORDS).map(([l, list]) => [l, words.filter((w) => list.includes(w)).length]));
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return { lang: best[1] > 0 ? best[0] : "?", score };
}

// The guesser on texts whose language is known (replies seen in the first run), before trusting it.
if (process.env.GRADER_CHECK) {
  const known = [
    ["en", "It's a newsletter from Delphi Fondene, sent this morning. The stock market has held up despite high interest rates because company earnings came in stronger than expected."],
    ["no", "Det er nyhetsbrevet fra Delphi Fondene i dag. Aksjemarkedet har holdt seg bra til tross for høy rente, fordi inntjeningen har vært sterkere enn ventet."],
    ["sv", "XRP har stigit ungefär 4 % i dag och ligger på cirka 1,34 dollar. Jag hittade bara den här källan, så siffrorna kan ha ändrats sedan morgonen."],
    ["no", "I morgen blir det skyet om morgenen, og så kommer det lett regn fra rundt kl. 14. Ta med paraply hvis du skal ut på ettermiddagen."],
    ["en", "Here's a draft. Want me to change the tone or save it in Gmail?"],
    ["no", "Hei Martin! Dessverre, jeg rekker ikke middagen på fredag. Håper dere får en fin kveld, og så tar vi en annen gang snart?"],
  ];
  let right = 0;
  for (const [want, t] of known) { const g = language(t); if (g.lang === want) right++; console.log(`${g.lang === want ? "ok  " : "MISS"} want ${want} got ${g.lang} ${JSON.stringify(g.score)} | ${t.slice(0, 50)}`); }
  // The three draft replies seen so far: draft alone (right), English words around it (right), Norwegian
  // words around it (wrong: the person asked in English).
  const draftShapes = [
    ["right", "Hei Martin! Beklager, jeg rekker dessverre ikke middagen på fredag. Kan vi ta det en annen gang snart?"],
    ["right", "Here's a draft: \"Hei Martin! Beklager, jeg rekker dessverre ikke middagen på fredag. Kan vi ta det en annen gang snart?\" Want me to change anything before you send it?"],
    ["wrong", "Her er et utkast: \"Hei Martin! Dessverre, jeg rekker ikke middagen på fredag. Håper dere får en fin kveld, og så tar vi en annen gang snart?\" Vil du at jeg justerer tonen, eller skal jeg sende den?"],
  ];
  for (const [want, t] of draftShapes) {
    const { own, draft } = split(t, "");
    const ownLang = own.trim() ? language(own).lang : "none";
    const got = (ownLang === "en" || ownLang === "none") && language(draft).lang === "no" ? "right" : "wrong";
    if (got === want) right++;
    console.log(`${got === want ? "ok  " : "MISS"} draft shape want ${want} got ${got} (own ${ownLang}, draft ${language(draft).lang}) | ${t.slice(0, 40)}`);
  }
  console.log(`grader: ${right}/${known.length + draftShapes.length}`);
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// What Sunshine says to the owner, told apart from a draft it writes for someone else: a draft is what it
// saved with Gmail or put in quotes. A reply that is nothing but the requested draft has no words of its
// own, so only the draft is graded then (seen: "Hei Martin! ..." alone, which is right).
function split(reply, draftBody) {
  if (draftBody) return { own: reply.replace(draftBody.slice(0, 40), ""), draft: draftBody };
  const quoted = [...reply.matchAll(/[“"«]([^”"»]{20,})[”"»]/g)].map((m) => m[1]);
  if (!quoted.length && /^\s*(hei|hi|hey|hallo|hello|dear|kjære)\s+martin\b/i.test(reply)) return { own: "", draft: reply };
  let own = reply;
  for (const q of quoted) own = own.replace(q, "");
  return { own, draft: quoted.join(" ") };
}

const WARM = { text: "hey, what's the weather like in Oslo tomorrow?", want: "en" };
const EMAIL = { text: "nice. what does the newest email from Delphi say? just the gist", want: "en" };
const DRAFT = { text: "draft a short reply to Martin in Norwegian saying I can't make dinner on Friday. don't send it", want: "en", draftWant: "no" };
const THREADS = process.env.PLAN === "fresh"
  ? [
      ["fresh-email-1", [{ ...EMAIL, text: "what does the newest email from Delphi say? just the gist" }]],
      ["fresh-email-2", [{ ...EMAIL, text: "what does the newest email from Delphi say? just the gist" }]],
      ["fresh-swedish", [{ text: "Vad händer med XRP idag?", want: "sv" }]],
      ["fresh-norwegian", [{ text: "Hvordan blir været i Oslo i morgen?", want: "no" }]],
      ["fresh-draft", [DRAFT]],
    ]
  : [
      ["email-1", [WARM, EMAIL]],
      ["switch", [WARM, { text: "Hva står det i den nyeste e-posten fra Delphi?", want: "no" }, { text: "ok thanks. anything else important in my inbox?", want: "en" }]],
      ["draft", [WARM, DRAFT]],
      ["email-2", [WARM, EMAIL]],
    ];

let cost = 0, n = 0, right = 0, graded = 0;
outer: for (const [name, turns] of THREADS) {
  const conv = `imessage:lang_${name}`;
  console.log(`\n=== ${name}`);
  for (const turn of turns) {
    if (cost > MAX_USD) { console.log(`\nStopped: spent $${cost.toFixed(3)}, over MAX_USD ${MAX_USD}.`); break outer; }
    sent.length = 0; drafts.length = 0;
    const before = app.runtime.conversation(conv, app.runtime.ownerPrincipal()).agent.state.messages.length;
    await app.runtime.handleInbound({ id: `evt_lang_${++n}`, channel: "imessage", from: OWNER, conversationKey: conv, text: turn.text, replyRef: {}, receivedAt: new Date().toISOString() }, { waitForCompletion: true });
    const msgs = app.runtime.conversation(conv, app.runtime.ownerPrincipal()).agent.state.messages.slice(before);
    const spent = msgs.filter((m) => m.role === "assistant" && m.usage).reduce((s, m) => s + (m.usage.cost?.total ?? 0), 0);
    cost += spent;
    const reply = sent.map((m) => m.text).filter(Boolean).join(" / ") || "(nothing sent)";
    const draftBody = drafts.map((d) => JSON.stringify(d).match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "").join(" ");
    const { own, draft } = turn.draftWant ? split(reply, draftBody) : { own: reply, draft: "" };
    const ownLang = own.trim() ? language(own).lang : "none";
    const draftLang = turn.draftWant ? language(draft).lang : null;
    const ok = (ownLang === turn.want || (turn.draftWant && ownLang === "none")) && (!turn.draftWant || draftLang === turn.draftWant);
    graded++; if (ok) right++;
    console.log(`  ${ok ? "ok  " : "MISS"} wanted ${turn.want}${turn.draftWant ? ` + draft ${turn.draftWant}` : ""}, got ${ownLang}${turn.draftWant ? ` + draft ${draftLang}` : ""}  $${spent.toFixed(4)}`);
    console.log(`    Torstein: ${turn.text}`);
    console.log(`    Sunshine: ${reply.replace(/\n/g, " / ")}`);
  }
}
console.log(`\n===== ${right}/${graded} replies in the right language. Cost: $${cost.toFixed(4)}`);
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
