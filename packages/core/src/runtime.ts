/**
 * The agent runtime: one Pi Agent per conversation, the policy guard in beforeToolCall,
 * approvals, audit, session persistence, and the fast-ack / deliver-later behaviour the
 * 30 second /chat budget demands.
 *
 * Two keys matter here. The channel's conversation key (`imessage:<id>`) is where replies
 * go. The runtime key is which Agent and transcript handles the message. They are the same
 * for a 1:1 thread; in a group thread every participant gets a runtime key of their own, so a
 * stranger in the group never sees what the owner's turns put in context.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent, type AgentMessage, type AgentTool, type BeforeToolCallResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ApprovalMatch, ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { ContactStore } from "./contacts.js";
import type { MemoryStore } from "./memory.js";
import type { HistoryArchive } from "./history.js"; // [sunshine:history]
import { OwnerNotifier } from "./notifier.js";
import { DEFAULT_TIER_TABLE, SPEND_CAPABILITIES, type PolicyEngine } from "./policy.js";
import { looksLikePhone, normalizePhone, phoneCountryOf, resolvePrincipal } from "./principal.js";
import { saveConfig } from "./config.js";
import { CLAIM_WELCOME_TEXT, MAX_CLAIM_ATTEMPTS, matchClaimCode, ownerClaimStatus } from "./owner-claim.js";
import { readAgentsInstructions, readPersona } from "./persona.js";
import { buildSystemPrompt, SILENT_REPLY, timeStamp, wrapUntrusted } from "./prompt.js";
import { A2AStore, a2aState, a2aTerminal } from "./a2a-state.js";
import type { Scheduler } from "./scheduler.js";
import type { StateDir } from "./state.js";
import type { RegisteredTool, ToolContext, ToolRegistry } from "./tools.js";
import { LOAD_TOOLS, LOADABLE_GROUPS, loadableGroupOf, loadToolsTool, type LoadableGroup } from "./tool-loader.js"; // [sunshine:tool-loader]
import {
  TIER_ORDER,
  type Approval,
  type Capability,
  type Channel,
  type InboundMessage,
  type InstinctConfig,
  type OutboundMessage,
  type Principal,
  type ReplyTarget,
  type ScheduleEntry,
  type Tier,
  type ToolMeta,
} from "./types.js";

export interface Outbox {
  send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void>;
  typing?(conversationKey: string): Promise<void>;
  /** [sunshine:read-receipts] Show the sender "Read" under their message (one-to-one iMessage). */
  markRead?(conversationKey: string): Promise<void>;
}

export interface RuntimeDeps {
  state: StateDir;
  config: InstinctConfig;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditLog;
  scheduler: Scheduler;
  contacts: ContactStore;
  memory: MemoryStore;
  registry: ToolRegistry;
  model: Model<any>;
  outbox: Outbox;
  /**
   * The skills section, or a function that rebuilds it on each prompt for the conversation's
   * principal, so skills installed at runtime appear on the next turn and private skills are
   * listed only to whoever may load them.
   */
  skillsPrompt?: string | ((principal: Principal) => string | undefined);
  streamFn?: StreamFn;
  now?: () => Date;
  replyBudgetMs?: number;
  sessionsDir?: string;
  /** API key lookup handed to Pi; needed for "openai-compatible/..." models. Core never reads env. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Render a structured data part (an OIP message) for the model. Core falls back to fenced JSON. */
  describeData?: (data: Record<string, unknown>) => string | undefined;
  /** Extra system prompt sections per principal and channel, for example the network guidance. */
  promptExtra?: (principal: Principal, channel: Channel) => string[];
  /** "What is set up right now", read fresh for every prompt build. */
  setupSummary?: () => string | undefined;
  a2aStore?: A2AStore;
  loadA2ATask?: (taskId: string) => Promise<unknown>;
  /**
   * [sunshine:watcher] Gates for scheduled jobs that name one (`ScheduleEntry.gate`). A gate is
   * plain code that runs first and says whether the model is needed at all; the news watch does
   * its whole check there and never wakes the agent.
   */
  scheduleGates?: Record<string, (entry: ScheduleEntry) => Promise<boolean>>;
  /**
   * [sunshine:prune] How long the model provider keeps the prompt cache. Old tool results are only
   * removed after it has lapsed. Default PROMPT_CACHE_MS; the server passes one hour when
   * PI_CACHE_RETENTION=long.
   */
  promptCacheMs?: number;
  /**
   * [sunshine:onboarding] How to welcome a new owner (the onboarding skill, without its header). Given
   * with the owner's very first text, once. The model cannot tell a first text from any other ("Hej!"
   * and no history), so it never opened the skill on its own; OpenClaw passes its first-run ritual
   * the same way for the same reason. Unset: no welcome note.
   */
  firstContactGuide?: () => string | undefined;
  /**
   * [sunshine:history] Where the owner's conversations are kept for searching after the live history
   * is trimmed (the owner's own text threads and the dashboard chat). Unset: nothing is kept.
   */
  history?: HistoryArchive;
  /**
   * [sunshine:tool-loader] Set: the owner's conversations get the email, desktop, file and people tools
   * only once a request loads them (`load_tools`, see tool-loader.ts), with each group's guidance
   * (text the server would otherwise put in the prompt) in the result. Ignored when stableCache is off.
   * Unset: every tool is always there.
   */
  toolLoader?: { guidance?: Partial<Record<LoadableGroup, string>> };
}

export interface HandleResult {
  acked: boolean;
  reply?: string;
  principal: Principal;
  conversationKey: string;
  blocked?: string;
}

/** Messages kept verbatim in context; older ones are folded into one summary message. */
export const SESSION_KEEP_MESSAGES = 60;
/** Characters of kept transcript (JSON) before older turns are folded even if the count is under the limit. */
export const SESSION_KEEP_CHARS = 240_000;
/** How many of the newest image-bearing tool results keep their pictures through a fold. */
export const KEEP_RECENT_IMAGES = 2;
/**
 * [sunshine:stable-cache] Folding in steps: nothing changes until the transcript passes the high
 * mark, then it is folded down to the low mark in one go. Between folds the start of the history
 * stays byte-identical, so the prompt cache holds; the sliding fold above changed it every turn.
 * At least 50 messages stay in view (the sliding fold kept about 58); the character cap is the old
 * one, so the context never grows past what it could be before.
 */
export const FOLD_HIGH_MESSAGES = 80;
export const FOLD_LOW_MESSAGES = 50;
export const FOLD_HIGH_CHARS = SESSION_KEEP_CHARS;
export const FOLD_LOW_CHARS = 160_000;
/**
 * [sunshine:prune] Old tool results (an email list, search results) are removed once the turn they
 * served is over, as OpenClaw's session pruning does: measured live (2026-10-15, Gmail and Calendar),
 * tool results were 59% of the owner's history, nearly all of it in results over 2,000 characters.
 * A result before the last turn that is longer than PRUNE_MIN_CHARS (or holds an image) is replaced
 * by PRUNED_RESULT. Conversation text is never touched. It happens only when the start of the prompt
 * is paid in full anyway: after a fold, or once the prompt cache has lapsed (PROMPT_CACHE_MS after the
 * last model call), so it never costs a cache write of its own.
 */
export const PRUNE_MIN_CHARS = 2_000;
/**
 * [sunshine:prune] What a removed result says instead: nothing of the result, like OpenClaw's hard clear
 * and Anthropic's own clearing. Keeping its first 600 characters with "N more characters left out" made
 * the model believe its earlier, correct reply came from a partial view, and it told the owner so ("my
 * first summary went out when I'd only seen part of your inbox"; 2 to 3 of 3 runs, scenarios/prune.mjs).
 */
export const PRUNED_RESULT = "[Removed from the history later, to save space. You had the full result when you used it. Run the tool again if you need the details.]";
/** [sunshine:prune] Anthropic's default prompt cache lifetime (Pi's "short"). */
export const PROMPT_CACHE_MS = 5 * 60 * 1000;
/** [sunshine:delivery-mirror] The same text to the same thread within this window is copied once. */
export const MIRROR_REPEAT_MS = 2 * 60 * 1000;
/** An approved request can be acted on for this long before it lapses. */
export const APPROVAL_USE_WINDOW_MS = 15 * 60 * 1000;
const SEEN_IDS_MAX = 500;
const DEFAULT_REPLY_BUDGET_MS = 20_000;
const TYPING_TIMEOUT_MS = 2_000;
const SEEN_FILE = "seen-ids.json";
const STRANGERS_FILE = "strangers.json";
const CONVERSATIONS_FILE = "conversations.json";
const APPROVED_FILE = "approved.json";
const PENDING_REPLIES_FILE = "pending-replies.json";
const DELIVERABLE: ReadonlySet<Channel> = new Set(["imessage", "sms", "email", "a2a"]);
/** Channels where the sender's identity is bound to the carrier or the process, so an owner reply can settle an approval. */
const APPROVAL_CHANNELS: ReadonlySet<Channel> = new Set(["imessage", "sms", "chat"]);
const CHANNELS: ReadonlySet<string> = new Set(["imessage", "sms", "email", "a2a", "chat", "scheduled", "system"]);
const REPLY_TOOL = "reply_instinct";
const PROCESSING_FILE = "processing-events.json";
const CLAIM_ATTEMPTS_FILE = "owner-claim-attempts.json";
const CARRIER_CHANNELS: ReadonlySet<Channel> = new Set(["imessage", "sms"]);

/** Work may already have caused an external effect; automatic replay is not safe. */
export class InboundUncertainError extends Error {
  constructor(readonly eventId: string, cause?: unknown) {
    super(`Inbound event ${eventId} requires recovery before replay`, { cause });
    this.name = "InboundUncertainError";
  }
}

class A2AInactiveError extends Error {}

type OutboundChannel = OutboundMessage["channel"];
type ReplyRef = Record<string, string | undefined>;

interface StrangerDay {
  conversations: Record<string, number>;
  relays: number;
}

/** What conversations.json remembers per runtime key, so a restart can still resume and deliver. */
interface ConversationRecord {
  principal: Principal;
  deliveryKey: string;
  replyRef?: ReplyRef;
}

/** An approval the owner said yes to, waiting for the exact call to be retried. */
interface ApprovedRecord extends Approval {
  approvedAt: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

interface ConversationOptions {
  key: string;
  deliveryKey: string;
  principal: Principal;
  channel: Channel;
  agent: Agent;
  sessionFile: string;
  replyRef: ReplyRef;
  refreshPrompt: () => string;
  now: () => Date;
  /** [sunshine:stable-cache] Stamp each message with the owner's clock and fold in steps. */
  stableCache?: { timeZone: string };
  /** [sunshine:prune] Remove old tool results once the prompt cache has lapsed for this long; unset is off. */
  pruneAfterMs?: number;
  /** [sunshine:prune] Told how many results were removed and how many characters they held. */
  onPrune?: (pruned: { results: number; chars: number }) => void;
  /** [sunshine:history] Called with the whole history each time it is saved, to keep the conversation. */
  onPersist?: (messages: AgentMessage[]) => void;
  /** [sunshine:tool-loader] Groups loaded on demand: see ToolLoaderHooks. Unset: every tool is always there. */
  toolLoader?: ToolLoaderHooks;
}

/** [sunshine:tool-loader] What a Conversation needs from the runtime to load and drop tool groups. */
interface ToolLoaderHooks {
  /** Prompt cache lifetime: loaded groups are dropped once it has lapsed since the last model call. */
  cacheMs: number;
  /** True for a tool that only comes with a loaded group, for this conversation's principal. */
  loadable(toolName: string): boolean;
  /** The tools this conversation may see now: the base ones plus the loaded groups. */
  rebind(): AgentTool<any>[];
  /** Told which groups were dropped. */
  onUnload?(groups: string[]): void;
}

export class Conversation {
  /** Runtime key: which Agent and transcript. */
  readonly key: string;
  /** Channel key: where replies are delivered. Same as `key` except in shared threads. */
  readonly deliveryKey: string;
  principal: Principal;
  readonly agent: Agent;
  readonly channel: Channel;
  /** Channel ids of the latest inbound message (email Message-ID, A2A task id, ...). */
  replyRef: ReplyRef;
  /** Set when the model answered an A2A task itself during the current run. */
  repliedViaTool = false;
  /** [sunshine:reactions] A tapback declared the whole reply this run, and whether any other tool ran. */
  acknowledged = false;
  usedOtherTool = false;
  /** True while the current run was started by the owner's own direct message (see ToolContext.ownerTurn). */
  ownerTurn = false;
  busy = false;
  /** [sunshine:tool-loader] Groups loaded in this conversation, until the cache goes cold or the history folds. */
  readonly loadedGroups = new Set<LoadableGroup>();
  /** [sunshine:tool-loader] Set by a load during a run: the next model call gets the new tool list. */
  toolsChanged = false;
  /** [sunshine:delivery-mirror] Copies that arrived while a run was going; added when it ends. */
  private pendingNotes: AgentMessage[] = [];
  private readonly sessionFile: string;
  private readonly refreshPrompt: () => string;
  private readonly now: () => Date;
  private readonly stableCache?: { timeZone: string };
  private readonly pruneAfterMs?: number; // [sunshine:prune]
  private readonly onPrune?: (pruned: { results: number; chars: number }) => void; // [sunshine:prune]
  private readonly onPersist?: (messages: AgentMessage[]) => void; // [sunshine:history]
  private readonly toolLoader?: ToolLoaderHooks; // [sunshine:tool-loader]

