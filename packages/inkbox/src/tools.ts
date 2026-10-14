/**
 * Messaging tools the model can call. The policy guard decides whether the
 * principal may converse at all; this file enforces the one rule policy cannot
 * express: a non-owner may only speak in their own thread or to the owner.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, normalizeHandle, normalizePhone, phoneCountryOf, textResult } from "@open-instinct/core";
import type { Contact, ContactStore, InstinctConfig, OutboundMessage, RegisteredTool, ReplyTarget, ToolContext, ToolResultLike } from "@open-instinct/core";
import type { FileSend, InkboxChannel } from "./channel.js";
import { parseConversationKey } from "./channel.js";

/**
 * What send_file needs. The channel is optional: without Inkbox the tool still
 * hands files to the dashboard chat, and refuses iMessage, SMS and email.
 */
export interface SendFileDeps {
  channel?: InkboxChannel;
  contacts: ContactStore;
  config: InstinctConfig;
  /**
   * The state directory (`/data` on Maritime). send_file reads workspace-relative paths
   * under `<dataDir>/workspace` and absolute paths anywhere under `dataDir`. Without it
   * send_file refuses every path.
   */
  dataDir?: string;
}

export interface MessagingDeps extends SendFileDeps {
  channel: InkboxChannel;
}

type SendChannel = "imessage" | "sms" | "email";

export interface ResolvedTarget {
  channel: SendChannel;
  to: string;
  label: string;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function looksLikePhone(s: string): boolean {
  return /^\+?[\d\s().-]{7,}$/.test(s) && s.replace(/\D/g, "").length >= 7;
}

function pickForContact(c: Contact, preferred?: SendChannel): ResolvedTarget {
  const phone = c.phones[0];
  const email = c.emails[0];
  if (preferred === "email" || (!preferred && !phone)) {
    if (!email) throw new Error(`${c.name} has no email on file`);
    return { channel: "email", to: email, label: c.name };
  }
  if (!phone) throw new Error(`${c.name} has no phone number on file`);
  return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: c.name };
}

/**
 * "owner", a contact id or name, a phone number or an email address become a
 * concrete channel and address. iMessage is the default for phone numbers.
 */
export function resolveTarget(to: string, deps: Pick<MessagingDeps, "contacts" | "config">, preferred?: SendChannel): ResolvedTarget {
  const raw = to.trim();
  if (!raw) throw new Error("`to` is empty");
  if (raw.toLowerCase() === "owner") {
    const owner = deps.config.owner;
    const phone = owner.phones[0];
    const email = owner.emails[0];
    if (preferred === "email" || (!preferred && !phone)) {
      if (!email) throw new Error("the owner has no email configured");
      return { channel: "email", to: email, label: owner.name };
    }
    if (!phone) throw new Error("the owner has no phone configured");
    return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: owner.name };
  }
  if (looksLikeEmail(raw)) {
    const c = deps.contacts.findByEmail(raw);
    return { channel: "email", to: raw.toLowerCase(), label: c?.name ?? raw };
  }
  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw, phoneCountryOf(deps.config));
    const c = deps.contacts.findByPhone(phone);
    return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: c?.name ?? phone };
  }
  const byId = deps.contacts.get(raw) ?? deps.contacts.get(normalizeHandle(raw).replace(/\s+/g, "-"));
  if (byId) return pickForContact(byId, preferred);
  const matches = deps.contacts.search(raw);
  if (matches.length === 1 && matches[0]) return pickForContact(matches[0], preferred);
  if (matches.length > 1) {
    throw new Error(`"${raw}" matches several contacts: ${matches.map((m) => m.id).join(", ")}. Use the contact id.`);
  }
  throw new Error(`no contact, phone or email matches "${raw}"`);
}

