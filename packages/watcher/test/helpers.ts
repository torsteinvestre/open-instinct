// [sunshine:watcher] Shared fixtures: a temp data dir, an owner in Oslo, a fake outbox and fake feeds.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, Scheduler, StateDir, defaultConfig, type InstinctConfig, type OutboundMessage, type Principal, type ToolContext, type ToolResultLike } from "@open-instinct/core";

/** 12:00 in Oslo (CEST, UTC+2). */
export const NOON = new Date("2026-10-13T10:00:00Z");

export const OWNER: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Torstein", phone: "+4791234567" } as Principal;
export const FRIEND: Principal = { kind: "contact", id: "contact:sam", tier: "friend", displayName: "Sam", contactId: "sam", phone: "+4790000000" } as Principal;

export interface Fixture {
  dir: string;
  state: StateDir;
  config: InstinctConfig;
  audit: AuditLog;
  scheduler: Scheduler;
  sent: OutboundMessage[];
  outbox: { send: (msg: OutboundMessage) => Promise<void> };
  cleanup(): void;
}

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "watcher-"));
  const state = new StateDir(dir);
  state.ensure();
  const config = defaultConfig();
  config.owner = { ...config.owner, name: "Torstein", phones: ["+4791234567"], timezone: "Europe/Oslo" };
  const sent: OutboundMessage[] = [];
  return {
    dir,
    state,
    config,
    audit: new AuditLog(state),
    scheduler: new Scheduler(state, { now: () => NOON }),
    sent,
    outbox: { send: async (msg) => void sent.push(msg) },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function ctx(at: Date = NOON, principal: Principal = OWNER): ToolContext {
  return { principal, conversationKey: "scheduled:s_test", channel: "scheduled", now: () => at } as ToolContext;
}

export const textOf = (r: ToolResultLike): string => (typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
export const isError = (r: ToolResultLike): boolean => typeof r !== "string" && r.isError === true;

export interface FeedItem {
  title: string;
  link: string;
  source?: string;
  hoursAgo?: number;
}

export function rss(items: FeedItem[], now: Date = NOON): string {
  const body = items
    .map((i) => {
      const pub = new Date(now.getTime() - (i.hoursAgo ?? 1) * 3600_000).toUTCString();
      const title = i.source ? `${i.title} - ${i.source}` : i.title;
      return `<item><title>${title.replace(/&/g, "&amp;")}</title><link>${i.link}</link><pubDate>${pub}</pubDate>${i.source ? `<source url="https://example.com">${i.source}</source>` : ""}</item>`;
    })
    .join("");
  return `<?xml version="1.0"?><rss><channel><title>feed</title>${body}</channel></rss>`;
}

/** A fetch that answers Google News searches from a map of query -> items. */
export function feeds(byQuery: Record<string, FeedItem[] | number>, now: Date = NOON): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url.href);
    const q = (url.searchParams.get("q") ?? "").replace(/ when:1d$/, "");
    const items = byQuery[q];
    if (typeof items === "number") return new Response("nope", { status: items });
    return new Response(rss(items ?? [], now), { status: 200, headers: { "content-type": "application/rss+xml" } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** DNS stub: every host is a public address, so the net guard lets the fake fetch through. */
export const publicLookup = async () => ["142.250.74.46"];