  constructor(opts: ConversationOptions) {
    this.key = opts.key;
    this.deliveryKey = opts.deliveryKey;
    this.principal = opts.principal;
    this.channel = opts.channel;
    this.agent = opts.agent;
    this.sessionFile = opts.sessionFile;
    this.replyRef = opts.replyRef;
    this.refreshPrompt = opts.refreshPrompt;
    this.now = opts.now;
    this.stableCache = opts.stableCache;
    this.pruneAfterMs = opts.pruneAfterMs; // [sunshine:prune]
    this.onPrune = opts.onPrune; // [sunshine:prune]
    this.onPersist = opts.onPersist; // [sunshine:history]
    this.toolLoader = opts.toolLoader; // [sunshine:tool-loader]
  }

  /** [sunshine:stable-cache] The message as the model sees it: with the time it was sent in front. */
  private stamped(text: string): string {
    return this.stableCache ? `${timeStamp(this.now(), this.stableCache.timeZone)}\n${text}` : text;
  }

  /** Prompt the agent, wait until it is idle, and return the final assistant text. */
  async run(text: string, images?: ImageContent[]): Promise<string> {
    if (this.busy) throw new Error(`Conversation ${this.key} is busy; use steer() or followUp()`);
    this.busy = true;
    this.repliedViaTool = false;
    this.acknowledged = false; // [sunshine:reactions]
    this.usedOtherTool = false;
    try {
      this.applySystemPrompt();
      // The transcript grows between restarts too, so the fold runs before every turn.
      // [sunshine:stable-cache] In steps when on, so the start of the history stays the same.
      const kept = this.agent.state.messages;
      this.agent.state.messages = this.stableCache ? foldInSteps(kept, this.now()) : trimContext(kept, this.now());
      this.pruneIfPaidAnyway(kept); // [sunshine:prune]
      this.unloadIfPaidAnyway(kept); // [sunshine:tool-loader]
      const before = this.agent.state.messages.length;
      await this.agent.prompt(this.stamped(text), images);
      await this.agent.waitForIdle();
      const fresh = this.agent.state.messages.slice(before);
      this.persist();
      const failure = runFailure(fresh);
      if (failure) throw new Error(failure);
      return finalAssistantText(fresh);
    } finally {
      this.busy = false;
      // [sunshine:delivery-mirror] A text sent elsewhere during the run is added once it is over.
      if (this.pendingNotes.length > 0) {
        this.agent.state.messages = [...this.agent.state.messages, ...this.pendingNotes];
        this.pendingNotes = [];
        this.persist();
      }
    }
  }

  /**
   * [sunshine:prune] Remove old tool results, but only when the start of the prompt is paid in full
   * anyway: the fold just changed it, or the cache has lapsed since the last model call. Otherwise
   * the history stays byte-identical and the next call reads it from the cache. The history is saved
   * without them, so later calls start from the same text.
   */
  private pruneIfPaidAnyway(beforeFold: AgentMessage[]): void {
    if (this.pruneAfterMs === undefined) return;
    const messages = this.agent.state.messages;
    const folded = firstTurn(messages) !== firstTurn(beforeFold);
    if (!folded && !cacheLapsed(messages, this.now(), this.pruneAfterMs)) return;
    const pruned = pruneToolResults(messages);
    if (pruned.results === 0) return;
    this.agent.state.messages = pruned.messages;
    this.onPrune?.({ results: pruned.results, chars: pruned.chars });
  }

  /**
   * [sunshine:tool-loader] Drop the loaded groups at the same moments: the start of the prompt is paid
   * in full anyway, so going back to the base list costs nothing, and a group nobody uses stops riding
   * along. Their announcements (system messages after the first) go with them; the calls made with
   * them stay in the history, which Anthropic accepts for tools no longer declared.
   */
  private unloadIfPaidAnyway(beforeFold: AgentMessage[]): void {
    if (!this.toolLoader) return;
    const messages = this.agent.state.messages;
    const announced = messages.some((m, i) => i > 0 && m.role === "system");
    if (this.loadedGroups.size === 0 && !announced) return;
    const folded = firstTurn(messages) !== firstTurn(beforeFold);
    if (!folded && !cacheLapsed(messages, this.now(), this.toolLoader.cacheMs)) return;
    const groups = [...this.loadedGroups];
    this.loadedGroups.clear();
    this.agent.state.messages = messages.filter((m, i) => i === 0 || m.role !== "system");
    this.agent.state.tools = this.toolLoader.rebind();
    if (groups.length > 0) this.toolLoader.onUnload?.(groups);
  }

  /** [sunshine:delivery-mirror] Add messages to the end of this thread's history, now or after the current run. */
  addNote(notes: AgentMessage[]): void {
    if (this.busy) {
      this.pendingNotes.push(...notes);
      return;
    }
    this.agent.state.messages = [...this.agent.state.messages, ...notes];
    this.persist();
  }

  steer(text: string): void {
    this.agent.steer(userMessage(this.stamped(text), this.now())); // [sunshine:stable-cache] stamped
  }

  followUp(text: string): void {
    this.agent.followUp(userMessage(this.stamped(text), this.now())); // [sunshine:stable-cache] stamped
  }

  /** Write the transcript (without system messages, which are rebuilt) as JSON lines. */
  persist(): void {
    writeSession(this.sessionFile, this.agent.state.messages);
    this.onPersist?.(this.agent.state.messages); // [sunshine:history]
  }

