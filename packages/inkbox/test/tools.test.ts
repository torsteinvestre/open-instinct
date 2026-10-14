import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactStore, StateDir, defaultConfig, type InstinctConfig, type OutboundMessage, type Principal, type ToolContext } from "@open-instinct/core";
import type { FileSend, InkboxChannel } from "../src/channel.js";
import { messagingTools, resolveTarget, sendFileReplyTarget, sendFileTool, sendMessageReplyTarget, type MessagingDeps } from "../src/tools.js";

let dir: string;
let contacts: ContactStore;
let config: InstinctConfig;
let sent: Array<{ msg: OutboundMessage; ctx: { principal: Principal; conversationKey: string } }>;
let channel: InkboxChannel;

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria", phone: "+14155550000" };
const friend: Principal = { kind: "contact", id: "contact:sam-lee", tier: "friend", displayName: "Sam Lee", contactId: "sam-lee", phone: "+14155550100" };
const ctxFor = (principal: Principal, conversationKey: string): ToolContext => ({
  principal,
  conversationKey,
  channel: conversationKey.split(":")[0] as ToolContext["channel"],
  now: () => new Date("2026-10-03T12:00:00Z"),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inkbox-tools-"));
  const state = new StateDir(dir);
  state.ensure();
  contacts = new ContactStore(state);
  contacts.upsert({ name: "Sam Lee", phones: ["415-555-0100"], emails: ["sam@example.com"], tier: "friend" });
  contacts.upsert({ name: "Priya Patel", emails: ["priya@example.com"], tier: "contact" });
  contacts.upsert({ name: "Sam Jones", phones: ["+14155550199"], tier: "contact" });
  config = defaultConfig();
  config.owner = { ...config.owner, name: "Maria", phones: ["+14155550000"], emails: ["maria@example.com"] };
  sent = [];
  channel = {
    send: vi.fn(async (msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }) => {
      sent.push({ msg, ctx });
    }),
    typing: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
  } as unknown as InkboxChannel;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tool(name: string) {
  const t = messagingTools({ channel, contacts, config }).find((x) => x.spec.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t.spec;
}

describe("resolveTarget", () => {
  it("resolves owner, contact ids, names, phones and emails", () => {
    const deps = { contacts, config };
    expect(resolveTarget("owner", deps)).toEqual({ channel: "imessage", to: "+14155550000", label: "Maria" });
    expect(resolveTarget("owner", deps, "email")).toEqual({ channel: "email", to: "maria@example.com", label: "Maria" });
    expect(resolveTarget("sam-lee", deps)).toEqual({ channel: "imessage", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("sam-lee", deps, "sms")).toEqual({ channel: "sms", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("sam-lee", deps, "email")).toEqual({ channel: "email", to: "sam@example.com", label: "Sam Lee" });
    expect(resolveTarget("Priya Patel", deps)).toEqual({ channel: "email", to: "priya@example.com", label: "Priya Patel" });
    expect(resolveTarget("(415) 555-0100", deps)).toEqual({ channel: "imessage", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("+1 650 555 0001", deps)).toEqual({ channel: "imessage", to: "+16505550001", label: "+16505550001" });
    expect(resolveTarget("Someone@Example.com", deps)).toEqual({ channel: "email", to: "someone@example.com", label: "Someone@Example.com" });
  });

  it("reads a phone written the local way as the owner's country", () => {
    const norwegian = { contacts, config: { ...config, owner: { ...config.owner, phones: ["+4745775184"] } } };
    expect(resolveTarget("912 34 567", norwegian)).toEqual({ channel: "imessage", to: "+4791234567", label: "+4791234567" });
    expect(resolveTarget("+46 70 123 45 67", norwegian)).toEqual({ channel: "imessage", to: "+46701234567", label: "+46701234567" });
  });

  // [sunshine:reply-guard]
  it("send_message says who it texts, so the runtime does not send the final reply on top", () => {
    expect(sendMessageReplyTarget({ text: "hi" }, config)).toBe("current");
    expect(sendMessageReplyTarget({ to: "owner", text: "hi" }, config)).toBe("owner");
    expect(sendMessageReplyTarget({ to: "(415) 555-0000", text: "hi" }, config)).toBe("owner");
    expect(sendMessageReplyTarget({ to: "owner", channel: "email", text: "hi" }, config)).toBeUndefined();
    expect(sendMessageReplyTarget({ to: "sam-lee", text: "hi" }, config)).toBeUndefined();
    expect(sendMessageReplyTarget({ to: "+1 650 555 0001", text: "hi" }, config)).toBeUndefined();
    expect(sendMessageReplyTarget({ to: "owner", text: "hi" }, { ...config, owner: { ...config.owner, phones: [] } })).toBeUndefined();
    // Every messaging tool that can text a person declares it; the rest send no text.
    const tools = messagingTools({ channel, contacts, config });
    expect(tools.find((t) => t.spec.name === "send_message")?.spec.meta.replyTarget).toBeDefined();
    expect(tools.filter((t) => t.spec.meta.replyTarget).map((t) => t.spec.name)).toEqual(["send_message", "react", "send_file"]);
  });

  // [sunshine:reply-guard]
  it("send_file's caption is a text to the same people; a file without one leaves the reply to say it", () => {
    expect(sendFileReplyTarget({ path: "a.pdf", caption: "Packing list" }, config)).toBe("current");
    expect(sendFileReplyTarget({ path: "a.pdf", caption: "Packing list", to: "owner" }, config)).toBe("owner");
    expect(sendFileReplyTarget({ path: "a.pdf", caption: "Packing list", to: "sam-lee" }, config)).toBeUndefined();
    expect(sendFileReplyTarget({ path: "a.pdf", caption: "Packing list", to: "owner", channel: "email" }, config)).toBeUndefined();
    expect(sendFileReplyTarget({ path: "a.pdf" }, config)).toBeUndefined();
    expect(sendFileReplyTarget({ path: "a.pdf", caption: "   " }, config)).toBeUndefined();
    expect(sendFileTool({ contacts, config }).spec.meta.replyTarget?.({ path: "a.pdf", caption: "Here" })).toBe("current");
  });

  it("refuses ambiguous names, unknown people and missing addresses", () => {
    const deps = { contacts, config };
    expect(() => resolveTarget("Sam", deps)).toThrow(/several contacts/);
    expect(() => resolveTarget("nobody", deps)).toThrow(/no contact/);
    expect(() => resolveTarget("priya-patel", deps, "imessage")).toThrow(/no phone/);
    expect(() => resolveTarget("", deps)).toThrow(/empty/);
    const noPhoneOwner = { contacts, config: { ...config, owner: { ...config.owner, phones: [] } } };
    expect(resolveTarget("owner", noPhoneOwner).channel).toBe("email");
  });
});

describe("send_message", () => {
  it("replies in the current conversation when `to` is omitted", async () => {
    const r = await tool("send_message").execute({ text: "On my way" }, ctxFor(owner, "imessage:conv_1"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toEqual({ channel: "imessage", conversationKey: "imessage:conv_1", text: "On my way" });
    expect(sent[0]?.ctx.conversationKey).toBe("imessage:conv_1");
    expect(JSON.stringify(r)).toContain("imessage");
  });

  it("uses the delivery conversation and reply reference instead of the internal session key", async () => {
    await tool("send_message").execute({ text: "Hi everyone" }, {
      ...ctxFor(owner, "imessage:group_1:owner"), deliveryKey: "imessage:group_1",
    });
    expect(sent[0]?.msg.conversationKey).toBe("imessage:group_1");
    const replyRef = { from: "sam@example.com", subject: "Plans", messageId: "<original@example.com>" };
    await tool("send_message").execute({ text: "Thursday works" }, {
      ...ctxFor(owner, "email:thread_1"), deliveryKey: "email:thread_1", replyRef,
    });
    expect(sent[1]?.msg.replyRef).toEqual(replyRef);
  });

  it("uses the wire conversation for typing in group sessions, and does not react there", async () => {
    const ctx = { ...ctxFor(owner, "imessage:group_1:owner"), deliveryKey: "imessage:group_1", replyRef: { messageId: "message_1" } };
    await tool("send_typing").execute({}, ctx);
    expect(channel.typing).toHaveBeenCalledWith("imessage:group_1");
    // [sunshine:reactions] Tapbacks only in the owner's own one-to-one thread.
    const r = await tool("react").execute({ reaction: "like", alone: true }, ctx);
    expect(JSON.stringify(r)).toMatch(/only for the owner's own one-to-one thread/);
    expect(channel.react).not.toHaveBeenCalled();
  });

  it("lets the owner message a contact, a number, or an email with a subject", async () => {
    const t = tool("send_message");
    await t.execute({ to: "sam-lee", text: "Dinner Thursday?" }, ctxFor(owner, "chat:cli"));
    await t.execute({ to: "+14155550199", channel: "sms", text: "hi" }, ctxFor(owner, "chat:cli"));
    await t.execute({ to: "priya@example.com", text: "Hello Priya", subject: "Intro" }, ctxFor(owner, "chat:cli"));
    expect(sent[0]?.msg).toEqual({ channel: "imessage", to: "+14155550100", text: "Dinner Thursday?" });
    expect(sent[1]?.msg).toEqual({ channel: "sms", to: "+14155550199", text: "hi" });
    expect(sent[2]?.msg).toMatchObject({ channel: "email", to: "priya@example.com", text: "Hello Priya", replyRef: { subject: "Intro" } });
  });

  it("blocks a non-owner from messaging third parties but lets them reply here or reach the owner", async () => {
    const t = tool("send_message");
    await expect(t.execute({ to: "priya-patel", text: "hey" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only reply here/);
    await expect(t.execute({ to: "+16505550001", text: "hey" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only reply here/);
    expect(sent).toHaveLength(0);

    await t.execute({ text: "sure, 7pm" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sent[0]?.msg).toEqual({ channel: "imessage", conversationKey: "imessage:conv_sam", text: "sure, 7pm" });

    await t.execute({ to: "owner", text: "Tell Maria I said hi" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sent[1]?.msg).toEqual({ channel: "imessage", to: "+14155550000", text: "From Sam Lee: Tell Maria I said hi" });
    expect(sent[1]?.ctx.principal).toBe(friend);
  });

  it("refuses to reply on chat or a2a threads without `to`, and rejects empty text", async () => {
    const t = tool("send_message");
    await expect(t.execute({ text: "x" }, ctxFor(owner, "chat:dashboard"))).rejects.toThrow(/Give `to`/);
    await expect(t.execute({ text: "x" }, ctxFor(friend, "a2a:ctx_1"))).rejects.toThrow(/reply_instinct/);
    const r = await t.execute({ text: "   " }, ctxFor(owner, "imessage:c"));
    expect(typeof r === "object" && r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("tags the tools with converse and the messaging group", () => {
    for (const name of ["send_message", "send_typing", "react"]) {
      expect(tool(name).meta).toMatchObject({ capabilities: ["converse"], group: "messaging" });
    }
    expect(tool("send_message").meta.describe?.({ to: "sam-lee", text: "hello there" })).toBe("send_message to sam-lee: hello there");
  });
});

describe("send_typing and react", () => {
  it("forward to the channel with the current conversation", async () => {
    await tool("send_typing").execute({}, ctxFor(owner, "imessage:conv_1"));
    expect(channel.typing).toHaveBeenCalledWith("imessage:conv_1");
    await tool("react").execute({ reaction: "love", alone: true }, { ...ctxFor(owner, "imessage:conv_1"), replyRef: { messageId: "msg_1" } });
    expect(channel.react).toHaveBeenCalledWith("imessage:conv_1", "msg_1", "love");
  });
});

// [sunshine:reactions] Upstream's tool needed a message id the model never sees; it was never used.
describe("[sunshine:reactions] react", () => {
  const own = (messageId?: string) => ({ ...ctxFor(owner, "imessage:conv_1"), ...(messageId ? { replyRef: { messageId } } : {}) });

  it("reacts to the message being answered, without being told which", async () => {
    const r = await tool("react").execute({ reaction: "like", alone: true }, own("msg_now"));
    expect(channel.react).toHaveBeenCalledWith("imessage:conv_1", "msg_now", "like");
    expect(JSON.stringify(r)).toContain("That is your whole reply: send no text.");
  });

  it("counts as the reply only when it stands alone, so no text follows a lone tapback", () => {
    const meta = tool("react").meta;
    expect(meta.replyTarget?.({ reaction: "like", alone: true })).toBe("current");
    expect(meta.replyTarget?.({ reaction: "love", alone: false })).toBeUndefined();
  });

  it("allows only like and love, once per message, and only for the owner", async () => {
    const react = tool("react"); // one instance, as at boot, so it remembers what it reacted to
    expect(JSON.stringify(await react.execute({ reaction: "question", alone: true } as never, own("m1")))).toMatch(/Use one of: like, love\./);
    expect(JSON.stringify(await react.execute({ reaction: "laugh", alone: true } as never, own("m1")))).toMatch(/Use one of: like, love\./);
    await react.execute({ reaction: "like", alone: true }, own("m2"));
    expect(JSON.stringify(await react.execute({ reaction: "love", alone: true }, own("m2")))).toMatch(/already reacted/);
    expect(JSON.stringify(await react.execute({ reaction: "like", alone: true }, { ...ctxFor(friend, "imessage:conv_2"), replyRef: { messageId: "m3" } }))).toMatch(/only for the owner/);
    expect(JSON.stringify(await react.execute({ reaction: "like", alone: true }, own()))).toMatch(/no message to react to/);
    expect(channel.react).toHaveBeenCalledTimes(1);
  });
});

describe("send_file", () => {
  const PDF = Buffer.from("%PDF-1.4\n%test\n");
  let sentFiles: Array<{ file: FileSend; ctx: { principal: Principal; conversationKey: string } }>;
  let dataDir: string;
  let workspace: string;

  beforeEach(() => {
    sentFiles = [];
    dataDir = realpathSync(dir);
    workspace = join(dataDir, "workspace");
    mkdirSync(join(workspace, "research"), { recursive: true });
    writeFileSync(join(workspace, "research", "brief.pdf"), PDF);
    writeFileSync(join(dataDir, "inbox", "photo.jpg"), Buffer.from([0xff, 0xd8]));
    (channel as unknown as { sendFile: unknown }).sendFile = vi.fn(async (file: FileSend, ctx: { principal: Principal; conversationKey: string }) => {
      sentFiles.push({ file, ctx });
      return { channel: file.channel };
    });
  });

  function fileTool(extra: Partial<MessagingDeps> = {}) {
    const t = messagingTools({ channel, contacts, config, dataDir, ...extra }).find((x) => x.spec.name === "send_file");
    if (!t) throw new Error("missing send_file");
    return t.spec;
  }
  const text = (r: Awaited<ReturnType<ReturnType<typeof fileTool>["execute"]>>) => (typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

  it("is tagged converse plus files.read in the messaging group", () => {
    expect(fileTool().meta).toMatchObject({ capabilities: ["converse", "files.read"], group: "messaging" });
    expect(fileTool().meta.describe?.({ path: "research/brief.pdf" })).toBe("send_file research/brief.pdf to current conversation");
  });

  it("sends a workspace-relative file in the current iMessage conversation with the caption", async () => {
    const r = await fileTool().execute({ path: "research/brief.pdf", caption: "Here is the brief as a PDF." }, ctxFor(owner, "imessage:conv_1"));
    expect(text(r)).toBe("Sent brief.pdf in the current imessage conversation.");
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles[0]?.file).toEqual({ channel: "imessage", conversationKey: "imessage:conv_1", filename: "brief.pdf", contentType: "application/pdf", content: PDF, caption: "Here is the brief as a PDF." });
    expect(sentFiles[0]?.ctx).toEqual({ principal: owner, conversationKey: "imessage:conv_1" });
  });

  it("emails a contact with subject and caption, and defaults the subject for new threads", async () => {
    const t = fileTool();
    await t.execute({ path: "research/brief.pdf", to: "priya-patel", caption: "As promised.", subject: "Research brief" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[0]?.file).toEqual({ channel: "email", to: "priya@example.com", filename: "brief.pdf", contentType: "application/pdf", content: PDF, caption: "As promised.", subject: "Research brief" });
    await t.execute({ path: "research/brief.pdf", to: "owner", channel: "email" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[1]?.file).toMatchObject({ channel: "email", to: "maria@example.com", subject: "brief.pdf from your Instinct" });
    expect(sentFiles[1]?.file.caption).toBeUndefined();
    await t.execute({ path: "research/brief.pdf", to: "sam-lee", channel: "sms" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[2]?.file).toMatchObject({ channel: "sms", to: "+14155550100" });
    expect(sentFiles[2]?.file.subject).toBeUndefined();
  });

  it("returns a maritime-file fence for dashboard chat instead of sending", async () => {
    const r = await fileTool().execute({ path: "research/brief.pdf", caption: "Here is the brief as a PDF.", subject: "Research brief" }, ctxFor(owner, "chat:dashboard"));
    const out = text(r);
    expect(sentFiles).toHaveLength(0);
    const m = /```maritime-file\n(.*)\n```/.exec(out);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual({ path: join(workspace, "research", "brief.pdf"), name: "brief.pdf", size: PDF.length, mime: "application/pdf", title: "Research brief", message: "Here is the brief as a PDF." });
    expect(out.startsWith(join(workspace, "research", "brief.pdf"))).toBe(true);
    const plain = await fileTool().execute({ path: "research/brief.pdf" }, ctxFor(owner, "chat:cli"));
    expect(JSON.parse(/```maritime-file\n(.*)\n```/.exec(text(plain))![1]!)).toEqual({ path: join(workspace, "research", "brief.pdf"), name: "brief.pdf", size: PDF.length, mime: "application/pdf" });
  });

  it("lets a non-owner send only into their own conversation or to the owner", async () => {
    const t = fileTool();
    await expect(t.execute({ path: "research/brief.pdf", to: "priya-patel" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only send files here/);
    await expect(t.execute({ path: "research/brief.pdf", to: "+16505550001" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only send files here/);
    expect(sentFiles).toHaveLength(0);
    await t.execute({ path: "research/brief.pdf" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[0]?.file).toMatchObject({ channel: "imessage", conversationKey: "imessage:conv_sam", filename: "brief.pdf" });
    await t.execute({ path: "research/brief.pdf", to: "owner", caption: "for Maria" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[1]?.file).toMatchObject({ channel: "imessage", to: "+14155550000", caption: "From Sam Lee: for Maria" });
    await t.execute({ path: "research/brief.pdf", to: "owner", channel: "email" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[2]?.file).toMatchObject({ channel: "email", to: "maria@example.com", subject: "File from Sam Lee", caption: "From Sam Lee: brief.pdf" });
  });

  it("accepts absolute paths under the data dir and refuses everything outside it", async () => {
    const t = fileTool();
    await t.execute({ path: join(dataDir, "inbox", "photo.jpg") }, ctxFor(owner, "imessage:conv_1"));
    expect(sentFiles[0]?.file).toMatchObject({ filename: "photo.jpg", contentType: "image/jpeg" });
    const outside = mkdtempSync(join(tmpdir(), "inkbox-outside-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      for (const bad of ["../../" + basename(outside) + "/secret.txt", join(outside, "secret.txt"), "../memory/MEMORY.md", "/etc/hosts"]) {
        const r = await t.execute({ path: bad }, ctxFor(owner, "imessage:conv_1"));
        expect(typeof r === "object" && r.isError, bad).toBe(true);
        expect(text(r), bad).toMatch(/outside the data directory|no file at/);
      }
      // A symlink inside the workspace pointing outside is followed and refused.
      symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
      const viaLink = await t.execute({ path: "link.txt" }, ctxFor(owner, "imessage:conv_1"));
      expect(text(viaLink)).toMatch(/outside the data directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    const missing = await t.execute({ path: "research/nope.pdf" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(missing)).toMatch(/no file at research\/nope\.pdf/);
    const folder = await t.execute({ path: "research" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(folder)).toMatch(/not a file/);
    expect(sentFiles).toHaveLength(1);
    const unconfigured = await fileTool({ dataDir: undefined }).execute({ path: "research/brief.pdf" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(unconfigured)).toMatch(/not configured/);
  });

  it("works without a channel: the dashboard chat still gets the file, wires are refused", async () => {
    const alone = sendFileTool({ contacts, config, dataDir }).spec;
    expect(alone.name).toBe("send_file");
    const chat = await alone.execute({ path: "research/brief.pdf", caption: "Here it is." }, ctxFor(owner, "chat:default"));
    expect(text(chat)).toContain("```maritime-file");
    expect(text(chat)).toContain(join(workspace, "research", "brief.pdf"));
    await expect(alone.execute({ path: "research/brief.pdf" }, ctxFor(owner, "imessage:conv_1"))).rejects.toThrow(/Inkbox is not configured/);
    await expect(alone.execute({ path: "research/brief.pdf", to: "owner" }, ctxFor(owner, "chat:default"))).rejects.toThrow(/Inkbox is not configured/);
    expect(sentFiles).toHaveLength(0);
  });

  it("refuses to send on a2a or unknown threads without `to`", async () => {
    const t = fileTool();
    await expect(t.execute({ path: "research/brief.pdf" }, ctxFor(friend, "a2a:ctx_1"))).rejects.toThrow(/agent-to-agent/);
    await expect(t.execute({ path: "research/brief.pdf" }, ctxFor(owner, "scheduled:job_1"))).rejects.toThrow(/Give `to`/);
    expect(sentFiles).toHaveLength(0);
  });

  it("passes the size guard to the channel: a file over 10 MiB is rejected by sendFile, not read twice", async () => {
    // The real channel enforces the cap; the tool hands it the bytes and surfaces the error.
    const big = join(workspace, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 10 * 1024 * 1024 + 1);
    (channel as unknown as { sendFile: unknown }).sendFile = vi.fn(async (file: FileSend) => {
      if (file.channel !== "email" && file.content.length > 10 * 1024 * 1024) throw new Error("big.bin is 10.0 MiB; iMessage attachments are capped at 10.0 MiB. Send it by email instead.");
      sentFiles.push({ file, ctx: { principal: owner, conversationKey: "x" } });
      return { channel: file.channel };
    });
    await expect(fileTool().execute({ path: "big.bin" }, ctxFor(owner, "imessage:conv_1"))).rejects.toThrow(/capped at 10\.0 MiB/);
    await fileTool().execute({ path: "big.bin", to: "owner", channel: "email" }, ctxFor(owner, "imessage:conv_1"));
    expect(sentFiles[0]?.file.content.length).toBe(10 * 1024 * 1024 + 1);
  });
});
