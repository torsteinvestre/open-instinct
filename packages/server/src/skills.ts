/**
 * SKILL.md playbooks. The repo ships a `skills/` folder; the Docker image copies it
 * to /app/skills. Loading is best effort: a missing folder means no skills section.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { defineTool, textResult, type RegisteredTool } from "@open-instinct/core";

export interface ResolveSkillsDirOptions {
  explicit?: string;
  env: NodeJS.ProcessEnv;
  /** `import.meta.url` of the calling module, used to find `<repo>/skills` relative to the package. */
  packageUrl?: string;
}

/** Explicit option, then INSTINCT_SKILLS_DIR, then `<repo>/skills` next to this package. */
export function resolveSkillsDir(opts: ResolveSkillsDirOptions): string | undefined {
  const candidates: string[] = [];
  if (opts.explicit) candidates.push(opts.explicit);
  if (opts.env.INSTINCT_SKILLS_DIR) candidates.push(opts.env.INSTINCT_SKILLS_DIR);
  if (opts.packageUrl) {
    // packages/server/{src,dist}/skills.js -> ../../../skills = <repo>/skills
    try {
      candidates.push(fileURLToPath(new URL("../../../skills", opts.packageUrl)));
    } catch {
      /* not a file URL; skip */
    }
  }
  return candidates.find(isDir);
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Skills in `dir`, or an empty list when the folder is missing or unreadable. */
export function loadSkillList(dir: string | undefined, logger?: (m: string) => void): Skill[] {
  if (!dir || !isDir(dir)) return [];
  try {
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "open-instinct" });
    for (const d of diagnostics) logger?.(`skill warning: ${JSON.stringify(d)}`);
    // load_skill looks skills up by lowercased name, so two names that differ only in case
    // would shadow each other. Keep the first and say so.
    const seen = new Set<string>();
    const unique = skills.filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) {
        logger?.(`skill warning: duplicate name "${s.name}" at ${s.filePath} ignored`);
        return false;
      }
      seen.add(key);
      return true;
    });
    if (unique.length > 0) logger?.(`loaded ${unique.length} skills from ${dir}`);
    return unique;
  } catch (err) {
    logger?.(`skills not loaded from ${dir}: ${(err as Error).message}`);
    return [];
  }
}

export const LOAD_SKILL_TOOL = "load_skill";

/**
 * The skills index for the prompt. It points at load_skill rather than Pi's default
 * of the read tool: read is confined to workspace/ and is owner-only, so a skill
 * path outside the workspace could never be opened, and nobody but the owner could
 * open one at all.
 */
export function formatSkillsIndex(skills: Skill[]): string | undefined {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return undefined;
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    `When a task matches a skill's description, call ${LOAD_SKILL_TOOL} with its name and follow what it says.`,
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>", `    <name>${escapeXml(s.name)}</name>`, `    <description>${escapeXml(s.description)}</description>`, "  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Prompt section listing the skills, or undefined when there is nothing to show. */
export function loadSkillsPrompt(dir: string | undefined, logger?: (m: string) => void): string | undefined {
  return formatSkillsIndex(loadSkillList(dir, logger));
}

/**
 * [sunshine:onboarding] One skill's instructions without the header (name, description) and HTML
 * comments, for handing to the model directly; undefined when the skill is missing or unreadable.
 */
export function skillGuide(skills: Skill[], name: string): string | undefined {
  const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return undefined;
  try {
    const text = readFileSync(skill.filePath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replace(/<!--[\s\S]*?-->\s*/g, "").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns one skill's SKILL.md by name. Only skills found at boot can be named, so the
 * model never supplies a path. Skills are playbooks shipped with the agent, not owner
 * data, so any principal who may converse may load one.
 */
export function loadSkillTool(skills: Skill[]): RegisteredTool {
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  return defineTool({
    name: LOAD_SKILL_TOOL,
    label: "Load skill",
    description: "Load the full instructions of a skill listed in <available_skills>, by its name.",
    parameters: Type.Object({ name: Type.String({ description: "The skill's name, as listed in <available_skills>." }) }),
    meta: { capabilities: ["converse"], group: "system", describe: (args) => `${LOAD_SKILL_TOOL} ${String((args as { name?: unknown }).name ?? "")}` },
    execute: async ({ name }) => {
      const skill = byName.get(name.trim().toLowerCase());
      if (!skill) {
        const known = [...byName.values()].map((s) => s.name).join(", ") || "none";
        return { content: [{ type: "text", text: `No skill named "${name}". Known skills: ${known}.` }], isError: true };
      }
      return textResult(readFileSync(skill.filePath, "utf8"));
    },
  });
}