  /** The prompt carries the date, memory and pending approvals, so it is rebuilt per run. */
  private applySystemPrompt(): void {
    const prompt = this.refreshPrompt();
    // [sunshine:tool-loader] The opening lists the base tools only, so it stays the same when a group
    // is loaded; Pi announces loaded tools later in the history (system messages after the first),
    // which stay in place. Rebuilt from the full list, every load would rewrite the whole prompt.
    const loader = this.toolLoader;
    const tools = (loader ? this.agent.state.tools.filter((t) => !loader.loadable(t.name)) : this.agent.state.tools).map(toToolDeclaration);
    const system = createInitialSystemMessage(prompt, tools);
    const rest = this.agent.state.messages.filter((m, i) => m.role !== "system" || (loader !== undefined && i > 0));
    this.agent.state.messages = system ? [system, ...rest] : rest;
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface ConversationOpts {
  deliveryKey?: string;
  replyRef?: ReplyRef;
}

export class AgentRuntime {
  private readonly deps: RuntimeDeps;
  private readonly conversations = new Map<string, Conversation>();
  /**
   * The last bubble sent into each carrier thread, stamped with a send sequence number.
   * A counter rather than a clock: "was this delivered after that text arrived" must not
   * depend on two calls landing in different milliseconds.
   */
  private readonly lastDelivered = new Map<string, { text: string; seq: number }>();
  private sendSeq = 0;
  private readonly now: () => Date;
  private readonly sessionsDir: string;
  private readonly notifier: OwnerNotifier;
  private readonly a2aStore: A2AStore;
  private readonly inboundRuns = new Map<string, Promise<HandleResult>>();
  private readonly inboundQueues = new Map<string, Promise<unknown>>();
  private readonly a2aAdmissions = new Map<string, Promise<unknown>>();
  private readonly backgroundReplies = new Set<string>();
  private ownerLast?: { conversationKey: string; channel: Channel };

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.sessionsDir = deps.sessionsDir ?? deps.state.path("sessions");
    deps.state.ensure();
    this.a2aStore = deps.a2aStore ?? new A2AStore(deps.state);
    const savedRoute = deps.state.readJson<{ conversationKey?: unknown; channel?: unknown }>("owner-route.json", {});
    if (typeof savedRoute.conversationKey === "string" && ["imessage", "sms"].includes(String(savedRoute.channel))) {
      this.ownerLast = { conversationKey: savedRoute.conversationKey, channel: savedRoute.channel as Channel };
    }
    this.notifier = new OwnerNotifier({
      state: deps.state,
      audit: deps.audit,
      now: this.now,
      send: (text) => this.sendToOwner(text, this.ownerPrincipal(), "system"),
    });
    // [sunshine:tool-loader] One load_tools for the groups this agent has tools for, in a fixed order.
    if (this.toolLoaderOn) {
      const present = (Object.keys(LOADABLE_GROUPS) as LoadableGroup[]).filter((g) => deps.registry.all().some((t) => loadableGroupOf(t.spec.meta.group) === g));
      if (present.length > 0) deps.registry.register(loadToolsTool(present));
    }
  }

  /** [sunshine:tool-loader] Loading on demand needs the stable cache: without it the prompt changes every run anyway. */
  private get toolLoaderOn(): boolean {
    return this.deps.toolLoader !== undefined && this.deps.config.features?.stableCache !== false;
  }

  /** [sunshine:tool-loader] Only the owner's own conversations load groups; everyone else sees what policy allows, as before. */
  private loadsTools(conv: Conversation): boolean {
    return this.toolLoaderOn && conv.principal.kind === "owner" && conv.principal.tier === "owner" && this.deps.registry.get(LOAD_TOOLS) !== undefined;
  }

  /** [sunshine:tool-loader] A tool that comes only with a loaded group in this conversation. */
  private loadable(conv: Conversation, toolName: string): boolean {
    return this.loadsTools(conv) && loadableGroupOf(this.deps.registry.meta(toolName)?.group) !== undefined;
  }

  /** [sunshine:tool-loader] Adds groups to a conversation; the next model call gets their tools (see createConversation). */
  private loadToolGroups(conv: Conversation, requested: string[]): string {
    const { registry, policy, audit, toolLoader } = this.deps;
    const known = [...new Set(requested)].filter((g): g is LoadableGroup => g in LOADABLE_GROUPS);
    const toolsOf = (g: LoadableGroup) =>
      registry.all().filter((t) => loadableGroupOf(t.spec.meta.group) === g && t.spec.meta.capabilities.every((c) => policy.canEver(conv.principal, c))).map((t) => t.spec.name);
    const added = known.filter((g) => !conv.loadedGroups.has(g) && toolsOf(g).length > 0);
    const lines: string[] = [];
    for (const g of added) {
      conv.loadedGroups.add(g);
      lines.push(`Loaded ${g}, ready from your next step: ${toolsOf(g).join(", ")}.`);
      const guidance = toolLoader?.guidance?.[g]?.trim();
      if (guidance) lines.push(guidance);
    }
    const already = known.filter((g) => !added.includes(g) && conv.loadedGroups.has(g));
    if (already.length > 0) lines.push(`Already loaded: ${already.join(", ")}. Use those tools directly.`);
    const missing = requested.filter((g) => !added.includes(g as LoadableGroup) && !already.includes(g as LoadableGroup));
    if (missing.length > 0) lines.push(`Nothing to load for ${missing.join(", ")} here.`);
    if (added.length > 0) {
      conv.agent.state.tools = this.bindTools(conv);
      conv.toolsChanged = true;
      audit.append({ kind: "policy", conversationKey: conv.key, principal: conv.principal.id, detail: { toolsLoaded: added } });
    }
    return lines.join("\n\n");
  }

  ownerPrincipal(): Principal {
    const owner = this.deps.config.owner;
    return {
      kind: "owner",
      id: "owner",
      tier: "owner",
      displayName: owner.name,
      phone: owner.phones[0],
      email: owner.emails[0],
    };
  }

  stats(): { conversations: number; busy: number } {
    let busy = 0;
    for (const c of this.conversations.values()) if (c.busy) busy++;
    return { conversations: this.conversations.size, busy };
  }

  /**
   * Get or create the conversation for a runtime key. The same person at a changed tier
   * keeps their transcript and gets the tools rebound. A different principal on the same
   * key never inherits the transcript: it gets a fresh conversation with empty context.
   */
  conversation(key: string, principal: Principal, opts: ConversationOpts = {}): Conversation {
    const existing = this.conversations.get(key);
    if (existing) {
      if (existing.principal.id === principal.id) {
        if (existing.principal.tier !== principal.tier || existing.principal.cappedFrom !== principal.cappedFrom) {
          existing.principal = principal;
          existing.agent.state.tools = this.bindTools(existing);
        }
        if (opts.replyRef) existing.replyRef = opts.replyRef;
        this.rememberConversation(existing);
        return existing;
      }
      // The old conversation finishes on its own and is simply no longer the one for this key.
      this.conversations.delete(key);
      this.deps.audit.append({ kind: "policy", conversationKey: key, principal: principal.id, detail: { reset: "principal changed", from: existing.principal.id } });
      return this.createConversation(key, principal, opts, []);
    }
    const sessionFile = join(this.sessionsDir, `${encodeURIComponent(key)}.jsonl`);
    const record = this.recallRecord(key);
    // A transcript on disk belongs to whoever wrote it; someone else starts clean.
    const stored = record && record.principal.id !== principal.id ? [] : readSession(sessionFile);
    return this.createConversation(key, principal, { deliveryKey: opts.deliveryKey ?? record?.deliveryKey, replyRef: opts.replyRef ?? record?.replyRef }, stored);
  }

  private createConversation(key: string, principal: Principal, opts: ConversationOpts, stored: AgentMessage[]): Conversation {
    const channel = channelOf(key);
    const sessionFile = join(this.sessionsDir, `${encodeURIComponent(key)}.jsonl`);
    // [sunshine:stable-cache] On unless config.features.stableCache is false.
    const stable = this.deps.config.features?.stableCache !== false;
    const restored = stable ? foldInSteps(stored, this.now()) : restoreMessages(stored, this.now());

    // The Conversation needs the Agent and the Agent's hooks need the Conversation, so the
    // Agent is created with a placeholder tool list and tools are bound right after.
    let conv!: Conversation;
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: this.deps.model,
        thinkingLevel: this.deps.config.model.thinking ?? "medium",
        tools: [],
        messages: restored,
      },
      streamFn: this.deps.streamFn ?? (streamSimple as StreamFn),
      getApiKey: this.deps.getApiKey,
      toolExecution: "sequential",
      transformContext: async (messages) => (stable ? foldInSteps(messages, this.now(), false) : trimContext(messages, this.now())),
      beforeToolCall: async ({ toolCall, args }) => this.guard(conv, toolCall.name, args),
      afterToolCall: async ({ toolCall, args, isError, result }) => {
        this.recordToolCall(conv, toolCall.name, args, isError, result?.content);
        return undefined;
      },
      // [sunshine:tool-loader] After a load the next model call gets the new list; Pi announces the
      // added tools in a system message there instead of changing the start of the prompt.
      prepareNextTurnWithContext: (turn) => {
        if (!conv.toolsChanged) return undefined;
        conv.toolsChanged = false;
        return { context: { ...turn.context, tools: conv.agent.state.tools.slice() } };
      },
    });
    conv = new Conversation({
      key,
      deliveryKey: opts.deliveryKey ?? key,
      principal,
      channel,
      agent,
      sessionFile,
      replyRef: opts.replyRef ?? {},
      now: this.now,
      refreshPrompt: () => this.systemPromptFor(conv),
      ...(stable ? { stableCache: { timeZone: this.deps.config.owner.timezone || "UTC" } } : {}),
      // [sunshine:prune] On unless config.features.pruneToolResults is false.
      ...(this.deps.config.features?.pruneToolResults !== false
        ? {
            pruneAfterMs: this.deps.promptCacheMs ?? PROMPT_CACHE_MS,
            onPrune: (pruned: { results: number; chars: number }) =>
              this.deps.audit.append({ kind: "policy", conversationKey: key, principal: principal.id, detail: { prunedToolResults: pruned.results, prunedChars: pruned.chars } }),
          }
        : {}),
      // [sunshine:history] The owner's own threads are kept for searching; a failure never fails a save.
      ...(this.deps.history && principal.kind === "owner" && (channel === "imessage" || channel === "sms" || channel === "chat")
        ? {
            onPersist: (messages: AgentMessage[]) => {
              try {
                this.deps.history!.record(key, messages);
              } catch (error) {
                this.deps.audit.append({ kind: "error", conversationKey: key, principal: principal.id, detail: { message: `history not kept: ${errorMessage(error)}` } });
              }
            },
          }
        : {}),
      // [sunshine:tool-loader] With stableCache only: without it the start of the prompt changes every run anyway.
      ...(this.deps.toolLoader && stable
        ? {
            toolLoader: {
              cacheMs: this.deps.promptCacheMs ?? PROMPT_CACHE_MS,
              loadable: (name: string) => this.loadable(conv, name),
              rebind: () => this.bindTools(conv),
              onUnload: (groups: string[]) =>
                this.deps.audit.append({ kind: "policy", conversationKey: key, principal: conv.principal.id, detail: { toolsUnloaded: groups } }),
            },
          }
        : {}),
    });
    agent.state.tools = this.bindTools(conv);
    this.conversations.set(key, conv);
    if (stored.length === 0) writeSession(sessionFile, []);
    this.rememberConversation(conv);
    return conv;
  }

  async handleInbound(incoming: InboundMessage, opts: { waitForCompletion?: boolean } = {}): Promise<HandleResult> {
    let msg = incoming;
    const originalPrincipal = resolvePrincipal(msg, this.deps.config, this.deps.contacts);
    let base = { principal: originalPrincipal, conversationKey: msg.conversationKey, acked: true as const };
    if (this.seenBefore(msg.id)) return { ...base, blocked: "duplicate" };
    if (msg.channel === "a2a" && msg.meta?.eventType === "a2a.task.canceled") {
      this.cancelA2A(msg);
      this.markSeen(msg.id);
      return { ...base, blocked: "canceled" };
    }
    let run = this.inboundRuns.get(msg.id);
    if (!run) {
      // Only a new, not-yet-seen message with a resolved 1:1 scope may claim the owner seat.
      const claimed = this.maybeClaimOwner(msg);
      if (claimed) {
        msg = claimed;
        base = { ...base, principal: resolvePrincipal(msg, this.deps.config, this.deps.contacts) };
      }
      this.markReadOnArrival(msg, base.principal); // [sunshine:read-receipts] after a claim: the new owner gets "Read" too
      run = this.processInbound(msg);
      this.inboundRuns.set(msg.id, run);
      void run.finally(() => this.inboundRuns.delete(msg.id)).catch(() => undefined);
    }
    if (opts.waitForCompletion) return run;
    const outcome = await withinBudget(run.then((result) => ({ result }), (error: unknown) => ({ error })), this.deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS);
    if (outcome.state !== "done") {
      this.backgroundReplies.add(msg.id);
      // A carrier thread gets its texted "on it" from runInbound (ackSlowReplies), on every path.
      return { ...base, reply: ackText(msg.channel) };
    }
    if ("error" in outcome.value) throw outcome.value.error;
    return outcome.value.result;
  }

  /**
   * An agent handed out before its owner's phone was known (config.owner.claimOnFirstContact
   * with no phones) adopts the first person who texts it 1:1 on a carrier channel a message
   * containing the one-time claim code (owner-claim.ts). No valid code configured means no
   * claim at all. Group threads, unresolved scopes, reactions, email and A2A never claim. A
   * wrong code leaves the sender an ordinary stranger and does not use up the claim, but each
   * number gets only MAX_CLAIM_ATTEMPTS tries. On success the phone is written to config.json,
   * the flag and the code are cleared so they cannot be reused, and the returned message has
   * the code stripped so it never reaches the model or the transcript.
   */
  private maybeClaimOwner(msg: InboundMessage): InboundMessage | undefined {
    const { config, state, audit } = this.deps;
    const owner = config.owner;
    if (!owner.claimOnFirstContact || owner.phones.length > 0) return undefined;
    if (msg.channel !== "imessage" && msg.channel !== "sms") return undefined;
    if (msg.meta?.conversationScopeKnown !== true || isGroup(msg)) return undefined;
    if (msg.meta?.reaction !== undefined) return undefined;
    const from = (msg.from ?? "").trim();
    if (!looksLikePhone(from)) return undefined;
    const phone = normalizePhone(from);
    if (!phone) return undefined;
    const status = ownerClaimStatus(config, this.now());
    if (!status.enabled) return undefined;
    const attempts = state.readJson<Record<string, number>>(CLAIM_ATTEMPTS_FILE, {});
    if ((attempts[phone] ?? 0) >= MAX_CLAIM_ATTEMPTS) return undefined;
    const match = matchClaimCode(msg.text, status.code);
    if (!match.matched) {
      attempts[phone] = (attempts[phone] ?? 0) + 1;
      state.writeJson(CLAIM_ATTEMPTS_FILE, attempts);
      if (attempts[phone] === MAX_CLAIM_ATTEMPTS) {
        audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: `stranger:${msg.channel}:${phone}`, detail: { ownerClaimLocked: true, channel: msg.channel, phone } });
      }
      return undefined;
    }
    owner.phones = [phone];
    owner.claimOnFirstContact = false;
    delete owner.claimCode;
    delete owner.claimExpiresAt;
    saveConfig(state, config);
    state.writeJson(CLAIM_ATTEMPTS_FILE, {});
    audit.append({
      kind: "policy",
      conversationKey: msg.conversationKey,
      principal: "owner",
      detail: { ownerClaimed: true, channel: msg.channel, phone },
    });
    return { ...msg, text: match.rest || CLAIM_WELCOME_TEXT };
  }

  private async processInbound(original: InboundMessage): Promise<HandleResult> {
    if (original.meta?.conversationScopeKnown === false) throw new Error("Conversation scope must be resolved before delivery");
    // Taken before any wait: a reply sent after this point was sent after this text arrived.
    const arrivedSeq = this.sendSeq;
    const processing = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
    if (processing.includes(original.id)) throw new InboundUncertainError(original.id);
    const prepared = await this.prepareA2A(original);
    if (!prepared) {
      this.markSeen(original.id);
      return { acked: true, principal: resolvePrincipal(original, this.deps.config, this.deps.contacts), conversationKey: original.conversationKey, blocked: "inactive-task" };
    }
    const { msg, principal, key } = prepared;
    const queueKey = key ?? runtimeKey(msg, principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts));
    // Waiting behind another message in the same conversation: that run already owns the "on it".
    const queued = this.inboundQueues.has(queueKey);
    const before = this.inboundQueues.get(queueKey) ?? Promise.resolve();
    const work = before.catch(() => undefined).then(async () => {
      if (this.seenBefore(original.id)) return { acked: true as const, principal: principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts), conversationKey: msg.conversationKey, blocked: "duplicate" };
      const active = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
      this.deps.state.writeJson(PROCESSING_FILE, [...active, original.id]);
      try {
        const result = await this.runInbound(msg, principal, key, { arrivedSeq, queued });
        if (this.backgroundReplies.delete(original.id) && !DELIVERABLE.has(msg.channel) && result.reply) this.stash(queueKey, result.reply);
        this.markSeen(original.id);
        this.deps.state.writeJson(PROCESSING_FILE, this.deps.state.readJson<string[]>(PROCESSING_FILE, []).filter((id) => id !== original.id));
        return result;
      } catch (error) {
        throw new InboundUncertainError(original.id, error);
      }
    });
    this.inboundQueues.set(queueKey, work);
    void work.finally(() => { if (this.inboundQueues.get(queueKey) === work) this.inboundQueues.delete(queueKey); }).catch(() => undefined);
    return work;
  }

  private async runInbound(msg: InboundMessage, routedPrincipal: Principal | undefined, routedKey: string | undefined, arrival: { arrivedSeq: number; queued: boolean }): Promise<HandleResult> {
    const { audit, approvals, config, contacts, policy } = this.deps;
    const group = isGroup(msg);
    let principal = routedPrincipal ?? resolvePrincipal(msg, config, contacts);
    if (msg.meta?.delegatedResult) {
      // Recheck after the session queue wait: preceding turns may have tightened its audience.
      principal = { ...principal };
      if (principal.contactId) {
        const currentTier = contacts.get(principal.contactId)?.tier ?? "stranger";
        if (TIER_ORDER.indexOf(currentTier) > TIER_ORDER.indexOf(principal.tier)) principal.tier = currentTier;
      }
      const key = routedKey ?? runtimeKey(msg, principal);
      const latestPrincipal = this.conversations.get(key)?.principal ?? this.recallRecord(key)?.principal;
      if (latestPrincipal?.id === principal.id && latestPrincipal.cappedFrom && TIER_ORDER.indexOf(latestPrincipal.tier) > TIER_ORDER.indexOf(principal.tier)) {
        principal.tier = latestPrincipal.tier;
        principal.cappedFrom ??= latestPrincipal.cappedFrom;
      }
    }
    if (group) principal = this.capForGroup(principal, msg);
    const base = { principal, conversationKey: msg.conversationKey };

    audit.append({
      kind: "inbound",
      conversationKey: msg.conversationKey,
      principal: principal.id,
      detail: { id: msg.id, channel: msg.channel, from: msg.from, chars: msg.text.length, source: msg.source, ...(group ? { group: true, tier: principal.tier } : {}) },
    });

    if (principal.kind === "stranger") {
      const limit = this.strangerLimit(msg.conversationKey, policy.toJSON().strangerLimits);
      if (limit) {
        audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: principal.id, detail: { blocked: limit } });
        return { ...base, acked: true, blocked: limit };
      }
    }

    let text = msg.text;
    let approvalNote: string | undefined;
    if (principal.kind === "owner" && !group && !msg.meta?.delegatedResult) {
      if (DELIVERABLE.has(msg.channel) && msg.channel !== "a2a") {
        this.ownerLast = { conversationKey: msg.conversationKey, channel: msg.channel };
        this.deps.state.writeJson("owner-route.json", this.ownerLast);
      }
      // Only a carrier-bound or local channel can settle an approval; an email From is not proof.
      const match = APPROVAL_CHANNELS.has(msg.channel) ? approvals.matchReply(msg.text) : undefined;
      if (match) {
        approvalNote = await this.settleApproval(msg, principal, match);
        if (!match.remainder) return { ...base, acked: true, reply: approvalNote };
        text = match.remainder;
      }
    }

    // Everything the sender controls (text, attachment names, data parts) sits inside the
    // untrusted boundary when the sender is not the owner.
    const body = withData(withAttachments(text, msg), msg, this.deps.describeData);
    const prompt = principal.kind === "owner" && !msg.meta?.delegatedResult ? body : wrapUntrusted(body, untrustedLabel(msg, principal));
    const conv = this.conversation(routedKey ?? runtimeKey(msg, principal), principal, { deliveryKey: msg.conversationKey, replyRef: msg.replyRef });
    if (conv.channel === "a2a" && !this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return { ...base, acked: true, blocked: "inactive-task" };
    this.welcomeIfFirstText(conv, principal, msg, group); // [sunshine:onboarding]
    const stashed = this.takeStash(conv.key);
    const joinReply = (reply: string | undefined) => [approvalNote, ...stashed, reply].filter((t): t is string => Boolean(t)).join("\n\n") || undefined;

    if (conv.busy) {
      conv.steer(prompt);
      return { ...base, acked: true, reply: joinReply(undefined) };
    }

    // Typing is a courtesy, never a cost: it runs alongside the model and is dropped when slow.
    if (DELIVERABLE.has(msg.channel) && this.deps.outbox.typing) {
      // [sunshine:read-receipts] A refusal is logged (one-to-one only: groups never show typing), so the log
      // tells whether the dots reach the phone.
      void withinBudget(this.deps.outbox.typing(msg.conversationKey).catch((error: unknown) => { if (!group) this.courtesyFailed("typing", msg.conversationKey, principal, error); }), TYPING_TIMEOUT_MS);
    }

    const promptedBefore = approvals.promptedToken();
    // Only a run the owner started with their own words may settle an approval through a tool.
    conv.ownerTurn = principal.kind === "owner" && !group && !msg.meta?.delegatedResult && APPROVAL_CHANNELS.has(msg.channel);
    const ack = this.startSlowReplyAck(msg, principal, group || arrival.queued || Boolean(msg.meta?.delegatedResult));
    const run = conv.run(prompt).finally(() => {
      conv.ownerTurn = false;
    }).then(
      (reply) => ({ ok: true as const, reply }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const outcome = await run;
    // The "on it" lands before the answer or not at all.
    await ack.stop();
    const reply = this.replyText(outcome, principal);
    if (!outcome.ok) this.auditError(conv.key, principal, outcome.error);
    if (DELIVERABLE.has(msg.channel) && reply) {
      await this.deliver(conv, reply, { keepPrompt: approvals.promptedToken() !== promptedBefore, arrivedSeq: arrival.arrivedSeq, failure: !outcome.ok });
    }
    return { ...base, acked: true, reply: joinReply(reply) };
  }

  /** Scheduled jobs run as the owner in their own conversation; results go to the owner's phone. */
  async runScheduled(entry: ScheduleEntry): Promise<void> {
    const principal = this.ownerPrincipal();
    const key = `scheduled:${entry.id}`;
    // [sunshine:watcher] A gated job asks its gate first. No gate registered (the feature was
    // switched off) means the job does nothing, rather than reaching the model unprepared.
    if (entry.gate) {
      const gate = this.deps.scheduleGates?.[entry.gate];
      if (!gate) {
        this.deps.audit.append({ kind: "policy", conversationKey: key, principal: principal.id, detail: { gate: entry.gate, skipped: "no such gate registered" } });
        return;
      }
      let wake = false;
      try {
        wake = await gate(entry);
      } catch (error) {
        this.auditError(key, principal, error);
        return;
      }
      if (!wake) return;
    }
    // [sunshine:reminders] A plain reminder goes out as written: no model run, so it costs nothing and
    // still arrives when the model is unreachable (the credits ran out twice in October 2026). The
    // delivery mirror copies it into the owner's thread like any reminder.
    if (entry.text) {
      this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { id: entry.id, name: entry.name, fired: true, plain: true } });
      await this.sendToOwner(entry.text, principal, key);
      return;
    }
    const conv = this.conversation(key, principal);
    this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { id: entry.id, name: entry.name, fired: true } });
    let text = "";
    try {
      text = await conv.run(entry.prompt);
    } catch (error) {
      this.auditError(key, principal, error);
      return;
    }
    if (!text.trim()) return;
    // [sunshine:silent-reply] The job found nothing worth telling the owner.
    if (isSilentReply(text)) {
      this.recordSilentReply(key, principal);
      return;
    }
    // [sunshine:watcher] This job texts only through its tools' fences; its reply is a note for the log.
    if (entry.toolRepliesOnly) {
      this.deps.audit.append({ kind: "policy", conversationKey: key, principal: principal.id, detail: { toolRepliesOnly: "final reply not sent: this job texts only through its tools", chars: text.length, note: text.slice(0, 1000) } });
      return;
    }
    // [sunshine:reply-guard] The job already texted the owner with a tool; send nothing more.
    if (conv.repliedViaTool) {
      this.recordSkippedReply(key, principal, text);
      return;
    }
    await this.sendToOwner(text, principal, key);
  }

  /** [sunshine:reply-guard] Keep a skipped final reply in the audit log, so "what did you do" still sees it. */
  private recordSkippedReply(conversationKey: string, principal: Principal, text: string): void {
    this.deps.audit.append({
      kind: "policy",
      conversationKey,
      principal: principal.id,
      detail: { replyGuard: "final reply not sent: already replied with a tool", chars: text.length, preview: text.slice(0, 160) },
    });
  }

  /** [sunshine:silent-reply] Keep the decision to stay quiet in the audit log. */
  private recordSilentReply(conversationKey: string, principal: Principal): void {
    this.deps.audit.append({ kind: "policy", conversationKey, principal: principal.id, detail: { silentReply: `${SILENT_REPLY}: nothing sent` } });
  }

  /**
   * A task the operator asked for (a `system.task` envelope): runs as the owner in
   * its own conversation. The result goes to the owner's phone unless the task is
   * quiet, in which case only its side effects (memory, schedules) remain. Like a
   * scheduled job, the owner did not write the prompt, so ownerTurn stays false and
   * approval_settle is refused inside it.
   */
  async runSystemTask(task: { id: string; name?: string; prompt: string; quiet?: boolean }): Promise<string> {
    const principal = this.ownerPrincipal();
    const key = `system:${task.id}`;
    const conv = this.conversation(key, principal);
    this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { systemTask: task.id, name: task.name, quiet: task.quiet === true } });
    let text = "";
    try {
      text = await conv.run(task.prompt);
    } catch (error) {
      this.auditError(key, principal, error);
      throw error;
    }
    if (!task.quiet && text.trim()) {
      // [sunshine:silent-reply] [sunshine:reply-guard] As for a scheduled job: the stay-quiet word is
      // never texted, and a task that already texted the owner with a tool sends nothing more.
      if (isSilentReply(text)) this.recordSilentReply(key, principal);
      else if (conv.repliedViaTool) this.recordSkippedReply(key, principal, text);
      else await this.sendToOwner(text, principal, key);
    }
    return text;
  }

  // -------------------------------------------------------------------------
  // Policy guard and audit
  // -------------------------------------------------------------------------

  private async prepareA2A(msg: InboundMessage): Promise<{ msg: InboundMessage; principal?: Principal; key?: string } | undefined> {
    const taskId = msg.channel === "a2a" ? msg.replyRef.taskId : undefined;
    if (!taskId) return this.readA2AAdmission(msg);
    const previous = this.a2aAdmissions.get(taskId) ?? Promise.resolve();
    // Read and record together: an older delayed snapshot must not replace a newer generation.
    const admission = previous.catch(() => undefined).then(() => this.readA2AAdmission(msg));
    this.a2aAdmissions.set(taskId, admission);
    void admission.finally(() => {
      if (this.a2aAdmissions.get(taskId) === admission) this.a2aAdmissions.delete(taskId);
    }).catch(() => undefined);
    return admission;
  }

  private async readA2AAdmission(msg: InboundMessage): Promise<{ msg: InboundMessage; principal?: Principal; key?: string } | undefined> {
    if (msg.channel !== "a2a") return { msg };
    const taskId = msg.replyRef.taskId;
    if (!taskId) return undefined;
    if (msg.meta?.direction === "sent" || msg.meta?.eventType === "a2a.sent_task.updated") {
      const state = a2aState(msg.meta?.state);
      if (state === "submitted" || state === "working") return undefined;
      let route = this.a2aStore.delegation(taskId);
      if (!route && this.a2aStore.hasPending() && this.deps.loadA2ATask) {
        const task = asRecord(await this.deps.loadA2ATask(taskId));
        if (String(task.id ?? "") !== taskId) throw new Error("A2A task response does not match the update");
        const messages = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
        for (const message of messages) {
          const pending = this.a2aStore.byMessage(String(message.message_id ?? message.messageId ?? ""));
          if (!pending || String(asRecord(task.target).handle ?? "") !== pending.peer) continue;
          this.a2aStore.confirm(pending.messageId, { taskId, contextId: String(task.context_id ?? task.contextId ?? "") });
          route = this.a2aStore.delegation(taskId);
          break;
        }
      }
      if (!route) {
        if (this.a2aStore.hasPending()) throw new Error("A2A delegation is still being recorded; retry delivery");
        return undefined;
      }
      const principal = { ...route.principal };
      return {
        msg: { ...msg, channel: channelOf(route.conversationKey), conversationKey: route.deliveryKey, replyRef: route.replyRef ?? {}, text: `Delegated task ${taskId} with @${route.peer} is ${state || "updated"}.\n${msg.text}`, meta: { ...msg.meta, delegatedResult: true } },
        principal,
        key: route.conversationKey,
      };
    }
    let admitted = msg;
    let state = a2aState(msg.meta?.state) || "working";
    if (this.deps.loadA2ATask) {
      const task = asRecord(await this.deps.loadA2ATask(taskId));
      if (String(task.id ?? "") !== taskId || String(task.context_id ?? task.contextId ?? "") !== msg.replyRef.contextId) throw new Error("A2A task response does not match the event");
      state = a2aState(task.state ?? asRecord(task.status).state);
      if (a2aTerminal(state) || !["submitted", "working"].includes(state)) return undefined;
      const history = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
      const latest = history.filter((m) => String(m.role).toLowerCase() === "caller").at(-1);
      if (!latest || String(latest.message_id ?? latest.messageId ?? "") !== msg.replyRef.messageId) return undefined;
      const caller = asRecord(task.caller);
      if (typeof caller.handle !== "string" || !caller.handle) throw new Error("A2A task has no authenticated caller");
      const parts = Array.isArray(latest.parts) ? latest.parts.map(asRecord) : [];
      const text = parts.flatMap((p) => typeof p.text === "string" ? [p.text] : []).join("\n\n");
      const data = parts.find((p) => p.data && typeof p.data === "object")?.data as Record<string, unknown> | undefined;
      const prior = history.slice(0, -1).map((m) => `${String(m.role)}: ${JSON.stringify(m.parts ?? [])}`).join("\n");
      admitted = { ...msg, from: caller.handle, text: prior ? `Earlier messages in this task:\n${clip(prior, 24_000)}\n\nCurrent request:\n${text}` : text, ...(data ? { data } : {}) };
    }
    if (!this.a2aStore.active(taskId)) return undefined;
    const key = runtimeKey(admitted, resolvePrincipal(admitted, this.deps.config, this.deps.contacts));
    this.a2aStore.recordTask({ taskId, contextId: msg.replyRef.contextId, messageId: msg.replyRef.messageId, state, conversationKey: key });
    return { msg: admitted };
  }

  private cancelA2A(msg: InboundMessage): void {
    const taskId = msg.replyRef.taskId;
    if (!taskId) return;
    this.a2aStore.recordTask({ taskId, state: "canceled" });
    for (const conv of this.conversations.values()) {
      if (conv.channel === "a2a" && conv.replyRef.taskId === taskId) conv.agent.abort();
    }
    for (const approval of this.deps.approvals.pending()) {
      if (this.recallRecord(approval.conversationKey)?.replyRef?.taskId === taskId) this.deps.approvals.resolve(approval.token, false);
    }
    const approved = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    this.deps.state.writeJson(APPROVED_FILE, approved.filter((a) => this.recallRecord(a.conversationKey)?.replyRef?.taskId !== taskId));
  }

  private async assertA2AActive(conv: Conversation): Promise<void> {
    const { taskId, messageId } = conv.replyRef;
    if (!taskId || !this.a2aStore.active(taskId, messageId) || a2aState(this.a2aStore.task(taskId)?.state) === "input_required") throw new A2AInactiveError("The A2A task is no longer active");
    if (!this.deps.loadA2ATask) return;
    const task = asRecord(await this.deps.loadA2ATask(taskId));
    const state = a2aState(task.state ?? asRecord(task.status).state);
    const messages = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
    const latest = messages.filter((m) => String(m.role).toLowerCase() === "caller").at(-1);
    if (String(task.id ?? "") !== taskId || !["submitted", "working"].includes(state) || (messageId && String(latest?.message_id ?? latest?.messageId ?? "") !== messageId)) {
      if (a2aTerminal(state)) this.a2aStore.recordTask({ taskId, state });
      throw new A2AInactiveError("The A2A task changed or is no longer active");
    }
  }

  private async guard(conv: Conversation, toolName: string, args: unknown): Promise<BeforeToolCallResult | undefined> {
    if (conv.channel === "a2a") {
      try { await this.assertA2AActive(conv); }
      catch (error) {
        if (!(error instanceof A2AInactiveError)) throw error;
        return { block: true, reason: "This A2A task is no longer active. Stop without taking any action." };
      }
    }
    const { registry, policy, audit, approvals, config } = this.deps;
    const meta = registry.meta(toolName);
    if (!meta) return undefined;
    const principal = conv.principal;

    if (principal.kind === "stranger" && meta.capabilities.includes("owner.relay")) {
      const limit = this.strangerRelayLimit(policy.toJSON().strangerLimits);
      if (limit) return { block: true, reason: limit };
    }

    const decision = policy.evaluate(principal, meta, args);
    audit.append({
      kind: "policy",
      conversationKey: conv.key,
      principal: principal.id,
      detail: { tool: toolName, outcome: decision.outcome, reason: decision.reason, ...(decision.outcome === "allow" && decision.viaGrant ? { viaGrant: decision.viaGrant } : {}) },
    });

    if (decision.outcome === "allow") return undefined;
    if (decision.outcome === "deny") {
      // Enforced twice: the requester hears a polite no, and the owner hears that it was asked.
      if (principal.kind !== "owner") {
        await this.notifier.notify({ conversationKey: conv.key, principal: principal.id, action: safeDescribe(meta, args), outcome: "declined" }, principal.displayName);
      }
      return { block: true, reason: `Blocked by policy: ${decision.reason}. Do not retry. Explain politely that you cannot do this for them.` };
    }

    const amountUsd = meta.amountUsd?.(args);
    const capability = askedCapability(principal, meta);
    const argsHash = hashArgs(args);

    // The owner already said yes to this exact call in this conversation: spend that approval once.
    const consumed = this.consumeApproval({ conversationKey: conv.key, requestedBy: principal.id, capability, toolName, argsHash, amountUsd });
    if (consumed) {
      audit.append({ kind: "policy", conversationKey: conv.key, principal: principal.id, detail: { tool: toolName, outcome: "allow", reason: `owner approved ${consumed.token}: ${consumed.summary}` } });
      return undefined;
    }

    // The same call is already waiting on the owner: do not text them twice.
    const waiting = approvals.findPending({ conversationKey: conv.key, toolName, argsHash });
    const approval =
      waiting ??
      approvals.create({
        conversationKey: conv.key,
        requestedBy: principal.id,
        summary: decision.approvalPrompt,
        capability,
        toolName,
        argsHash,
        ...(amountUsd !== undefined ? { amountUsd } : {}),
      });
    if (!waiting) {
      audit.append({ kind: "approval", conversationKey: conv.key, principal: principal.id, detail: { token: approval.token, status: "pending", summary: approval.summary, tool: toolName } });
      await this.sendToOwner(approvalText(approval, principal, config), this.ownerPrincipal(), conv.key, { approvalToken: approval.token });
    }
    return {
      block: true,
      reason:
        `Waiting for ${config.owner.name}'s approval: ${approval.summary}. ` +
        `Do not call this tool again. Tell the requester you are checking with ${config.owner.name} and end your turn. ` +
        `You will receive a message starting with "Owner approved" or "Owner denied" when they answer.`,
    };
  }

  private recordToolCall(conv: Conversation, toolName: string, args: unknown, isError: boolean, content: unknown): void {
    const { registry, audit } = this.deps;
    const meta = registry.meta(toolName);
    const detail: Record<string, unknown> = { tool: toolName, isError, summary: safeDescribe(meta, args) };
    const preview = contentPreview(content);
    if (preview) detail.result = preview;
    audit.append({ kind: "tool_call", conversationKey: conv.key, principal: conv.principal.id, detail });
    if (toolName === REPLY_TOOL && !isError) conv.repliedViaTool = true;
    // [sunshine:reply-guard] Upstream sets this only for A2A. A text sent with a tool to the run's
    // own audience (this thread, or the owner from a scheduled job) is the reply just the same.
    if (!isError && reachesOwnAudience(conv, safeReplyTarget(meta, args))) conv.repliedViaTool = true;
    // [sunshine:reactions] A lone tapback is the whole reply only if nothing else happened this run.
    // Any other tool call, failed ones included, means there may be something to report in words.
    if (safeReplyTarget(meta, args) === "acknowledge") {
      if (!isError) conv.acknowledged = true;
    } else {
      conv.usedOtherTool = true;
    }
    if (isError || meta?.recordsOwnSpend) return;
    const amountUsd = meta?.amountUsd?.(args);
    const spends = meta?.capabilities.some((c) => SPEND_CAPABILITIES.has(c)) ?? false;
    if ((amountUsd !== undefined && amountUsd > 0) || spends) {
      // Spend entries feed the daily total; a purchase with no amount is still recorded so it is visible.
      audit.append({ kind: "spend", conversationKey: conv.key, principal: conv.principal.id, detail: { tool: toolName, ...(amountUsd !== undefined ? { amountUsd } : {}), summary: safeDescribe(meta, args) } });
    }
  }

  private auditError(conversationKey: string, principal: Principal, error: unknown): void {
    this.deps.audit.append({ kind: "error", conversationKey, principal: principal.id, detail: { message: errorMessage(error) } });
  }

  /**
   * [sunshine:read-receipts] "Read" under their text as soon as it is in, before the typing dots and the
   * answer, as when a person reads it (OpenClaw sends read receipts on iMessage by default). On arrival,
   * so a text that waits behind a reply still being worked on shows "Read" too. One-to-one iMessage from
   * the owner or a contact: groups have no read receipts, and strangers get none.
   */
  private markReadOnArrival(msg: InboundMessage, principal: Principal): void {
    const { config, outbox } = this.deps;
    if (msg.channel !== "imessage" || isGroup(msg) || msg.meta?.delegatedResult || principal.kind === "stranger") return;
    if (config.features?.readReceipts === false || !outbox.markRead) return;
    void outbox.markRead(msg.conversationKey).catch((error: unknown) => this.courtesyFailed("read receipt", msg.conversationKey, principal, error));
  }

  /** [sunshine:read-receipts] Typing dots or a read receipt the channel refused: logged, never retried, never fatal. */
  private courtesyFailed(what: "typing" | "read receipt", conversationKey: string, principal: Principal, error: unknown): void {
    this.deps.audit.append({ kind: "error", conversationKey, principal: principal.id, detail: { courtesy: what, message: errorMessage(error) } });
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  /** Record the owner's verdict, wake the waiting conversation, and return the note for the owner. */
  private async settleApproval(msg: InboundMessage, principal: Principal, match: ApprovalMatch): Promise<string> {
    const { approvals, audit } = this.deps;
    // matchReply already resolves the approval; only resolve here if a custom store left it pending.
    const resolved = match.approval.status === "pending" ? approvals.resolve(match.approval.token, match.approved) ?? match.approval : match.approval;
    const record = this.recallRecord(resolved.conversationKey);
    if (record?.replyRef?.taskId && !this.a2aStore.active(record.replyRef.taskId, record.replyRef.messageId)) return "That task is no longer active; no action was taken.";
    const verb = match.approved ? "approved" : "denied";
    audit.append({ kind: "approval", conversationKey: resolved.conversationKey, principal: principal.id, detail: { token: resolved.token, status: resolved.status, summary: resolved.summary } });

    const note = `${match.approved ? "Approved" : "Denied"}: ${resolved.summary}`;
    await this.afterApproval(resolved, match.approved);

    if (DELIVERABLE.has(msg.channel)) {
      await this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: msg.conversationKey, text: note, replyRef: msg.replyRef }, principal, msg.conversationKey);
    }
    return note;
  }

  /**
   * What happens once an approval is settled, whether by a yes/no text or by the
   * approval_settle tool: remember a policy grant, then wake the conversation that
   * asked. A relay approval (ask_owner) informs the model through the follow-up only;
   * it never pre-authorises a policy ask.
   */
  async afterApproval(approval: Approval, approved: boolean): Promise<void> {
    if (approved && approval.capability !== "owner.relay") this.rememberApproved(approval);
    await this.resumeConversation(approval.conversationKey, `Owner ${approved ? "approved" : "denied"}: ${approval.summary}`);
  }

  /** Wake the conversation that was waiting on the owner. Busy: queue. Idle: run and deliver. */
  private async resumeConversation(key: string, text: string): Promise<void> {
    const live = this.conversations.get(key);
    const record = live ? { principal: live.principal, deliveryKey: live.deliveryKey, replyRef: live.replyRef } : this.recallRecord(key);
    if (!record) return;
    const conv = this.conversation(key, record.principal, { deliveryKey: record.deliveryKey, replyRef: record.replyRef });
    if (conv.channel === "a2a") {
      try { await this.assertA2AActive(conv); } catch (error) { if (error instanceof A2AInactiveError) return; throw error; }
    }
    if (conv.busy) {
      // The current run owns this transcript until it has persisted and delivered.
      const running = this.inboundQueues.get(key);
      if (running) await running;
      else await conv.agent.waitForIdle();
    }
    const reply = await conv.run(text);
    if (reply) await this.deliver(conv, reply);
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Send the model's reply where the conversation lives. Dashboard chat has no outbox, so
   * its text is stashed for the next turn. A2A replies carry the task id and say "progress"
   * while an approval is pending, and are skipped when the model already answered itself.
   */
  private async deliver(conv: Conversation, text: string, opts: { keepPrompt?: boolean; arrivedSeq?: number; failure?: boolean } = {}): Promise<void> {
    const channel = conv.channel;
    if (channel === "scheduled" || channel === "system") return;
    if (!DELIVERABLE.has(channel)) {
      this.stash(conv.key, text);
      return;
    }
    // [sunshine:silent-reply] The word is never texted to anyone, as in OpenClaw. A2A still owes a result.
    if (channel !== "a2a" && isSilentReply(text)) {
      this.recordSilentReply(conv.key, conv.principal);
      return;
    }
    // [sunshine:reactions] A tapback was the whole reply and nothing else happened: text after it
    // ("I've already reacted…") would only be noise.
    if (conv.acknowledged && !conv.usedOtherTool && channel !== "a2a") {
      this.recordSkippedReply(conv.key, conv.principal, text);
      return;
    }
    // [sunshine:reply-guard] The model already answered in this thread with a tool; its final text
    // would arrive as a second message (often a copy, or a note like "I sent Torstein ...").
    if (conv.repliedViaTool && channel !== "a2a") {
      this.recordSkippedReply(conv.key, conv.principal, text);
      return;
    }
    const out: OutboundMessage = { channel: channel as OutboundChannel, conversationKey: conv.deliveryKey, text, replyRef: conv.replyRef };
    if (channel === "a2a") {
      if (conv.repliedViaTool) return;
      if (!this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return;
      try { await this.assertA2AActive(conv); } catch (error) { if (error instanceof A2AInactiveError) return; throw error; }
      const taskId = conv.replyRef.taskId;
      if (!taskId) {
        this.deps.audit.append({ kind: "error", conversationKey: conv.key, principal: conv.principal.id, detail: { message: "A2A reply dropped: no task id on record" } });
        return;
      }
      const waiting = this.deps.approvals.pending().some((a) => a.conversationKey === conv.key);
      out.a2a = { taskId, intent: waiting ? "progress" : "complete" };
    }
    if (this.duplicateOfQueuedReply(conv, text, opts)) {
      this.deps.audit.append({ kind: "outbound", conversationKey: conv.key, principal: conv.principal.id, detail: { channel, skipped: "duplicate reply", chars: text.length } });
      return;
    }
    // A reply to the owner changes what their next bare "yes" is about, unless this run raised the question.
    if (conv.principal.kind === "owner" && !opts.keepPrompt) this.deps.approvals.clearPrompted();
    await this.safeSend(out, conv.principal, conv.key);
    if (out.a2a && out.a2a.intent === "complete") this.a2aStore.recordTask({ taskId: out.a2a.taskId, state: "completed" });
  }

  /**
   * Several texts sent while one answer was being written are each run in turn, and the
   * later runs often end on that same answer. Only that echo is dropped: the reply repeats
   * the last bubble in the thread word for word, and the text that produced it arrived
   * before that bubble went out. A later request that happens to get the same answer
   * ("Done.") is news, a failure line is always worth repeating, and a shared thread is
   * never deduplicated because the same words may be for a different person.
   */
  private duplicateOfQueuedReply(conv: Conversation, text: string, opts: { arrivedSeq?: number; failure?: boolean }): boolean {
    if (!CARRIER_CHANNELS.has(conv.channel) || opts.failure || opts.arrivedSeq === undefined) return false;
    if (conv.key !== conv.deliveryKey) return false;
    const last = this.lastDelivered.get(conv.deliveryKey);
    return last !== undefined && last.text === text && last.seq > opts.arrivedSeq;
  }

  /**
   * With features.ackSlowReplies, an owner's own 1:1 text that is still running after the
   * reply budget gets one "on it" bubble. Never for a queued or steered text (the run in
   * front owns the thread), a group, or a run that already put something in the thread.
   * stop() cancels a pending ack and waits for one already sending, so it lands first.
   */
  private startSlowReplyAck(msg: InboundMessage, principal: Principal, skip: boolean): { stop: () => Promise<void> } {
    const eligible = this.deps.config.features.ackSlowReplies === true && CARRIER_CHANNELS.has(msg.channel) && principal.kind === "owner" && !skip;
    if (!eligible) return { stop: async () => undefined };
    const thread = msg.conversationKey;
    const startSeq = this.sendSeq;
    let sending: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      if ((this.lastDelivered.get(thread)?.seq ?? -1) > startSeq) return;
      sending = this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: thread, text: ackText(msg.channel), replyRef: msg.replyRef }, principal, thread).catch(() => undefined);
    }, this.deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS);
    return {
      stop: async () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (sending) await sending;
      },
    };
  }

  /**
   * For the server's own owner-facing texts (a finished phone call, for example): the same
   * route as the runtime's messages. False when there is no way to reach the owner.
   */
  async relayToOwner(text: string, originKey: string, opts: { approvalToken?: string } = {}): Promise<boolean> {
    const last = this.ownerLast;
    const reachable = Boolean(this.deps.config.owner.phones[0]) || Boolean(last && DELIVERABLE.has(last.channel) && last.channel !== "a2a");
    if (!reachable) return false;
    await this.sendToOwner(text, this.ownerPrincipal(), originKey, opts);
    return true;
  }

  /**
   * Owner messages go to the owner's last live text thread, else to their first phone by
   * iMessage, else to their last email thread. Group threads are never used for this.
   */
  private async sendToOwner(text: string, principal: Principal, originKey: string, opts: { approvalToken?: string } = {}): Promise<void> {
    const last = this.ownerLast;
    const phone = this.deps.config.owner.phones[0];
    let out: OutboundMessage;
    if (last && (last.channel === "imessage" || last.channel === "sms")) {
      out = { channel: last.channel, conversationKey: last.conversationKey, text };
    } else if (phone) {
      out = { channel: "imessage", to: phone, text };
    } else if (last && DELIVERABLE.has(last.channel) && last.channel !== "a2a") {
      out = { channel: last.channel as OutboundChannel, conversationKey: last.conversationKey, text };
    } else {
      this.deps.audit.append({ kind: "error", conversationKey: originKey, principal: principal.id, detail: { message: "No way to reach the owner: no phone and no prior conversation" } });
      return;
    }
    const sent = await this.safeSend(out, principal, originKey);
    if (!sent) return;
    if (opts.approvalToken) this.deps.approvals.markPrompted(opts.approvalToken);
    else this.deps.approvals.clearPrompted();
  }

  private async safeSend(out: OutboundMessage, principal: Principal, conversationKey: string): Promise<boolean> {
    try {
      await this.deps.outbox.send(out, { principal, conversationKey });
      // Recorded only once the carrier took it: a failed send must not suppress the retry.
      if (CARRIER_CHANNELS.has(out.channel) && out.conversationKey) this.lastDelivered.set(out.conversationKey, { text: out.text, seq: ++this.sendSeq });
      this.deps.audit.append({ kind: "outbound", conversationKey, principal: principal.id, detail: { channel: out.channel, to: out.to, conversationKey: out.conversationKey, chars: out.text.length } });
      return true;
    } catch (error) {
      this.auditError(conversationKey, principal, error);
      throw error;
    }
  }

  /**
   * [sunshine:onboarding] On the owner's very first text (their own text thread, nothing in it yet, no
   * facts in memory), a note with the welcome guide goes in front of it, in the delivery mirror's form
   * ("[Not a message from …]"), so the thread readers (news writer, memory notes) know it is not the
   * owner's words. Once: afterwards the thread is not empty. The guide decides what the welcome says.
   */
  private welcomeIfFirstText(conv: Conversation, principal: Principal, msg: InboundMessage, group: boolean): void {
    if (principal.kind !== "owner" || group || msg.meta?.delegatedResult || conv.busy) return;
    if (msg.channel !== "imessage" && msg.channel !== "sms") return;
    if (conv.agent.state.messages.some((m) => m.role !== "system")) return;
    if (/^\s*[-*]\s+\S/m.test(this.deps.memory.readDurable())) return;
    const guide = this.deps.firstContactGuide?.()?.trim();
    if (!guide) return;
    const owner = this.deps.config.owner;
    const now = this.now();
    conv.addNote([
      userMessage(`${timeStamp(now, owner.timezone || "UTC")}\n[Not a message from ${owner.name}: they signed up a moment ago, and the next message is their first text to you. How to welcome them:]\n\n${guide}`, now),
    ]);
    this.deps.audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: principal.id, detail: { firstContact: true } });
  }

  /**
   * [sunshine:delivery-mirror] A text that reached the owner's own thread from somewhere else (a
   * reminder, the news watch, a relay, an approval question) is copied into that thread's history
   * as Sunshine's own message, so a reply to it ("thanks for the reminder", "what's Sanna?") has
   * context. As OpenClaw's delivery mirror: called by the channel only after a successful send,
   * written as an assistant message, once (the same text to the same thread within
   * MIRROR_REPEAT_MS is skipped), and never fatal. Off with config.features.deliveryMirror = false.
   * A short note with the time and the source goes in front: tested, a bare copy made the model
   * disown the news text as something it never looked up ("I shouldn't have sent it").
   */
  mirrorToOwner(msg: OutboundMessage, origin: { conversationKey: string }): void {
    try {
      if (this.deps.config.features?.deliveryMirror === false) return;
      const route = this.ownerLast;
      if (!route || route.conversationKey === origin.conversationKey) return; // said in the thread itself: already there
      const text = msg.text?.trim();
      if (!text) return;
      const reachedOwner = msg.conversationKey ? msg.conversationKey === route.conversationKey : msg.channel === route.channel && this.isOwnerPhone(msg.to);
      if (!reachedOwner) return;
      const now = this.now().getTime();
      const key = `${route.conversationKey}\n${text}`;
      const seen = this.mirrored.get(key);
      if (seen !== undefined && now - seen < MIRROR_REPEAT_MS) return;
      this.mirrored.set(key, now);
      if (this.mirrored.size > 200) this.mirrored.delete(this.mirrored.keys().next().value!);
      const owner = this.deps.config.owner;
      const stamp = timeStamp(new Date(now), owner.timezone || "UTC");
      const notes = [
        userMessage(`${stamp}\n[Not a message from ${owner.name}: a note that you texted them the next message ${this.mirrorSource(origin.conversationKey)}. No reply is needed to it.]`, new Date(now)),
        mirroredMessage(text, this.deps.model, now),
      ];
      const live = this.conversations.get(route.conversationKey);
      if (live) {
        live.addNote(notes);
      } else {
        const file = join(this.sessionsDir, `${encodeURIComponent(route.conversationKey)}.jsonl`);
        writeSession(file, [...readSession(file), ...notes]);
      }
    } catch (error) {
      // Bookkeeping after a send that already succeeded: log it, never fail or repeat the send.
      this.deps.audit.append({ kind: "error", conversationKey: origin.conversationKey, principal: "system", detail: { message: `delivery mirror failed: ${errorMessage(error)}` } });
    }
  }

  private readonly mirrored = new Map<string, number>(); // [sunshine:delivery-mirror] recent copies, for once-only

  /**
   * [sunshine:delivery-mirror] How a copied text came about, in words the model can repeat to the
   * owner: no machinery ("news watch", "scheduled job"), since it speaks of these as itself.
   */
  private mirrorSource(originKey: string): string {
    if (originKey === "scheduled:watcher") return "on your own, after reading the news for them";
    if (originKey.startsWith("scheduled:")) {
      const entry = this.deps.scheduler.list().find((e) => `scheduled:${e.id}` === originKey);
      return entry?.name ? `when "${entry.name}", which they set up with you, came due` : "when something they set up with you came due";
    }
    const who = this.recallRecord(originKey)?.principal.displayName;
    return who ? `from your conversation with ${who}` : "from another conversation";
  }

  private isOwnerPhone(to: string | string[] | undefined): boolean {
    if (typeof to !== "string") return false;
    const phone = normalizePhone(to);
    return this.deps.config.owner.phones.some((p) => normalizePhone(p) === phone);
  }

  private replyText(value: { ok: true; reply: string } | { ok: false; error: unknown }, principal: Principal): string {
    if (value.ok) return value.reply;
    // The full detail is in the audit log (auditError); the owner gets a short human reason, never a JSON body.
    if (principal.kind === "owner") {
      const reason = shortReason(errorMessage(value.error));
      return `Hit a snag on my end${reason ? ` (${reason})` : ""}. Give me a minute and try that again.`;
    }
    return "Sorry, I hit a problem. Please try again later.";
  }

  // -------------------------------------------------------------------------
  // Prompt and tools
  // -------------------------------------------------------------------------

  private systemPromptFor(conv: Conversation): string {
    const { config, state, memory, approvals, skillsPrompt, policy } = this.deps;
    const principal = conv.principal;
    // [sunshine:tool-loader] From every tool they may use, loaded or not, so a load never changes the prompt.
    const tools = this.loadsTools(conv)
      ? this.deps.registry.all().filter((t) => t.spec.meta.capabilities.every((c) => policy.canEver(principal, c))).map((t) => t.spec)
      : conv.agent.state.tools;
    const groups = new Set<string>();
    const capabilities = new Set<Capability>();
    for (const t of tools) {
      const meta = this.deps.registry.meta(t.name);
      if (!meta) continue;
      groups.add(meta.group);
      for (const c of meta.capabilities) if (policy.canEver(principal, c)) capabilities.add(c);
    }
    const pending = approvals.pending().filter((a) => (principal.kind === "owner" && principal.tier === "owner") || a.conversationKey === conv.key);
    const extra = this.deps.promptExtra?.(principal, conv.channel) ?? [];
    return buildSystemPrompt({
      config,
      principal,
      channel: conv.channel,
      now: this.now(),
      capabilities: [...capabilities],
      toolGroups: [...groups],
      memoryDigest: this.memoryDigestFor(principal),
      // Read fresh each time so `instinct persona set` applies on the next message.
      persona: readPersona(state),
      instructions: readAgentsInstructions(state),
      skillsPrompt: typeof skillsPrompt === "function" ? skillsPrompt(principal) : skillsPrompt,
      pendingApprovals: pending,
      setup: this.deps.setupSummary?.(),
      extra,
    });
  }

  /**
   * Memory is the owner's private notebook. The owner in their own thread gets the whole
   * digest. Anyone whose tier may know the owner's preferences gets the Preferences section
   * only, and nobody else gets anything.
   */
  private memoryDigestFor(principal: Principal): string {
    const { memory, policy } = this.deps;
    if (principal.kind === "owner" && principal.tier === "owner") return memory.digest(4000, this.now());
    const permission = policy.permissionFor(principal.tier, "owner.profile.preferences");
    if (permission !== "yes" && permission !== "partial") return "";
    const prefs = memory.preferencesDigest(permission === "yes" ? 1500 : 600);
    if (!prefs) return "";
    const scope = permission === "yes" ? "They may know most of these." : "Share only general, harmless preferences from this list; keep anything personal, medical or financial to yourself.";
    return `## ${this.deps.config.owner.name}'s preferences (tier ${principal.tier})\n${scope}\n${prefs}`;
  }

  private bindTools(conv: Conversation): AgentTool<any>[] {
    const { registry, policy } = this.deps;
    const ctx: ToolContext = {
      get principal() {
        return conv.principal;
      },
      conversationKey: conv.key,
      get deliveryKey() { return conv.deliveryKey; },
      get replyRef() { return conv.replyRef; },
      assertA2AActive: () => this.assertA2AActive(conv),
      markA2AState: (state) => {
        if (conv.replyRef.taskId) this.a2aStore.recordTask({ taskId: conv.replyRef.taskId, state });
      },
      channel: conv.channel,
      get ownerTurn() { return conv.ownerTurn; },
      now: this.now,
    };
    const visible = (t: RegisteredTool) => t.spec.meta.capabilities.every((c) => policy.canEver(conv.principal, c));
    // [sunshine:tool-loader] The owner's conversations see load_tools and the base tools, plus the
    // groups loaded so far; everyone else sees what policy allows, as before.
    if (!this.loadsTools(conv)) return registry.bind(ctx, (t) => visible(t) && t.spec.name !== LOAD_TOOLS);
    ctx.loadTools = (groups) => this.loadToolGroups(conv, groups);
    return registry.bind(ctx, (t) => {
      if (!visible(t)) return false;
      const group = loadableGroupOf(t.spec.meta.group);
      return group === undefined || conv.loadedGroups.has(group);
    });
  }

  /**
   * In a group thread every reply is visible to everyone, so the owner acts at the lowest
   * tier present. Unknown participants are strangers; an unknown member list caps to stranger.
   */
  private capForGroup(sender: Principal, msg: InboundMessage): Principal {
    const country = phoneCountryOf(this.deps.config); // [sunshine:phone]
    const ownerPhones = new Set(this.deps.config.owner.phones.map((p) => normalizePhone(p, country)));
    const participants = Array.isArray(msg.meta?.participants) ? (msg.meta!.participants as unknown[]).filter((p): p is string => typeof p === "string") : [];
    let lowest: Tier = sender.tier;
    let others = 0;
    for (const raw of participants) {
      const phone = normalizePhone(raw, country);
      if (!phone || ownerPhones.has(phone)) continue;
      others++;
      const tier = this.deps.contacts.findByPhone(phone)?.tier ?? "stranger";
      if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(lowest)) lowest = tier;
    }
    if (others === 0) lowest = "stranger";
    return { ...sender, tier: lowest, cappedFrom: sender.tier };
  }

  // -------------------------------------------------------------------------
  // Small persisted bookkeeping
  // -------------------------------------------------------------------------

  private seenBefore(id: string): boolean {
    const seen = this.deps.state.readJson<string[]>(SEEN_FILE, []);
    return seen.includes(id);
  }

  private markSeen(id: string): void {
    const seen = this.deps.state.readJson<string[]>(SEEN_FILE, []);
    if (seen.includes(id)) return;
    seen.push(id);
    this.deps.state.writeJson(SEEN_FILE, seen.slice(-SEEN_IDS_MAX));
  }

  private rememberConversation(conv: Conversation): void {
    const map = this.deps.state.readJson<Record<string, unknown>>(CONVERSATIONS_FILE, {});
    const record: ConversationRecord = { principal: conv.principal, deliveryKey: conv.deliveryKey, replyRef: conv.replyRef };
    map[conv.key] = record;
    this.deps.state.writeJson(CONVERSATIONS_FILE, map);
  }

  private recallRecord(key: string): ConversationRecord | undefined {
    const raw = this.deps.state.readJson<Record<string, unknown>>(CONVERSATIONS_FILE, {})[key];
    if (!raw || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    // Older files stored the bare Principal.
    if (typeof o.kind === "string" && typeof o.id === "string") return { principal: o as unknown as Principal, deliveryKey: key };
    if (!o.principal || typeof o.principal !== "object") return undefined;
    return {
      principal: o.principal as Principal,
      deliveryKey: typeof o.deliveryKey === "string" ? o.deliveryKey : key,
      ...(o.replyRef && typeof o.replyRef === "object" ? { replyRef: o.replyRef as ReplyRef } : {}),
    };
  }

  private rememberApproved(approval: Approval): void {
    const list = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    list.push({ ...approval, status: "approved", approvedAt: this.now().toISOString() });
    this.deps.state.writeJson(APPROVED_FILE, list);
  }

  /**
   * Find and remove one approved request that covers this exact call: same conversation,
   * same requester, same capability, same tool and the same arguments, approved within
   * APPROVAL_USE_WINDOW_MS. Amounts may not exceed what was approved by more than 5%.
   * Stale entries are swept on every call.
   */
  private consumeApproval(call: { conversationKey: string; requestedBy: string; capability: Capability; toolName: string; argsHash: string; amountUsd: number | undefined }): Approval | undefined {
    const nowMs = this.now().getTime();
    const list = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    const fresh = list.filter((a) => Date.parse(a.approvedAt ?? a.createdAt) + APPROVAL_USE_WINDOW_MS > nowMs);
    const index = fresh.findIndex(
      (a) =>
        a.conversationKey === call.conversationKey &&
        a.requestedBy === call.requestedBy &&
        a.capability === call.capability &&
        a.toolName === call.toolName &&
        a.argsHash === call.argsHash &&
        (call.amountUsd === undefined ? a.amountUsd === undefined : a.amountUsd !== undefined && call.amountUsd <= a.amountUsd * 1.05),
    );
    const match = index >= 0 ? fresh[index] : undefined;
    if (match) fresh.splice(index, 1);
    if (match || fresh.length !== list.length) this.deps.state.writeJson(APPROVED_FILE, fresh);
    return match;
  }

  /** Replies that could not be delivered (dashboard chat) wait here for the next turn on that key. */
  private stash(key: string, text: string): void {
    const all = this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {});
    (all[key] ??= []).push(text);
    this.deps.state.writeJson(PENDING_REPLIES_FILE, all);
  }

  private takeStash(key: string): string[] {
    const all = this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {});
    const texts = all[key];
    if (!texts || texts.length === 0) return [];
    delete all[key];
    this.deps.state.writeJson(PENDING_REPLIES_FILE, all);
    return texts;
  }

  /** Replies waiting for the next turn on a key, without taking them. */
  pendingReplies(key: string): string[] {
    return this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {})[key] ?? [];
  }

  private strangerDay(): { day: string; record: StrangerDay; save: () => void } {
    const day = localDay(this.now(), this.deps.config.owner.timezone);
    const all = this.deps.state.readJson<Record<string, StrangerDay>>(STRANGERS_FILE, {});
    const record = all[day] ?? { conversations: {}, relays: 0 };
    return {
      day,
      record,
      save: () => this.deps.state.writeJson(STRANGERS_FILE, { [day]: record }),
    };
  }

  private strangerLimit(conversationKey: string, limits: { conversationsPerDay: number; messagesPerConversation: number }): string | undefined {
    const { record, save } = this.strangerDay();
    const count = record.conversations[conversationKey] ?? 0;
    if (count === 0 && Object.keys(record.conversations).length >= limits.conversationsPerDay) {
      return `stranger limit: ${limits.conversationsPerDay} new conversations per day`;
    }
    if (count >= limits.messagesPerConversation) {
      return `stranger limit: ${limits.messagesPerConversation} messages per conversation`;
    }
    record.conversations[conversationKey] = count + 1;
    save();
    return undefined;
  }

  private strangerRelayLimit(limits: { conversationsPerDay: number }): string | undefined {
    const { record, save } = this.strangerDay();
    if (record.relays >= limits.conversationsPerDay) {
      return `Blocked: strangers may leave at most ${limits.conversationsPerDay} messages for the owner per day.`;
    }
    record.relays += 1;
    save();
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export function readSession(file: string): AgentMessage[] {
  if (!existsSync(file)) return [];
  const out: AgentMessage[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentMessage;
      if (parsed && typeof parsed === "object" && "role" in parsed) out.push(parsed);
    } catch {
      // A torn write leaves a partial last line; skipping it is the right recovery.
    }
  }
  return out;
}