export interface ResolvedFile {
  /** Canonical absolute path. */
  path: string;
  name: string;
  size: number;
  mime: string;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  ics: "text/calendar",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Turn a tool path into a readable file inside the data directory. Relative paths
 * are workspace-relative; absolute paths must stay under the data directory after
 * symlinks are followed. Throws with a plain reason otherwise.
 */
export function resolveFilePath(dataDir: string, requested: string): ResolvedFile {
  const raw = requested.trim();
  if (!raw || raw.includes("\0")) throw new Error("`path` is empty");
  const root = realpathOr(path.resolve(dataDir));
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, "workspace", raw);
  if (!fs.existsSync(candidate)) throw new Error(`no file at ${raw}`);
  const real = realpathOr(candidate);
  if (!real.startsWith(root + path.sep)) throw new Error(`Refused: "${raw}" is outside the data directory`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${raw} is not a file`);
  return { path: real, name: path.basename(real), size: stat.size, mime: mimeTypeFor(real) };
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The fence Maritime's `maritime-share` prints; the dashboard renders it as an attachment. */
export function maritimeFileFence(file: ResolvedFile, extra: { title?: string; message?: string } = {}): string {
  const payload: Record<string, string | number> = { path: file.path, name: file.name, size: file.size, mime: file.mime };
  if (extra.title) payload.title = extra.title;
  if (extra.message) payload.message = extra.message;
  return "```maritime-file\n" + JSON.stringify(payload) + "\n```";
}

const sendFileParams = Type.Object({
  path: Type.String({ description: "The file: a workspace-relative path (research/brief.pdf) or an absolute path under the data directory." }),
  to: Type.Optional(
    Type.String({
      description: 'Recipient: a contact id or name, a phone number, an email address, or "owner". Omit to send in the current conversation.',
    }),
  ),
  channel: Type.Optional(
    Type.Union([Type.Literal("imessage"), Type.Literal("sms"), Type.Literal("email")], {
      description: "Force a channel. Default: iMessage for phones, email for addresses. Email for anything over a few MB or a few pages.",
    }),
  ),
  caption: Type.Optional(Type.String({ description: "One line sent with the file (the iMessage bubble or the email body)." })),
  subject: Type.Optional(Type.String({ description: "Email subject when starting a new email thread." })),
});

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function isOwner(ctx: ToolContext): boolean {
  return ctx.principal.kind === "owner";
}

const sendMessageParams = Type.Object({
  to: Type.Optional(
    Type.String({
      description: 'Recipient: a contact id or name, a phone number, an email address, or "owner". Omit to reply in the current conversation.',
    }),
  ),
  channel: Type.Optional(
    Type.Union([Type.Literal("imessage"), Type.Literal("sms"), Type.Literal("email")], {
      description: "Force a channel. Default: iMessage for phones, email for addresses.",
    }),
  ),
  text: Type.String({ description: "The message. Plain text; keep iMessage short." }),
  subject: Type.Optional(Type.String({ description: "Email subject when starting a new email thread." })),
});

/**
 * [sunshine:reactions] Upstream's tool asked for a message id the model never sees, so it could not
 * be used. The target is now always the message being answered, only the three tapbacks friends
 * use for acknowledgment are allowed, and `alone` says whether the reaction is the whole reply.
 */
export const REACTIONS = ["like", "love"] as const; // laugh left out on purpose: easy to misuse (Torstein, 2026-10-14)
const reactParams = Type.Object({
  reaction: Type.Union(REACTIONS.map((r) => Type.Literal(r)), { description: "like: ok, got it, sounds good. love: thanks, warmth, good news, a compliment." }),
  alone: Type.Boolean({ description: "true when this reaction is your whole reply and you send no text; false when you also answer in words." }),
});

/**
 * [sunshine:reply-guard] Who send_message texts. No `to` is the conversation being answered; the
 * owner by name or by their own phone is the owner's phone. Email, even to the owner, is another
 * place ("email me the summary", then a reply saying it went), so it reports nothing.
 */
export function sendMessageReplyTarget(args: unknown, config: InstinctConfig): ReplyTarget | undefined {
  const a = args as { to?: string; channel?: string };
  const to = a.to?.trim();
  if (!to) return "current";
  if (a.channel === "email") return undefined;
  if (to.toLowerCase() === "owner") return config.owner.phones.length > 0 ? "owner" : undefined;
  if (!looksLikePhone(to)) return undefined;
  const country = phoneCountryOf(config);
  const phone = normalizePhone(to, country);
  return config.owner.phones.some((p) => normalizePhone(p, country) === phone) ? "owner" : undefined;
}

/**
 * [sunshine:reply-guard] Who send_file's caption texts: the same people as send_message. Without a
 * caption the file arrives alone, so the final reply is still its message. Seen live: the PDF, its
 * caption, then "Sent: a one-page packing list ...".
 */
export function sendFileReplyTarget(args: unknown, config: InstinctConfig): ReplyTarget | undefined {
  const caption = (args as { caption?: string }).caption?.trim();
  return caption ? sendMessageReplyTarget(args, config) : undefined;
}

export function messagingTools(deps: MessagingDeps): RegisteredTool[] {
  const sendMessage = defineTool({
    name: "send_message",
    label: "Send message",
    description:
      "Send a text message. With no `to`, replies in the current conversation. With `to`, messages a contact, a phone number, an email address, or the owner.",
    parameters: sendMessageParams,
    meta: {
      capabilities: ["converse"],
      group: "messaging",
      describe: (args) => {
        const a = args as { to?: string; text?: string };
        return `send_message to ${a.to ?? "current conversation"}: ${(a.text ?? "").slice(0, 80)}`;
      },
      replyTarget: (args) => sendMessageReplyTarget(args, deps.config), // [sunshine:reply-guard]
    },
    execute: async (args, ctx) => {
      const text = args.text.trim();
      if (!text) return { content: [{ type: "text", text: "Nothing to send: text is empty." }], isError: true };

      if (!args.to) {
        const deliveryKey = ctx.deliveryKey ?? ctx.conversationKey;
        const key = parseConversationKey(deliveryKey);
        if (key.channel === "a2a") {
          throw new Error("This is an agent-to-agent conversation. Use reply_instinct to answer the other agent.");
        }
        if (key.channel !== "imessage" && key.channel !== "sms" && key.channel !== "email") {
          throw new Error(`Cannot reply on "${ctx.conversationKey}". Give \`to\` to pick a recipient.`);
        }
        const msg: OutboundMessage = { channel: key.channel, conversationKey: deliveryKey, text, ...(ctx.replyRef ? { replyRef: ctx.replyRef } : {}) };
        await deps.channel.send(msg, { principal: ctx.principal, conversationKey: ctx.conversationKey });
        return textResult(`Sent in the current ${key.channel} conversation.`);
      }

      const wantsOwner = args.to.trim().toLowerCase() === "owner";
      if (!isOwner(ctx) && !wantsOwner) {
        throw new Error(`${ctx.principal.displayName} may only reply here or leave a message for the owner (to: "owner").`);
      }

      const target = resolveTarget(args.to, deps, args.channel);
      const msg: OutboundMessage = { channel: target.channel, to: target.to, text };
      if (target.channel === "email") {
        (msg as OutboundMessage & { replyRef?: Record<string, string | undefined> }).replyRef = {
          subject: args.subject ?? (wantsOwner && !isOwner(ctx) ? `Message from ${ctx.principal.displayName}` : "Message from your Instinct"),
        };
      }
      if (!isOwner(ctx) && wantsOwner) {
        // The owner must always know who a relayed message came from.
        msg.text = `From ${ctx.principal.displayName}: ${text}`;
      }
      await deps.channel.send(msg, { principal: ctx.principal, conversationKey: ctx.conversationKey });
      return textResult(`Sent to ${target.label} via ${target.channel}.`);
    },
  });

  const sendTyping = defineTool({
    name: "send_typing",
    label: "Show typing",
    description: "Show a typing indicator in the current iMessage conversation while you work. No effect on other channels.",
    parameters: Type.Object({}),
    meta: { capabilities: ["converse"], group: "messaging", describe: () => "send_typing" },
    execute: async (_args, ctx) => {
      await deps.channel.typing(ctx.deliveryKey ?? ctx.conversationKey);
      return textResult("ok");
    },
  });

  // [sunshine:reactions] One tapback per message, at most.
  const reacted = new Set<string>();
  const react = defineTool({
    name: "react",
    label: "Tapback",
    description:
      "Put an iMessage tapback (like or love) on the owner's message you are answering, in their own one-to-one thread. alone: true when it is your whole reply; alone: false when you also write. Never instead of words they need.",
    parameters: reactParams,
    meta: {
      capabilities: ["converse"],
      group: "messaging",
      describe: (args) => {
        const a = args as { reaction?: string; alone?: boolean };
        return `react ${a.reaction ?? ""}${a.alone ? " (as the whole reply)" : ""}`;
      },
      // [sunshine:reactions] A lone tapback is the whole reply, unless the run also did something
      // (the runtime then still sends the text, so a report is never swallowed).
      replyTarget: (args) => ((args as { alone?: unknown }).alone === true ? "acknowledge" : undefined),
    },
    execute: async (args, ctx) => {
      // [sunshine:reactions] Fences: the owner's private thread, three tapbacks, once per message.
      const privateThread = !ctx.deliveryKey || ctx.deliveryKey === ctx.conversationKey;
      if (ctx.principal.kind !== "owner" || !privateThread) {
        return { content: [{ type: "text", text: "Reactions are only for the owner's own one-to-one thread. Answer in words." }], isError: true };
      }
      if (!(REACTIONS as readonly string[]).includes(args.reaction)) {
        return { content: [{ type: "text", text: `Use one of: ${REACTIONS.join(", ")}.` }], isError: true };
      }
      const target = ctx.replyRef?.messageId;
      if (!target) return { content: [{ type: "text", text: "There is no message to react to here. Answer in words." }], isError: true };
      if (reacted.has(target)) return { content: [{ type: "text", text: "You already reacted to this message." }], isError: true };
      await deps.channel.react(ctx.deliveryKey ?? ctx.conversationKey, target, args.reaction);
      reacted.add(target);
      if (reacted.size > 500) reacted.delete(reacted.values().next().value!); // only recent messages matter
      return textResult(args.alone ? `Reacted ${args.reaction}. No text is needed unless you also did something they should hear about.` : `Reacted ${args.reaction}. Now write your reply.`);
    },
  });

  // [sunshine:reactions] config.features.tapbacks = false is the off switch (upstream's flag, unused until now).
  const tapbacks = deps.config.features?.tapbacks !== false;
  return [sendMessage, sendTyping, ...(tapbacks ? [react] : []), sendFileTool(deps)];
}

