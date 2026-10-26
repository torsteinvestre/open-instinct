/**
 * Wire one agent process from env + state. This is the only place that decides
 * which optional pieces exist (Inkbox, computer, apps, network) based on what is
 * configured. Everything it builds is returned so main.ts, the smoke test and
 * embedders can drive it the same way.
 */
import { resolve } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  A2AStore,
  ApprovalStore,
  AuditLog,
  ContactStore,
  MemoryStore,
  PolicyEngine,
  Scheduler,
  StateDir,
  ToolRegistry,
  HistoryArchive,
  ItemArchive, // [sunshine:intake]
  MeaningSearch, // [sunshine:meaning-search]
  coreTools,
  ensurePersona,
  loadConfig,
  ownerClaimStatus,
  syncInstructions,
  loadPolicy,
  phoneCountryOf,
  resolveDataDir,
  resolveModel,
} from "@open-instinct/core";
import type { InboundMessage, InstinctConfig, Outbox, Principal, RegisteredTool } from "@open-instinct/core";
import type { LoadableGroup } from "@open-instinct/core"; // [sunshine:tool-loader]
import type { Embedder } from "@open-instinct/core"; // [sunshine:meaning-search]
import { CALL_ORIGINATIONS, InkboxA2A, InkboxChannel, InkboxInboundHydrator, InkboxProvisioner, handleCallEnded, messagingTools, sendFileTool, voiceInstructions } from "@open-instinct/inkbox";
import type { CallEndedEvent, CallOrigination } from "@open-instinct/inkbox";
import { computerGuidance, detectComputer } from "@open-instinct/computer";
import type { ComputerBackend } from "@open-instinct/computer";
import { ComposioApps, DEFAULT_TOOLKITS, OPENAI_COMPLETIONS_TOOL_LIMIT, appsGuidance, appsTools, composioModeFor } from "@open-instinct/apps";
import { actionsAllowed, appsForOthersGuidance } from "@open-instinct/apps"; // [sunshine:app-permissions]
import { ampleTools, type AmpleCredentials } from "@open-instinct/ample";
import { AtomicMailBackend, atomicMailGuidance } from "@open-instinct/atomicmail";
import { contextTools } from "@open-instinct/context";
import { networkTools } from "@open-instinct/network";
// [sunshine:watcher]
import { DEFAULT_DECIDE_MODEL, DEFAULT_SCREEN_MODEL, DEFAULT_WRITE_MODEL, NEWS_PROMPT, WATCH_GATE, createWatcher, modelCall, resolveWatcherModel, stepModelSpec, type ModelCall, type Watcher } from "@open-instinct/watcher";
import { researchWith, writerContextFor } from "./watcher-writer.js";
import { DEFAULT_MEMORY_MODEL, MEMORY_GATE, MEMORY_REASONING, createMemoryPass } from "./memory-pass.js"; // [sunshine:memory]
import { DEFAULT_INTAKE_MODEL, INTAKE_REASONING, createIntake, type Intake } from "./intake.js"; // [sunshine:intake]
import { createLocalEmbedder } from "./embedder.js"; // [sunshine:meaning-search]
import { recordingsTools } from "./recordings.js"; // [sunshine:recordings]
import { ChatAwareOutbox, ConsoleOutbox, type ChatReplyBuffer } from "./console-outbox.js";
import { fileTools, resolveInsideWorkspace } from "./file-tools.js";
import { describeDataPart, promptExtraFor } from "./hooks.js";
import { appsNotConfiguredTool, setupSummaryFor } from "./setup-summary.js";
import { createScheduleSync, type ScheduleSync } from "./maritime-schedules.js";
import { loadPaymentsModule, paymentsEnv, type LinkWalletLike, type PaymentsModule } from "./payments.js";
import { createSkillCatalog, formatSkillsIndex, loadSkillTool, ownerSkillsDir, resolveSkillsDir, skillGuide, skillsFor } from "./skills.js"; // [sunshine:onboarding] skillGuide

/** How often the skill folders are re-read; an owner-installed skill shows up within this. */
const SKILLS_REFRESH_MS = 30_000;

export interface BootOptions {
  streamFn?: StreamFn;
  model?: Model<any>;
  outbox?: Outbox;
  logger?: (m: string) => void;
  skillsDir?: string;
  /** Override for tests. Default: real fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests: the payments module to wire instead of importing @open-instinct/payments. */
  payments?: PaymentsModule;
  /** [sunshine:meaning-search] Tests and scenarios: the search model to use (turns meaning search on). */
  embedder?: Embedder;
}