export function writeSession(file: string, messages: AgentMessage[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m));
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
}

/**
 * Rebuild a context from stored messages: drop system messages (rebuilt per run), drop a
 * trailing tool call that never got its result, keep the last SESSION_KEEP_MESSAGES (and
 * no more than SESSION_KEEP_CHARS of JSON) and fold everything older into one plain-text
 * summary message. Idempotent on an already folded transcript.
 */
export function restoreMessages(stored: AgentMessage[], now: Date, keep = SESSION_KEEP_MESSAGES, maxChars = SESSION_KEEP_CHARS, keepImages = KEEP_RECENT_IMAGES): AgentMessage[] {
  const messages = dropOldImages(dropOrphanToolCalls(stored.filter((m) => m.role !== "system")), keepImages);
  let start = messages.length <= keep ? 0 : nextUserTurn(messages, messages.length - keep);
  // Large tool results can blow the context long before the message count does. The slice
  // only ever moves to a user or assistant turn; when none is left it stays where it is,
  // even above budget, because a slice that starts at a tool result is rejected outright.
  while (start < messages.length - 1 && charSize(messages.slice(start)) > maxChars) {
    const next = nextUserTurn(messages, start + 1);
    if (next >= messages.length || next === start) break;
    start = next;
  }
  if (start <= 0) return messages;

  const older = messages.slice(0, start);
  const summary: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: summarizeMessages(older) }],
    timestamp: now.getTime(),
  };
  return [summary, ...messages.slice(start)];
}

