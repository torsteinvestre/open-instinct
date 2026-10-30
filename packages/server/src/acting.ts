/**
 * [sunshine:acting] How Sunshine acts for its owner, the same wherever the work comes from: their own messages, what
 * reaches it from elsewhere (recordings now; email, team chat and other tools later) and its scheduled jobs. One section
 * in the owner's system prompt with the owner's proactivity setting filled in by code, so every conversation of theirs
 * reads the same rule.
 *
 * Until 2026-10-30 the rule was only in a recording's hand-off ([sunshine:in-the-flow], 27 Oct). A text that turned up
 * something to do got "Want me to add it?" (live, 30 Oct: Founders Story found in his email, not in his calendar), and
 * the setting did nothing for texts. Torstein: one rule for everything Sunshine does, written to hold for sources and
 * tools still to come. So it is criteria, not cases (the act-or-ask principle, NOTES 2026-10-24): how clearly it is
 * theirs, what a mistake would cost, whether it can be undone, who else it touches, how sure the source is. Judgment
 * stays with the model; the hard limits stay in the policy engine.
 *
 * The first test (2026-10-30, look-before-ask.mjs SET=acting) passed every case but the one it was built for: found
 * while answering a question, Founders Story was still offered ("Want me to add it?"), 0/2. The rule had no reason in
 * it; Anthropic's prompting guide advises giving the motivation behind an instruction, so the "Why:" line was added.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, textResult, type InstinctConfig, type Principal, type RegisteredTool, type StateDir } from "@open-instinct/core";

/**
 * How much the owner wants done on Sunshine's own initiative (decided with Torstein 2026-10-27; clutter, not only safety,
 * sets the line, and real use tunes it). Going to other people, costing money and speaking for the owner always ask
 * first, whatever the setting. Moved here from intake.ts ([sunshine:in-the-flow]) with the rule it sets.
 */
export const PROACTIVITY_LEVELS = ["ask first", "prepare and offer", "just do it"] as const;
export type Proactivity = (typeof PROACTIVITY_LEVELS)[number];
export const DEFAULT_PROACTIVITY: Proactivity = "prepare and offer";
const PROACTIVITY_FILE = "proactivity.json";

export function readProactivity(state: StateDir): Proactivity {
  const level = state.readJson<{ level?: string }>(PROACTIVITY_FILE, {}).level;
  return (PROACTIVITY_LEVELS as readonly string[]).includes(level ?? "") ? (level as Proactivity) : DEFAULT_PROACTIVITY;
}

/** The owner sets how much Sunshine does on its own, in words, until the app has a setting. */
export function proactivityTool(state: StateDir, config: InstinctConfig): RegisteredTool {
  const owner = config.owner.name;
  return defineTool({
    name: "proactivity",
    label: "How much to do on your own",
    description:
      `How much ${owner} wants you to do for them on your own, in everything you do for them. Set it when they tell you: ` +
      `"ask first" (ask before doing anything for them), "prepare and offer" (do small things that are easy to undo, prepare bigger work and offer it; the default), ` +
      `"just do it" (do what is clearly theirs and tell them). Anything that goes to other people, costs money or speaks for ${owner} is asked first at every level. Without a level it says the current one.`,
    parameters: Type.Object({ level: Type.Optional(Type.Union(PROACTIVITY_LEVELS.map((l) => Type.Literal(l)))) }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `proactivity: ${String((a as { level?: unknown }).level ?? "read")}` },
    execute: async ({ level }) => {
      if (!level) return textResult(`Now: ${readProactivity(state)}.`);
      state.writeJson(PROACTIVITY_FILE, { level, at: new Date().toISOString() });
      return textResult(`Set: ${level}.`);
    },
  });
}

/** Where doing ends and offering or asking starts, by the setting. */
const DOING: Record<Proactivity, (owner: string) => string> = {
  "prepare and offer": (o) => `Do what is clearly ${o}'s and easy to undo (their own calendar, a reminder) and tell them in one line what you did. For bigger work (a document, a deck, research), prepare the cheap part (what you know, an outline) and offer once to do the rest.`,
  "ask first": (o) => `Ask before you do anything for ${o}: gather what you know and can find, then ask in one message, saying what you would do.`,
  "just do it": (o) => `Do what is clearly ${o}'s (their own calendar, reminders, documents, decks, research) and tell them in one line what you did; offer first only a big piece of work they may not want.`,
};

/** The section in the owner's system prompt: fixed text for a given setting, so the prompt stays the same between messages. */
export function actingSection(owner: string, level: Proactivity): string {
  return [
    `# How you act for ${owner}`,
    `The same in everything you do for ${owner}: their messages, what reaches you from elsewhere (recordings, email, other tools) and your scheduled work.`,
    // The motivation, so the criteria carry to cases nobody wrote down (Anthropic's prompting guide: give the why).
    `Why: ${owner} wants to hand things off, not manage you. A question they have to answer costs them more than a step they can easily undo, and a wrong step towards other people, their money or their name costs more than a question.`,
    `- Find out before you ask. Use what you know and what you can look up (their email, calendar, earlier conversations, the web) before asking ${owner} anything, and check how things stand before you change them (the calendar before adding to it). Ask only what is still unclear after that, all in one message.`,
    `- Weigh each step: how clearly it is ${owner}'s and what they want, what a mistake would cost them, and whether it can be undone.`,
    `- ${owner}'s setting is "${level}". ${DOING[level](owner)}`,
    `- How sure the source is counts. What ${owner} typed is what they said; something heard in a recording or read in someone else's message may be another person's, a passing thought or misheard, so act on it only when it is clearly ${owner}'s.`,
    `- Anything that goes to other people, costs money or speaks for ${owner}: ask first, whatever the setting.`,
    `- On your own initiative, tell ${owner} only what is worth their attention.`,
  ].join("\n");
}

/** Only the owner's own conversations get it: the verified owner, not an email from their address (tier partner). */
export function actingPromptFor(principal: Principal, owner: string, level: () => Proactivity): string[] {
  return principal.kind === "owner" && principal.tier === "owner" ? [actingSection(owner, level())] : [];
}