/** [sunshine:meaning-search] After boot, wait this long before storing what is not stored yet (the agent settles first). */
const MEANING_BACKFILL_DELAY_MS = 2 * 60 * 1000;

export interface BootResult {
  runtime: AgentRuntime;
  state: StateDir;
  config: InstinctConfig;
  scheduler: Scheduler;
  outbox: Outbox;
  close(): Promise<void>;
  computerKind?: string;
  apps?: ComposioApps;
  /** Toolkits Composio reports as connected at boot, for the status page. */
  appsConnected?: string[];
  startedAt: number;
  modelSpec: string;
  /** Finished chat replies waiting for the next /chat on their conversation. */
  chatBuffer: ChatReplyBuffer;
  /** Set when LINK_CLIENT_ID, LINK_CLIENT_SECRET and STRIPE_PUBLISHABLE_KEY are present and the package is installed. */
  wallet?: LinkWalletLike;
  /** Complete compact Inkbox events before handing them to the runtime. */
  hydrateInbound?: (message: InboundMessage) => Promise<InboundMessage>;
  /** Set with Inkbox: text the owner the outcome of a finished phone call. */
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
  /** [sunshine:intake] Takes in what reached the owner from elsewhere (an `intake.item` event). */
  intake?: Intake;
}

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<BootResult> {
  const log = opts.logger ?? ((m: string) => console.log(`[instinct] ${m}`));
  const startedAt = Date.now();

  const state = new StateDir(resolveDataDir(env));
  state.ensure();
  const config = loadConfig(state, env);
  if (config.owner.claimOnFirstContact && config.owner.phones.length === 0) {
    const claim = ownerClaimStatus(config);
    log(claim.enabled
      ? `owner claim open: the first 1:1 iMessage/SMS carrying the one-time code becomes the owner${config.owner.claimExpiresAt ? ` (until ${config.owner.claimExpiresAt})` : ""}`
      : `WARNING: owner claim is disabled: ${claim.reason}. Nobody can claim this agent until a valid code is set`);
  }
  // PERSONA.md is the owner's file; INSTINCT_PERSONA seeds it on first boot only.
  if (ensurePersona(state, env.INSTINCT_PERSONA)) log(`wrote ${state.path("PERSONA.md")}${env.INSTINCT_PERSONA?.trim() ? " from INSTINCT_PERSONA" : " (default persona)"}`);
  // AGENTS.md is the owner's standing-instructions file. INSTINCT_INSTRUCTIONS seeds it, and a changed seed
  // replaces it as long as the owner never edited the file; an edited file is theirs.
  const instructions = syncInstructions(state, env.INSTINCT_INSTRUCTIONS);
  if (instructions === "created" || instructions === "updated") log(`${instructions} ${state.path("AGENTS.md")} from INSTINCT_INSTRUCTIONS`);

  const audit = new AuditLog(state);
  const policy = new PolicyEngine(loadPolicy(state), {
    spentTodayUsd: () => audit.spentTodayUsd(config.owner.timezone),
  });
  const approvals = new ApprovalStore(state);
  const scheduler = new Scheduler(state);
  const contacts = new ContactStore(state, { phoneCountry: phoneCountryOf(config), warn: log }); // [sunshine:phone] phoneCountry
  const memory = new MemoryStore(state);
  // [sunshine:meaning-search] Set below; the archives tell it when they change.
  let meaning: MeaningSearch | undefined;
  const changed = () => meaning?.schedule();
  // [sunshine:history] The owner's conversations, kept for searching; off with features.history = false.
  const history = config.features?.history === false ? undefined : new HistoryArchive(state, { onChange: changed });
  // [sunshine:intake] What reached the owner from elsewhere: the same archive, the same switch.
  const items = history ? new ItemArchive(state, { onChange: changed }) : undefined;
  // [sunshine:meaning-search] Search by meaning over both: on with INSTINCT_MEANING_SEARCH=1 (the model is
  // fetched into /data/models on first use, about 0.9 GB), or with a search model passed in.
  const localEmbedder = history && !opts.embedder && env.INSTINCT_MEANING_SEARCH === "1" ? createLocalEmbedder({ cacheDir: state.path("models"), log }) : undefined;
  const embedder = opts.embedder ?? localEmbedder;
  if (embedder && history) {
    meaning = new MeaningSearch({ state, embedder, config, history, ...(items ? { items } : {}), audit });
    const { pieces, stored } = meaning.status();
    log(`meaning search: on (${stored} of ${pieces} pieces stored)`);
    if (stored < pieces) meaning.schedule(MEANING_BACKFILL_DELAY_MS);
  }
  const a2aStore = new A2AStore(state);

  const model = opts.model ?? resolveModel(config.model.primary, env);
  const modelSpec = `${model.provider}/${model.id}`;

  const inkbox = inkboxSettings(env, config);
  const a2a = inkbox ? new InkboxA2A({
    apiKey: inkbox.apiKey,
    handle: inkbox.handle,
    ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;
  const externalUserId = inkbox?.handle ?? config.agent.handle ?? "owner";

  // Outbox: Inkbox when configured, else console. A caller-supplied outbox wins (tests).
  // Whatever the transport, `chat` replies are buffered for the HTTP layer: that channel
  // is the dashboard or CLI waiting on a response, not a wire Inkbox can deliver on.
  let channel: InkboxChannel | undefined;
  let outbox: Outbox;
  let chatBuffer: ChatReplyBuffer;
  if (opts.outbox) {
    if (opts.outbox instanceof InkboxChannel) channel = opts.outbox;
    const wrapped = new ChatAwareOutbox(opts.outbox);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else if (inkbox) {
    channel = new InkboxChannel({
      apiKey: inkbox.apiKey,
      handle: inkbox.handle,
      identityId: inkbox.identityId,
      ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const wrapped = new ChatAwareOutbox(channel);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else {
    const console_ = new ConsoleOutbox({ logger: log });
    outbox = console_;
    chatBuffer = console_.chat;
    log("Inkbox not configured: replies go to the console outbox");
  }

  const registry = new ToolRegistry();
  const promptSections: string[] = [];
  // [sunshine:tool-loader] The owner's email, desktop, file and people tools load when a request needs
  // them; the desktop and apps guidance then comes with the load instead of sitting in every prompt.
  const loadOnDemand = config.features?.toolLoader !== false && config.features?.stableCache !== false;
  const groupGuidance: Partial<Record<LoadableGroup, string>> = {};

  registry.registerMany(
    coreTools({
      memory,
      scheduler,
      approvals,
      audit,
      config,
      outbox,
      workspaceDir: state.path("workspace"),
      ...(history ? { history } : {}), // [sunshine:history]
      ...(items ? { items } : {}), // [sunshine:intake]
      ...(meaning ? { meaning } : {}), // [sunshine:meaning-search]
      onApprovalSettled: (approval, approved) => runtime.afterApproval(approval, approved),
      // Image generation rides on an OpenAI-compatible key: a dedicated IMAGE_API_KEY, else the model key
      // (an OpenAI-compatible proxy that forwards /images/generations works too). The shell never sees either.
      ...(env.IMAGE_API_KEY || env.OPENAI_API_KEY
        ? {
            images: {
              apiKey: (env.IMAGE_API_KEY || env.OPENAI_API_KEY) as string,
              ...(env.IMAGE_BASE_URL || env.OPENAI_BASE_URL ? { baseUrl: env.IMAGE_BASE_URL || env.OPENAI_BASE_URL } : {}),
              ...(env.IMAGE_MODEL ? { model: env.IMAGE_MODEL } : {}),
            },
          }
        : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(env.BRAVE_SEARCH_API_KEY ? { searchApiKey: env.BRAVE_SEARCH_API_KEY } : {}),
    }),
  );

  // [sunshine:recordings] Recordings the owner sends: transcribed by the service, kept through the intake, the audio
  // deleted. With TRANSCRIBE_URL and TRANSCRIBE_KEY; the intake and runtime are made further down.
  if (items && env.TRANSCRIBE_URL?.trim() && env.TRANSCRIBE_KEY?.trim()) {
    registry.registerMany(
      recordingsTools({
        state,
        config,
        audit,
        intake: { receive: (item) => (intake ? intake.receive(item) : Promise.reject(new Error("the intake is not available"))) },
        runTask: (task) => runtime.runSystemTask(task),
        service: { url: env.TRANSCRIBE_URL.trim(), key: env.TRANSCRIBE_KEY.trim() },
        workspace: state.path("workspace"),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    log("recordings: on");
  }

  if (env.CONTEXT_DEV_API_KEY) {
    registry.registerMany(
      contextTools({
        apiKey: env.CONTEXT_DEV_API_KEY,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }

  // Messaging needs Inkbox. send_file does not: without a wire it still hands files
  // to the dashboard chat, which is how `instinct chat` and the smoke test get them.
  const callOrigination = callOriginationFrom(env);
  if (channel) registry.registerMany(messagingTools({ channel, contacts, config, dataDir: state.root, ...(callOrigination ? { callOrigination } : {}) }));
  else registry.register(sendFileTool({ contacts, config, dataDir: state.root }));
  // Voice AI speaks as the owner's assistant. Only a chosen voice (INKBOX_VOICE or config.json agent.voice)
  // triggers the write: the config is a full replace on Inkbox, and an unset voice keeps the org default.
  const voice = env.INKBOX_VOICE?.trim() || config.agent.voice?.trim();
  if (channel && voice) {
    const ch = channel;
    const set = await safely(log, "phone voice", async () => {
      await ch.setVoiceConfig({ voice, instructions: voiceInstructions(config.owner.name) });
      return true;
    });
    if (set) log(`phone voice: ${voice}`);
  }
  const hydrator = channel ? new InkboxInboundHydrator({
    channel,
    mediaDir: state.path("workspace", "inbound"),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;

  registry.registerMany(fileTools(state.path("workspace"), { env }));

  // Web app deploys through Ample: with the deployer's credential, or with an
  // account this agent signs up for itself on the first deploy (AMPLE_SIGNUP=1),
  // which is how every person behind a shared gateway gets an account of their own.
  const ample = ampleCredentials(env);
  const ampleSignup = !ample && env.AMPLE_SIGNUP === "1";
  if (ample || ampleSignup) {
    const workspace = state.path("workspace");
    const ownerEmail = config.owner.emails[0];
    registry.registerMany(
      ampleTools({
        ...(ample
          ? { credentials: ample }
          : {
              signup: {
                file: state.path("secrets", "ample.json"),
                name: `open-instinct-${config.agent.handle ?? "agent"}`,
                ...(ownerEmail ? { ownerEmail } : {}),
              },
            }),
        workspaceDir: workspace,
        resolvePath: (requested) => resolveInsideWorkspace(workspace, requested),
        env,
        ...(env.AMPLE_API_URL ? { apiUrl: env.AMPLE_API_URL } : {}),
        ...(env.AMPLE_BIN ? { bin: env.AMPLE_BIN } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    log(`ample: web app deploys on (${ample ? "shared credential" : "own account on first deploy"})`);
  }

  // Computer: in-VM desktopd, hosted Maritime Computers MCP, or nothing.
  const computer = await safely(log, "computer", () =>
    detectComputer({
      mode: config.computer.mode,
      desktopdUrl: config.computer.desktopdUrl,
      maritimeMcpUrl: config.computer.maritimeMcpUrl ?? env.MARITIME_COMPUTERS_MCP_URL ?? DEFAULT_MARITIME_MCP_URL,
      maritimeApiKey: env.MARITIME_API_KEY,
      externalUserId,
      // Maritime starts the desktop stack in the background; desktopd may still be coming up.
      expectDesktopd: env.MARITIME_DESKTOP === "1",
      ...(env.MARITIME_AGENT_ID ? { agentId: env.MARITIME_AGENT_ID } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    }),
  );
  if (computer) {
    const tools = await safely(log, "computer tools", () => computer.tools());
    if (tools && tools.length > 0) {
      registry.registerMany(tools);
      if (loadOnDemand) groupGuidance.computer = computerGuidance(); // [sunshine:tool-loader]
      else promptSections.push(computerGuidance());
      log(`computer: ${computer.describe()}`);
    }
  }

  // Apps through Composio, when the deployer gave us a key. The key is the switch:
  // config.apps.enabled only records that a toolkit list was seeded. A list of
  // `all` (or `*`) drops the allowlist so any app can be connected by name.
  let apps: ComposioApps | undefined;
  let appsConnected: string[] | undefined;
  let appActions: string[] = []; // [sunshine:app-permissions]
  if (env.COMPOSIO_API_KEY) {
    const toolkits = config.apps.toolkits.length > 0 ? config.apps.toolkits : DEFAULT_TOOLKITS;
    // Direct mode lists one tool per app action; router mode lists Composio's meta tools only.
    // OpenAI-style chat completions (the Maritime LLM proxy) cap a request at 128 tools.
    const { mode, reason } = composioModeFor(env, model.api);
    const composio = new ComposioApps({ apiKey: env.COMPOSIO_API_KEY, userId: externalUserId, toolkits, mode, state, logger: log });
    log(`apps: composio ${composio.mode} mode (${composio.allToolkits ? "all toolkits always use router" : reason})`);
    const connected = await safely(log, "apps", async () => {
      await composio.connect();
      const tools = await composio.tools();
      const status = await composio.connectedToolkits();
      return { tools, status };
    });
    if (connected) {
      apps = composio;
      registry.registerMany(connected.tools);
      registry.registerMany(appsTools({ apps: composio }));
      const on = connected.status.filter((s: ToolkitStatus) => s.connected).map((s: ToolkitStatus) => s.slug);
      const missing = connected.status.filter((s: ToolkitStatus) => !s.connected).map((s: ToolkitStatus) => s.slug);
      appsConnected = on;
      const guidance = appsGuidance(on, missing, { anyApp: composio.allToolkits, unavailable: composio.unavailableToolkits });
      if (loadOnDemand) groupGuidance.apps = guidance; // [sunshine:tool-loader]
      else promptSections.push(guidance);
      log(`apps: ${connected.tools.length} tools${composio.allToolkits ? " (any app by name)" : ""}, connected: ${on.join(", ") || "none"}`);
      // [sunshine:app-permissions] In router mode other people's agents reach the apps only through the
      // generic executor, so they are told by name which actions their tier may use (direct mode lists them).
      if (composio.mode === "router") {
        appActions = (await safely(log, "apps catalog", () => composio.actionCatalog())) ?? [];
        log(`apps: catalog of ${appActions.length} actions for other people's agents`);
      }
    }
  }
  // Atomic Mail: an inbox of the agent's own, when the deployer gave us a key. The key is
  // the switch. With it unset nothing here runs and nothing else changes.
  let mailbox: AtomicMailBackend | undefined;
  if (env.ATOMIC_MAIL_API_KEY) {
    const backend = new AtomicMailBackend({
      apiKey: env.ATOMIC_MAIL_API_KEY,
      ...(env.ATOMIC_MAIL_MCP_URL ? { url: env.ATOMIC_MAIL_MCP_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    const connected = await safely(log, "atomicmail", async () => ({ tools: await backend.tools(), address: await backend.address() }));
    if (connected && connected.tools.length > 0) {
      mailbox = backend;
      registry.registerMany(connected.tools);
      promptSections.push(atomicMailGuidance(connected.address));
      log(`atomicmail: ${connected.tools.length} tools${connected.address ? ` (${connected.address})` : ""}`);
    }
  }
  // No Composio key: the model still gets an apps_connect tool, so "connect my Gmail"
  // produces one precise sentence about what to set up instead of an invented screen.
  if (!apps) registry.register(appsNotConfiguredTool());

  // Trusted network: contacts, tiers, grants, A2A.
  registry.registerMany(
    networkTools({
      contacts,
      policy,
      config,
      audit,
      outbox,
      a2aStore,
      ...(a2a ? { a2a } : {}),
      ...(env.INKBOX_ADMIN_API_KEY
        ? {
            provisioner: new InkboxProvisioner({
              adminApiKey: env.INKBOX_ADMIN_API_KEY,
              ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
              ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            }),
          }
        : {}),
    }),
  );

  // [sunshine:watcher] The news watch, only where the operator turned it on (INSTINCT_WATCHER=1).
  // Checks run in code through a schedule gate and never wake the agent; the model steps are
  // settings (WATCHER_SCREEN_MODEL, WATCHER_DECIDE_MODEL, "off" switches one off; the screen is off
  // unless named).
  let watcher: Watcher | undefined;
  if (env.INSTINCT_WATCHER === "1") {
    watcher = await safely(log, "watcher", () => {
      const step = (value: string | undefined, fallback: string, reasoning: "low" | "medium") => {
        const spec = stepModelSpec(value, fallback);
        if (!spec) return undefined;
        const model = resolveWatcherModel(spec, env);
        const apiKey = apiKeyFor(model.provider, env);
        return modelCall(model, { reasoning, ...(apiKey ? { apiKey } : {}) });
      };
      // Step 1 (a cheap screen before the decision) is off unless WATCHER_SCREEN_MODEL names a model:
      // it saved almost nothing (Sonnet on 25 headlines 1.72 cents, on Haiku's 11 1.5 cents) and once
      // dropped the day's one story worth telling (2026-10-15). Jev still removes the off-topic.
      const screen = env.WATCHER_SCREEN_MODEL?.trim() ? step(env.WATCHER_SCREEN_MODEL, DEFAULT_SCREEN_MODEL, "low") : undefined;
      const decide = step(env.WATCHER_DECIDE_MODEL, DEFAULT_DECIDE_MODEL, "medium");
      // Step 3: the text is written as the agent, with its persona, memory, the end of the owner's
      // thread and its own web search (WATCHER_WRITE_MODEL, "off" sends the decision's text).
      const write = step(env.WATCHER_WRITE_MODEL, DEFAULT_WRITE_MODEL, "low");
      const research = researchWith(registry, config);
      const w = createWatcher({
        state,
        config,
        outbox,
        audit,
        scheduler,
        ...(env.TYPESAFE_API_KEY?.trim() ? { typesafeApiKey: env.TYPESAFE_API_KEY.trim() } : {}),
        ...(screen ? { screen } : {}),
        ...(decide ? { decide } : {}),
        ...(write ? { write, writerContext: writerContextFor({ state, memory, config }) } : {}),
        ...(research ? { research } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      registry.registerMany(w.tools);
      log(`watcher: on (${env.TYPESAFE_API_KEY?.trim() ? "Jev filter" : "no TYPESAFE_API_KEY, so no filter"}; screen ${screen ? stepModelSpec(env.WATCHER_SCREEN_MODEL, DEFAULT_SCREEN_MODEL) : "off"}, decide ${decide ? stepModelSpec(env.WATCHER_DECIDE_MODEL, DEFAULT_DECIDE_MODEL) : "off"}, write ${write ? stepModelSpec(env.WATCHER_WRITE_MODEL, DEFAULT_WRITE_MODEL) : "off"}${research ? " with web search" : ""})`);
      return w;
    });
  }

  // [sunshine:memory] The nightly memory notes: one model call a night, only after the owner texted.
  // MEMORY_PASS_MODEL picks the model; "off" switches the notes off (and removes their job).
  const memoryPass = await safely(log, "memory notes", () => {
    const spec = stepModelSpec(env.MEMORY_PASS_MODEL, DEFAULT_MEMORY_MODEL);
    let call: ModelCall | undefined;
    // Without a key for its model the pass could never run, so there is no job either.
    const m = spec ? resolveWatcherModel(spec, env) : undefined;
    const apiKey = m ? apiKeyFor(m.provider, env) : undefined;
    if (m && apiKey) call = modelCall(m, { reasoning: MEMORY_REASONING, apiKey }); // [sunshine:memory]
    log(`memory notes: ${call ? `nightly, ${spec}` : spec ? `off (no key for ${m?.provider})` : "off"}`);
    return createMemoryPass({ state, memory, config, scheduler, audit, ...(call ? { call } : {}), ...(history ? { history } : {}) }); // [sunshine:history] history
  });

  // Payments: a Stripe Link agent wallet, when the Link OAuth client and Stripe key are set.
  let wallet: LinkWalletLike | undefined;
  const payments = paymentsEnv(env);
  if (payments) {
    const mod = opts.payments ?? (await loadPaymentsModule());
    if (!mod) {
      log("payments: LINK_* set but @open-instinct/payments is not installed; skipping");
    } else {
      const built = await safely(log, "payments", () => {
        const w = new mod.LinkWallet({
          state,
          clientId: payments.clientId,
          clientSecret: payments.clientSecret,
          publishableKey: payments.publishableKey,
          redirectUri: payments.redirectUri,
          ...(config.agent.handle ? { statePrefix: config.agent.handle } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        return { wallet: w, tools: mod.paymentsTools({ wallet: w, outbox, config, audit, state }) };
      });
      if (built) {
        wallet = built.wallet;
        registry.registerMany(built.tools);
        log(`payments: Link wallet ${wallet.isConnected() ? "connected" : "not connected yet"}, callback ${payments.redirectUri}`);
      }
    }
  }

  const skillsDir = resolveSkillsDir({ explicit: opts.skillsDir, env, packageUrl: import.meta.url });
  // The image's skills/ first, then the owner's <data>/skills. Skills are re-read every 30 s, so one
  // installed there after boot (a git clone, a SKILL.md the agent wrote) is in the index and loadable
  // by name on the next message. Built-ins win a name clash, and an owner skill is private (only the
  // owner sees or loads it) unless its frontmatter says `visibility: public`.
  const ownerDir = ownerSkillsDir(state.root);
  const skillCatalog = createSkillCatalog({
    builtinDirs: skillsDir && resolve(skillsDir) !== resolve(ownerDir) ? skillsDir : undefined,
    ownerDir,
    log,
    refreshMs: SKILLS_REFRESH_MS,
  });
  skillCatalog.list();
  // Registered even with no skill yet, and even when every skill is hidden: those load by name.
  registry.register(loadSkillTool(skillCatalog.list));
  const staticSections = promptSections.join("\n\n");
  // Built per conversation, so each principal's index lists only the skills they may load.
  const skillsPrompt = (principal: Principal) => {
    const parts = [staticSections, formatSkillsIndex(skillsFor(skillCatalog.list(), principal))].filter((p): p is string => Boolean(p && p.trim()));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  // [sunshine:app-permissions] The owner's app actions this person's tier may ever use (tier and grants;
  // "ask" counts, the owner then approves the call). Nothing for the owner, who has every app tool.
  const appsForOthers = (principal: Principal): string[] => {
    if (principal.kind === "owner" || appActions.length === 0 || !policy.canEver(principal, "apps.use")) return [];
    const actions = actionsAllowed(appActions, (c) => policy.canEver(principal, c));
    return actions.length > 0 ? [appsForOthersGuidance(config.owner.name, actions)] : [];
  };

  // eslint-disable-next-line prefer-const
  let runtime: AgentRuntime;
  runtime = new AgentRuntime({
    state,
    config,
    policy,
    approvals,
    audit,
    scheduler,
    contacts,
    memory,
    registry,
    model,
    outbox,
    a2aStore,
    ...(a2a ? { loadA2ATask: (taskId: string) => a2a.getTask(taskId) } : {}),
    skillsPrompt,
    streamFn: opts.streamFn ?? (streamSimple as StreamFn),
    getApiKey: (provider: string) => apiKeyFor(provider, env),
    // Core cannot import the network package; the server bridges OIP and the network guidance.
    describeData: describeDataPart,
    promptExtra: (principal, channel) => [
      ...promptExtraFor(principal, channel),
      // [sunshine:watcher] With the news watch on, the owner's prompt says how to talk about it.
      ...(watcher && principal.kind === "owner" ? [NEWS_PROMPT] : []),
      // [sunshine:app-permissions] Someone else's conversation: the owner's app actions their tier may use.
      ...appsForOthers(principal),
    ],
    setupSummary: () =>
      setupSummaryFor({
        inkbox: inkbox ? { handle: inkbox.handle } : undefined,
        computerKind: computer?.kind,
        apps: apps ? { connected: appsConnected ?? [], anyApp: apps.allToolkits, toolkits: apps.toolkitSlugs } : undefined,
        wallet: wallet ? { connected: wallet.isConnected() } : undefined,
      }),
    ...(env.INSTINCT_REPLY_BUDGET_MS ? { replyBudgetMs: Number(env.INSTINCT_REPLY_BUDGET_MS) } : {}),
    // [sunshine:watcher] [sunshine:memory] Jobs that run in code first.
    scheduleGates: {
      ...(watcher ? { [WATCH_GATE]: watcher.gate } : {}),
      ...(memoryPass ? { [MEMORY_GATE]: memoryPass.gate } : {}),
    },
    // [sunshine:onboarding] The welcome guide goes with a new owner's very first text.
    firstContactGuide: () => skillGuide(skillCatalog.list(), "onboarding"),
    ...(history ? { history } : {}), // [sunshine:history]
    // [sunshine:prune] Pi keeps the prompt cache an hour with PI_CACHE_RETENTION=long; pruning waits that long then.
    ...(env.PI_CACHE_RETENTION?.trim() === "long" ? { promptCacheMs: 60 * 60 * 1000 } : {}),
    ...(loadOnDemand ? { toolLoader: { guidance: groupGuidance } } : {}), // [sunshine:tool-loader]
  });
  watcher?.ensureStarted(); // [sunshine:watcher] before the scheduler and the Maritime push read the jobs
  memoryPass?.ensureStarted(); // [sunshine:memory] likewise

  // [sunshine:intake] Items are kept and summarized once, then the agent acts on the summary.
  // INTAKE_MODEL picks the summary's model; "off" (or no key for it) keeps items without summaries.
  const intake = items
    ? await safely(log, "intake", () => {
        const spec = stepModelSpec(env.INTAKE_MODEL, DEFAULT_INTAKE_MODEL);
        const m = spec ? resolveWatcherModel(spec, env) : undefined;
        const apiKey = m ? apiKeyFor(m.provider, env) : undefined;
        const call = m && apiKey ? modelCall(m, { reasoning: INTAKE_REASONING, apiKey }) : undefined;
        log(`intake: ${call ? `summaries by ${spec}` : "items kept without summaries"}`);
        return createIntake({ items, memory, config, audit, ...(call ? { call } : {}), runTask: (task) => runtime.runSystemTask(task) });
      })
    : undefined;
  // [sunshine:delivery-mirror] Every text goes out through the channel; the runtime copies the ones
  // that reached the owner from elsewhere (reminders, news, relays) into the owner's thread.
  if (channel) channel.afterSend = (msg, ctx) => runtime.mirrorToOwner(msg, ctx);

  const stopScheduler = scheduler.start((entry) => runtime.runScheduled(entry));

  let sync: ScheduleSync | undefined;
  if (env.MARITIME_BACKEND_URL && env.MARITIME_INTERNAL_TOKEN && env.MARITIME_AGENT_ID) {
    sync = createScheduleSync({
      backendUrl: env.MARITIME_BACKEND_URL,
      token: env.MARITIME_INTERNAL_TOKEN,
      agentId: env.MARITIME_AGENT_ID,
      read: () => scheduler.toMaritimeSchedules(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    await sync.push(true);
    sync.start();
  }

  const toolCount = registry.all().length;
  if (model.api === "openai-completions" && toolCount > OPENAI_COMPLETIONS_TOOL_LIMIT) {
    log(
      `warning: ${toolCount} tools registered, but ${modelSpec} accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} per request, ` +
        "so owner replies will fail. Set COMPOSIO_MODE=router or shorten COMPOSIO_TOOLKITS.",
    );
  }
  log(`agent "${config.agent.name}" ready: model ${modelSpec}, ${toolCount} tools, data ${state.root}`);

  return {
    runtime,
    state,
    config,
    scheduler,
    outbox,
    computerKind: computer?.kind,
    apps,
    appsConnected,
    startedAt,
    modelSpec,
    chatBuffer,
    ...(wallet ? { wallet } : {}),
    ...(hydrator ? { hydrateInbound: (message: InboundMessage) => hydrator.hydrate(message) } : {}),
    ...(channel ? { onCallEnded: callReporter(channel, (text, key) => runtime.relayToOwner(text, key), log) } : {}),
    ...(intake ? { intake } : {}), // [sunshine:intake]
    async close() {
      stopScheduler();
      sync?.stop();
      await safely(log, "computer close", () => computer?.close());
      await safely(log, "apps close", () => apps?.close());
      await safely(log, "atomicmail close", () => mailbox?.close());
      // [sunshine:meaning-search] Release the search model, if loaded.
      await safely(log, "search model close", () => localEmbedder?.close());
    },
  };
}

interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** Env variable per Pi provider id. Anything not listed falls back to <PROVIDER>_API_KEY. */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "openai": ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "groq": ["GROQ_API_KEY"],
  "mistral": ["MISTRAL_API_KEY"],
  "xai": ["XAI_API_KEY"],
  "openrouter": ["OPENROUTER_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY"],
  "cerebras": ["CEREBRAS_API_KEY"],
  "zai": ["ZAI_API_KEY"],
  "minimax": ["MINIMAX_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * Provider key from the env the server was handed (not process.env, so tests and
 * embedders control it). Pi would read process.env itself; passing the key keeps
 * the lookup in one place and lets `instinct dev` and embedders inject keys.
 */
export function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = PROVIDER_KEY_ENV[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** INKBOX_CALL_ORIGINATION, when it names a line Inkbox knows. Anything else is logged by the tool at boot. */
export function callOriginationFrom(env: NodeJS.ProcessEnv): CallOrigination | undefined {
  const raw = env.INKBOX_CALL_ORIGINATION?.trim().toLowerCase();
  if (!raw) return undefined;
  if ((CALL_ORIGINATIONS as readonly string[]).includes(raw)) return raw as CallOrigination;
  throw new Error(`INKBOX_CALL_ORIGINATION must be one of ${CALL_ORIGINATIONS.join(", ")}, not "${raw}"`);
}

/** The call.ended handler: fetch the transcript when the event has none, then one text to the owner. */
export function callReporter(
  channel: Pick<InkboxChannel, "callTranscript">,
  relay: (text: string, originKey: string) => Promise<boolean>,
  log: (m: string) => void,
): (event: CallEndedEvent) => Promise<void> {
  return async (event) => {
    await handleCallEnded(event, {
      fetchTranscript: (callId) => channel.callTranscript(callId),
      relayToOwner: (text) => relay(text, `system:call:${event.callId}`),
      logger: log,
    });
  };
}

interface InkboxSettings {
  apiKey: string;
  handle: string;
  identityId?: string;
}

function inkboxSettings(env: NodeJS.ProcessEnv, config: InstinctConfig): InkboxSettings | undefined {
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE ?? config.agent.handle;
  if (!apiKey || !handle) return undefined;
  return { apiKey, handle, identityId: env.INKBOX_IDENTITY_ID };
}

/** An Ample agent credential (preferred: it never expires) or a plain token. */
export function ampleCredentials(env: NodeJS.ProcessEnv): AmpleCredentials | undefined {
  const clientId = env.AMPLE_CLIENT_ID?.trim();
  const clientSecret = env.AMPLE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const token = env.AMPLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

/** Optional pieces must never stop the agent from booting. Log and go on. */
async function safely<T>(log: (m: string) => void, what: string, fn: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log(`${what} unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

export type { RegisteredTool, ComputerBackend };