/**
 * The live context before a model call: the system message stays, the rest is folded like
 * a restore. The fold leaves room for the turn about to be added, so the transcript never
 * sits above SESSION_KEEP_MESSAGES + 2 (system message and summary) between turns.
 */
export function trimContext(messages: AgentMessage[], now: Date): AgentMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = restoreMessages(messages, now, SESSION_KEEP_MESSAGES - 2);
  return system.length ? [...system, ...rest] : rest;
}

/**
 * [sunshine:stable-cache] The context before a model call, folded in steps: unchanged (apart from
 * dropping a tool call that never got its result) until it passes a high mark, then folded down to
 * the low marks in one go. Used instead of trimContext and restoreMessages when stableCache is on.
 * Between the model calls of one run only size counts (`byCount` false): a count fold there would
 * be redone differently when the next run folds the stored transcript, costing a second uncached call.
 */
export function foldInSteps(messages: AgentMessage[], now: Date, byCount = true): AgentMessage[] {
  // [sunshine:tool-loader] Only the opening system message goes first. Later ones (Pi's announcements of
  // loaded tools) stay where they are: moved to the front they would change the start of every request.
  const lead = messages[0]?.role === "system" ? [messages[0]] : [];
  const body = dropOrphanToolCalls(messages.slice(lead.length));
  const rest = body.filter((m) => m.role !== "system");
  if ((!byCount || rest.length <= FOLD_HIGH_MESSAGES) && charSize(rest) <= FOLD_HIGH_CHARS) return [...lead, ...body];
  return [...lead, ...keepAnnouncements(body, restoreMessages(rest, now, FOLD_LOW_MESSAGES, FOLD_LOW_CHARS))];
}

