import type { Capability, RegisteredTool, ToolContext, ToolMeta, ToolResultLike, ToolSpec } from "@open-instinct/core";
import { toLlmContent, type CallToolResult, type Tool as McpTool } from "@earendil-works/pi-mcp";
import { Type, type TSchema } from "typebox";
import { capabilitiesForMultiExecute, capabilitiesForSlug, isReadSlug } from "./capabilities.js"; // [sunshine:action-log] isReadSlug

/** The slice of pi-mcp's McpClient this package needs. Narrow so tests can stub it. */
export interface McpToolSource {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export const TOOL_NAME_PREFIX = "app_";
const MAX_TOOL_NAME = 64;

/** Providers accept `[A-Za-z0-9_-]{1,64}`. Composio slugs are upper snake case; we lower them. */
export function toolNameFor(slug: string): string {
  const base = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return (TOOL_NAME_PREFIX + base).slice(0, MAX_TOOL_NAME);
}

/** Short description of a call for the audit log. Never includes bodies longer than a line. */
export function describeCall(slug: string, args: unknown): string {
  const text = safeJson(args);
  return text.length > 160 ? `${slug} ${text.slice(0, 157)}...` : `${slug} ${text}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** JSON Schema from MCP as a TypeBox schema. Providers want an object with `properties`. */
export function parametersFor(inputSchema: Record<string, unknown>): TSchema {
  const properties = (inputSchema.properties as Record<string, unknown> | undefined) ?? {};
  return Type.Unsafe({ ...inputSchema, type: "object", properties });
}

export function metaFor(slug: string, capabilities: Capability[] = capabilitiesForSlug(slug)): ToolMeta {
  // [sunshine:app-permissions] The generic executor is offered to everyone who may use apps, and each
  // call is judged by the actions it runs, as those actions would be as direct tools.
  if (slug === MULTI_EXECUTE) {
    return { capabilities: ["apps.use"], capabilitiesFor: capabilitiesForMultiExecute, group: "apps", describe: describeMultiExecute };
  }
  return {
    capabilities,
    group: "apps",
    describe: (args) => describeCall(slug, args),
  };
}

const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** [sunshine:app-permissions] The actions a multi-execute call runs, as an approval or the audit log shows them. */
function describeMultiExecute(args: unknown): string {
  const tools = (args as { tools?: unknown } | null | undefined)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return describeCall(MULTI_EXECUTE, args);
  return tools.map((t) => describeCall(String((t as { tool_slug?: unknown } | null)?.tool_slug ?? "?"), (t as { arguments?: unknown } | null)?.arguments ?? {})).join("; ");
}

/**
 * [sunshine:action-log] The app actions a tool call runs that change something (not reads, not Composio's own tools),
 * as Composio slugs: one for a direct tool, each listed one for the multi-executor. Empty for every other tool.
 */
export function appChangesOf(toolName: string, args: unknown): string[] {
  if (!toolName.startsWith(TOOL_NAME_PREFIX)) return [];
  const slug = toolName.slice(TOOL_NAME_PREFIX.length).toUpperCase();
  const tools = slug === MULTI_EXECUTE ? (args as { tools?: unknown } | null | undefined)?.tools : [{ tool_slug: slug }];
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => String((t as { tool_slug?: unknown } | null)?.tool_slug ?? "").trim().toUpperCase())
    .filter((s) => s && !s.startsWith("COMPOSIO_") && !isReadSlug(s));
}

// [sunshine:app-permissions] Upstream's note said the guard could not check the tools one by one.
const MULTI_EXECUTE_NOTE = " Each tool in the list is checked against what the person you act for may do.";

/** Wrap one MCP tool as an Open Instinct RegisteredTool. */
export function wrapMcpTool(source: McpToolSource, tool: McpTool): RegisteredTool {
  const slug = tool.name;
  const upper = slug.toUpperCase();
  const description = (tool.description ?? slug) + (upper === MULTI_EXECUTE ? MULTI_EXECUTE_NOTE : "");

  const spec: ToolSpec<TSchema> = {
    name: toolNameFor(slug),
    label: tool.title ?? slug,
    description,
    parameters: parametersFor(tool.inputSchema),
    meta: metaFor(upper),
    execute: async (args, _ctx: ToolContext, signal?: AbortSignal): Promise<ToolResultLike> => {
      const result = await source.callTool(slug, (args ?? {}) as Record<string, unknown>, { signal });
      // MCP reports tool failures inside the result rather than as protocol errors.
      return { content: toLlmContent(result), details: result.structuredContent, isError: result.isError === true };
    },
  };
  // RegisteredTool is `{ spec }`; building it directly keeps this package free of
  // runtime imports from core, so it loads before core is built.
  return { spec };
}

/** Wrap every tool the MCP server lists. Names that collide after clipping keep the first one. */
export async function wrapMcpTools(source: McpToolSource): Promise<RegisteredTool[]> {
  const tools = await source.listTools();
  const seen = new Set<string>();
  const out: RegisteredTool[] = [];
  for (const tool of tools) {
    const wrapped = wrapMcpTool(source, tool);
    if (seen.has(wrapped.spec.name)) continue;
    seen.add(wrapped.spec.name);
    out.push(wrapped);
  }
  return out;
}