/**
 * send_file on its own, for an agent without Inkbox: the dashboard chat still gets
 * the file; anything that needs a wire is refused with a plain reason.
 */
export function sendFileTool(deps: SendFileDeps): RegisteredTool {
  const wire = (): InkboxChannel => {
    if (!deps.channel) throw new Error("Inkbox is not configured, so files can only be shared in the dashboard chat here.");
    return deps.channel;
  };
  return defineTool({
    name: "send_file",
    label: "Send file",
    description:
      "Send a file from the workspace as an attachment. With no `to`, sends in the current conversation (iMessage, SMS, email, or the dashboard chat). With `to`, sends to a contact, a phone number, an email address, or the owner. iMessage and SMS take files up to 10 MB; use email for bigger files.",
    parameters: sendFileParams,
    meta: {
      capabilities: ["converse", "files.read"],
      group: "messaging",
      describe: (args) => {
        const a = args as { to?: string; path?: string };
        return `send_file ${a.path ?? ""} to ${a.to ?? "current conversation"}`;
      },
      replyTarget: (args) => sendFileReplyTarget(args, deps.config), // [sunshine:reply-guard]
    },
    execute: async (args, ctx) => {
      if (!deps.dataDir) return fail("File sending is not configured (no data directory).");
      let file: ResolvedFile;
      try {
        file = resolveFilePath(deps.dataDir, args.path);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const caption = args.caption?.trim();
      const content = () => fs.readFileSync(file.path);
      const base = (): Omit<FileSend, "channel"> => ({ filename: file.name, contentType: file.mime, content: content(), ...(caption ? { caption } : {}) });

      if (!args.to) {
        const key = parseConversationKey(ctx.conversationKey);
        if (key.channel === "chat") {
          // The Maritime dashboard turns this fence into an attachment; elsewhere it still names the file.
          const fence = maritimeFileFence(file, { ...(args.subject ? { title: args.subject } : {}), ...(caption ? { message: caption } : {}) });
          return textResult(`${file.path} (${file.size} bytes) is ready. Paste this block verbatim in your reply so the dashboard attaches it:\n${fence}`);
        }
        if (key.channel === "a2a") throw new Error("This is an agent-to-agent conversation; files cannot be attached to it. Give `to` to send it to a person.");
        if (key.channel !== "imessage" && key.channel !== "sms" && key.channel !== "email") {
          throw new Error(`Cannot send a file on "${ctx.conversationKey}". Give \`to\` to pick a recipient.`);
        }
        const send: FileSend = { ...base(), channel: key.channel, conversationKey: ctx.conversationKey };
        if (args.subject) send.subject = args.subject;
        await wire().sendFile(send, { principal: ctx.principal, conversationKey: ctx.conversationKey });
        return textResult(`Sent ${file.name} in the current ${key.channel} conversation.`);
      }

      const wantsOwner = args.to.trim().toLowerCase() === "owner";
      if (!isOwner(ctx) && !wantsOwner) {
        throw new Error(`${ctx.principal.displayName} may only send files here or to the owner (to: "owner").`);
      }
      const target = resolveTarget(args.to, deps, args.channel);
      const send: FileSend = { ...base(), channel: target.channel, to: target.to };
      if (target.channel === "email") send.subject = args.subject ?? (wantsOwner && !isOwner(ctx) ? `File from ${ctx.principal.displayName}` : `${file.name} from your Instinct`);
      if (!isOwner(ctx) && wantsOwner) send.caption = `From ${ctx.principal.displayName}: ${caption ?? file.name}`;
      await wire().sendFile(send, { principal: ctx.principal, conversationKey: ctx.conversationKey });
      return textResult(`Sent ${file.name} to ${target.label} via ${target.channel}.`);
    },
  });
}