/**
 * [sunshine:tool-loader] Put the later system messages back into a folded history: in place where what
 * follows them was kept, right after the summary where it was folded away. A fold in the middle of a run
 * (on size, with screenshots) must not take the loaded tools away from the steps still to come.
 */
function keepAnnouncements(body: AgentMessage[], folded: AgentMessage[]): AgentMessage[] {
  if (!body.some((m) => m.role === "system")) return folded;
  const kept = new Set(folded);
  const firstKept = body.findIndex((m) => m.role !== "system" && kept.has(m));
  if (firstKept < 0) return [...folded.slice(0, 1), ...body.filter((m) => m.role === "system"), ...folded.slice(1)];
  const summary = folded.slice(0, folded.indexOf(body[firstKept]!));
  return [...summary, ...body.slice(0, firstKept).filter((m) => m.role === "system"), ...body.slice(firstKept)];
}

/** [sunshine:prune] The first message after the system message: a fold puts a new summary there. */
function firstTurn(messages: AgentMessage[]): AgentMessage | undefined {
  return messages.find((m) => m.role !== "system");
}

/** [sunshine:prune] A reply that came from the model. A copied text (the delivery mirror) used no tokens. */
function isModelReply(m: AgentMessage): boolean {
  if (m.role !== "assistant") return false;
  const u = m.usage;
  return Boolean(u) && u.input + u.output + u.cacheRead + u.cacheWrite > 0;
}

