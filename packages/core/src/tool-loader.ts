/**
 * [sunshine:tool-loader] Tools an owner's conversation loads only when a request needs them.
 *
 * Every tool's definition is sent with every message, and the owner's full list (about 18,000
 * tokens) is mostly email, desktop, file and people tools that most messages never touch. These
 * groups stay out of the opening instructions; `load_tools` adds a group for the rest of the
 * conversation, which Pi announces as a mid-conversation tool change, so the cached start of the
 * prompt stays the same. The runtime drops loaded groups again once the cache has gone cold or the
 * history is folded (the moments the start is paid in full anyway). See `runtime.ts` and
 * FORK-CHANGES.md.
 */
import { Type } from "typebox";
import { defineTool, textResult, type RegisteredTool } from "./tools.js";
import type { ToolMeta } from "./types.js";

export const LOAD_TOOLS = "load_tools";

/** The loadable groups, by the `meta.group` of their tools, with what each is for (the model reads this). */
export const LOADABLE_GROUPS = {
  apps: {
    groups: ["apps"],
    about: "email, calendar and other connected apps (Gmail, Google Calendar): read, search and send email, see and change events, check or connect an app",
  },
  computer: {
    groups: ["computer"],
    about: "your Linux desktop with a web browser: open a website, click, type, log in, fill in a form",
  },
  files: {
    groups: ["files"],
    about: "files in your workspace: make a PDF or an image, read, write or edit a file, run a shell command",
  },
  people: {
    groups: ["contacts", "network"],
    about: "the people around the owner: look up or save a contact, set someone as partner, family or friend and what they may know, ask or invite another person's assistant",
  },
} as const satisfies Record<string, { groups: readonly ToolMeta["group"][]; about: string }>;

export type LoadableGroup = keyof typeof LOADABLE_GROUPS;

/** The loadable group a tool's `meta.group` belongs to; undefined for tools that are always there. */
export function loadableGroupOf(group: ToolMeta["group"] | undefined): LoadableGroup | undefined {
  if (!group) return undefined;
  for (const [name, def] of Object.entries(LOADABLE_GROUPS)) {
    if ((def.groups as readonly string[]).includes(group)) return name as LoadableGroup;
  }
  return undefined;
}

/**
 * The tool that loads groups. `present` lists the groups this agent has tools for, in a fixed order,
 * so the description (part of the cached start of the prompt) never changes between messages.
 */
export function loadToolsTool(present: LoadableGroup[]): RegisteredTool {
  const names = present.length > 0 ? present : (Object.keys(LOADABLE_GROUPS) as LoadableGroup[]);
  const lines = names.map((g) => `- ${g}: ${LOADABLE_GROUPS[g].about}`);
  return defineTool({
    name: LOAD_TOOLS,
    label: "Load tools",
    description: [
      "Some of what you can do is kept aside until a request needs it. When one does, load its group first, then carry on: its tools are ready from your next step. If tools you loaded earlier are gone, load them again. Never say you can't do something listed here without loading it first. Loading is invisible to the person; don't mention it.",
      ...lines,
    ].join("\n"),
    parameters: Type.Object({
      groups: Type.Array(Type.Union(names.map((g) => Type.Literal(g))), { minItems: 1, description: "The groups the request needs" }),
    }),
    meta: { capabilities: ["converse"], group: "system", describe: (a) => `load ${((a as { groups?: string[] }).groups ?? []).join(", ")}` },
    execute: async ({ groups }, ctx) => textResult(ctx.loadTools ? ctx.loadTools(groups as LoadableGroup[]) : "Nothing to load here: every tool you may use is already available."),
  });
}