/** [sunshine:prune] True when the last model call is at least `cacheMs` ago, or there was none. */
export function cacheLapsed(messages: AgentMessage[], now: Date, cacheMs: number): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isModelReply(m)) return now.getTime() - m.timestamp >= cacheMs;
  }
  return true;
}

/**
 * [sunshine:prune] Where the last turn starts: the message that began the last model run. Results
 * from there on stay whole, so "reply to the second one" still finds what was just looked up. A note
 * and copy added after it (a reminder that fired since) do not move it.
 */
function lastTurnStart(messages: AgentMessage[]): number {
  let i = messages.length - 1;
  while (i >= 0 && !isModelReply(messages[i]!)) i--;
  while (i >= 0 && messages[i]!.role !== "user") i--;
  return Math.max(i, 0);
}

/**
 * [sunshine:prune] Every tool result before the last turn that is longer than PRUNE_MIN_CHARS, or
 * holds an image, becomes PRUNED_RESULT. The call it answers, its id and its place stay, so the
 * history stays valid for the API. Running it again changes nothing.
 */
export function pruneToolResults(messages: AgentMessage[]): { messages: AgentMessage[]; results: number; chars: number } {
  const from = lastTurnStart(messages);
  let results = 0;
  let chars = 0;
  const out = messages.map((m, i) => {
    if (i >= from || m.role !== "toolResult") return m;
    const text = m.content.map((c) => (c.type === "text" ? c.text : undefined)).filter((t) => t !== undefined).join("\n");
    const images = m.content.some((c) => c.type !== "text");
    if (text.length <= PRUNE_MIN_CHARS && !images) return m;
    results++;
    chars += text.length;
    return { ...m, content: [{ type: "text" as const, text: PRUNED_RESULT }] };
  });
  return results === 0 ? { messages, results, chars } : { messages: out, results, chars };
}

/**
 * The kept slice must begin at a user turn so no tool result is left without its call. A
 * long tool loop (a browser session: screenshot, click, screenshot...) can run past the
 * window with no user turn at all; then the slice begins at the next assistant turn, which
 * the API also accepts, and never at a tool result, which it rejects. With nothing left to
 * land on this returns the end, and the caller keeps the slice where it is.
 */
function nextUserTurn(messages: AgentMessage[], from: number): number {
  let i = from;
  while (i < messages.length && messages[i]?.role !== "user") i++;
  if (i < messages.length) return i;
  let a = from;
  while (a < messages.length && messages[a]?.role !== "assistant") a++;
  return a;
}

/**
 * A screenshot is a few hundred thousand characters of base64, more than the whole char
 * budget, so a browser session would push the fold past every turn in one step. Older
 * screenshots are swapped for a one-line placeholder; the newest few stay, since the model
 * is looking at them. The text parts of the result are untouched.
 */
export function dropOldImages(messages: AgentMessage[], keepImages = KEEP_RECENT_IMAGES): AgentMessage[] {
  let seen = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "toolResult" || !m.content.some((c) => c.type === "image")) continue;
    seen++;
    if (seen <= keepImages) continue;
    out[i] = { ...m, content: m.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "(an earlier screenshot, dropped to save space)" } : c)) };
  }
  return out;
}

function charSize(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += 1000;
    }
  }
  return total;
}

function dropOrphanToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const resultIds = new Set<string>();
  for (const m of messages) if (m.role === "toolResult") resultIds.add(m.toolCallId);
  let end = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const orphan = m.content.some((c) => c.type === "toolCall" && !resultIds.has(c.id));
    if (orphan) {
      end = i;
      break;
    }
  }
  return messages.slice(0, end);
}

const SUMMARY_PREFIX = "[Conversation summary]";
const SUMMARY_MAX_CHARS = 6000;

function summarizeMessages(older: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of older) {
    if (m.role === "user") {
      const text = messageText(m.content);
      // [sunshine:memory] An earlier summary is carried forward whole. Clipped to one line like any
      // other message, everything it held was lost at the second fold (seen live: "[Conversation summ…").
      if (text.startsWith(SUMMARY_PREFIX)) {
        lines.push(...text.split("\n").slice(1).filter((l) => l.trim()));
        continue;
      }
      if (text) lines.push(`- user: ${clip(compactStamp(text), 200)}`);
    } else if (m.role === "assistant") {
      const text = messageText(m.content.filter((c) => c.type === "text"));
      const calls = m.content.filter((c) => c.type === "toolCall").map((c) => c.name);
      if (text) lines.push(`- assistant: ${clip(text, 200)}`);
      if (calls.length) lines.push(`- assistant used tools: ${calls.join(", ")}`);
    }
  }
  // [sunshine:memory] Over the cap, the oldest highlights go first, so the summary keeps the latest.
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i]!.length + 1;
    if (size > SUMMARY_MAX_CHARS) {
      kept.unshift("- (older highlights dropped)");
      break;
    }
    kept.unshift(lines[i]!);
  }
  return `${SUMMARY_PREFIX} ${older.length} earlier messages were trimmed to save space. Highlights, oldest first:\n${kept.join("\n")}`;
}

/**
 * [sunshine:memory] The time stamp in front of a message ("[Wed 14 Oct 2026, 12:27 Europe/Oslo,
 * UTC+02:00]" and a line break) shortened to "[Wed 14 Oct, 12:27] ", so a summary line keeps the
 * date and still has room for what was said.
 */
function compactStamp(text: string): string {
  return text.replace(/^\[(\w{3} \d{1,2} \w{3}) \d{4}, (\d{2}:\d{2})[^\]\n]*\]\n/, "[$1, $2] ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(text: string, now: Date): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: now.getTime() };
}

/** [sunshine:delivery-mirror] A copy of a text Sunshine sent, as its own message in the owner's thread. */
function mirroredMessage(text: string, model: Model<any>, at: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: at,
  } as AgentMessage;
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = messageText(m.content.filter((c) => c.type === "text")).trim();
    if (text) return text;
  }
  return "";
}

function runFailure(messages: AgentMessage[]): string | undefined {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    return last.errorMessage || `model run ${last.stopReason}`;
  }
  return undefined;
}

function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function contentPreview(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = messageText(content as Array<{ type: string; text?: string }>);
  return text ? clip(text, 300) : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** [sunshine:silent-reply] The reply is the word alone, in any case, surrounding whitespace ignored. */
function isSilentReply(text: string): boolean {
  return text.trim().toUpperCase() === SILENT_REPLY;
}

/** [sunshine:reply-guard] A tool's declared reply target; a broken helper counts as none. */
function safeReplyTarget(meta: ToolMeta | undefined, args: unknown): ReplyTarget | undefined {
  try {
    return meta?.replyTarget?.(args);
  } catch {
    return undefined;
  }
}

/**
 * [sunshine:reply-guard] Whether a tool's text went where this run's final reply would go: the
 * thread being answered, or the owner when the run is a scheduled job or the owner's own private
 * text thread (on the shared line the owner's phone is that thread). A non-owner's thread, a
 * group, or the dashboard chat is somewhere else, so relaying to the owner from there is not a reply.
 */
function reachesOwnAudience(conv: Conversation, target: ReplyTarget | undefined): boolean {
  if (target === "current") return true;
  if (target !== "owner") return false;
  // [sunshine:reply-guard] A system task (upstream's `system.task`) also runs as the owner with no thread of its own.
  if (conv.channel === "scheduled" || conv.channel === "system") return true;
  const privateOwnerText = conv.principal.kind === "owner" && (conv.channel === "imessage" || conv.channel === "sms") && conv.deliveryKey === conv.key;
  return privateOwnerText;
}

function safeDescribe(meta: ToolMeta | undefined, args: unknown): string {
  try {
    const described = meta?.describe?.(args);
    if (described) return described;
  } catch {
    // A describe helper must never break the audit trail.
  }
  return clip(JSON.stringify(args ?? {}), 300);
}

/** Pick the capability the approval is about: the first one the tier does not get outright. */
function askedCapability(principal: Principal, meta: ToolMeta): Capability {
  const row = DEFAULT_TIER_TABLE[principal.tier];
  for (const cap of meta.capabilities) {
    const permission = row?.[cap];
    if (permission === "ask" || permission === "limit" || permission === "no") return cap;
  }
  return meta.capabilities[0] ?? "converse";
}

/** JSON with sorted keys, so two equal argument objects always hash the same. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** The part of an error a person can use: no JSON bodies, no status-code prefixes, one short line. */
export function shortReason(message: string): string {
  let m = message.split(/[{\n]/)[0] ?? "";
  m = m.replace(/^\s*\d{3}:?\s*/, "").replace(/[:\s]+$/, "").trim();
  if (m.length > 80) m = `${m.slice(0, 77).trim()}...`;
  return m;
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args ?? {})).digest("hex").slice(0, 16);
}

function approvalText(approval: Approval, requester: Principal, config: InstinctConfig): string {
  const who = requester.kind === "owner" ? "" : ` (asked by ${requester.displayName})`;
  const amount = approval.amountUsd !== undefined ? ` ($${approval.amountUsd.toFixed(2)})` : "";
  // A plain question, no token and no protocol words: a bare yes or no settles it, anything else the model settles.
  // Policy prompts may already end with the question; strip it so it is asked exactly once.
  void config;
  const base = approval.summary.replace(/[\s.?!]*want me to go ahead\?\s*$/i, "").replace(/[\s.?!]+$/, "");
  return `${base}${amount}${who}. Want me to go ahead?`;
}

function untrustedLabel(msg: InboundMessage, principal: Principal): string {
  return `${msg.channel} from ${principal.displayName} (${principal.kind}, tier ${principal.tier})`;
}

/** One line per attachment. Names, types and links are sender-controlled, so they are flattened to one line each. */
function withAttachments(text: string, msg: InboundMessage): string {
  if (!msg.attachments?.length) return text;
  const flat = (v: string | undefined, max: number) => (v ? clip(v.replace(/[\r\n\[\]]+/g, " ").trim(), max) : "");
  const lines = msg.attachments.map((a) => {
    const name = flat(a.name, 200);
    const type = flat(a.mimeType, 80);
    const where = a.path ? ` path=${flat(a.path, 300)}` : a.url ? ` url=${a.url.replace(/[\r\n]+/g, "").trim()}` : "";
    return `[attachment${name ? ` ${name}` : ""}${type ? ` ${type}` : ""}${where}]`;
  });
  return `${text}\n${lines.join("\n")}`;
}

const DATA_PART_CAP = 6_000;

/** The structured data part of an A2A message, described when a describer is wired and always dumped as JSON. */
function withData(text: string, msg: InboundMessage, describe: RuntimeDeps["describeData"]): string {
  if (!msg.data || typeof msg.data !== "object") return text;
  const parts: string[] = [];
  if (describe) {
    try {
      const described = describe(msg.data);
      if (described?.trim()) parts.push(described.trim());
    } catch {
      // A describer that throws must not drop the message.
    }
  }
  let json: string;
  try {
    json = JSON.stringify(msg.data);
  } catch {
    json = "(unserializable data part)";
  }
  parts.push(`Structured data part (OIP):\n${clip(json, DATA_PART_CAP)}`);
  return `${text}\n\n${parts.join("\n")}`.trim();
}

function ackText(channel: Channel): string {
  switch (channel) {
    case "email":
      return "Got it. I am on it and will reply by email when done.";
    case "chat":
      return "On it. This is taking a moment; send another message in a bit and I will have the answer here.";
    case "a2a":
      return "Working on it.";
    default:
      return "On it. I will text you when it is done.";
  }
}

function isGroup(msg: InboundMessage): boolean {
  return msg.meta?.isGroup === true;
}

/**
 * The runtime key for a message. A 1:1 thread is its own key. A group thread gets one key
 * per principal, so each participant has their own Agent and transcript while replies
 * still land in the shared thread.
 */
export function runtimeKey(msg: InboundMessage, principal: Principal): string {
  if (msg.channel === "a2a" && msg.replyRef.taskId) return `${msg.conversationKey}:task:${msg.replyRef.taskId}${msg.replyRef.messageId ? `:message:${msg.replyRef.messageId}` : ""}`;
  if (!isGroup(msg)) return msg.conversationKey;
  return `${msg.conversationKey}:${principal.id}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function channelOf(key: string): Channel {
  const prefix = key.slice(0, key.indexOf(":") > 0 ? key.indexOf(":") : key.length);
  return CHANNELS.has(prefix) ? (prefix as Channel) : "chat";
}

function localDay(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

type BudgetOutcome<T> = { state: "done"; value: T } | { state: "pending" };

function withinBudget<T>(promise: Promise<T>, budgetMs: number): Promise<BudgetOutcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: "pending" }), budgetMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve({ state: "done", value });
    });
  });
}
