/**
 * The agent directory: every standing agent's description, listed in every agent's
 * system (see context.ts composeSystem) so an agent knows who to ask for what instead
 * of saying it has no browser or guessing at an owner. Each agent writes its own entry
 * in one template, so every entry reads the same way and any agent can write one.
 */

import { z } from "zod";

/** The longest description an agent may set. */
export const DESCRIPTION_MAX_CHARS = 400;

/** The template every description follows, as the tools that set one show it. */
export const DESCRIPTION_TEMPLATE =
  'Three lines: "Owns: <what you are responsible for>", "Ask for: <what other agents should bring you, with an example or two>", and optionally "Not for: <what looks like yours but goes elsewhere, and to whom>". At most ' +
  `${DESCRIPTION_MAX_CHARS} characters. Example:\nOwns: Every browser and browser worker.\nAsk for: a one-shot browser worker that reaches a site or account you name ("a worker signed in to D2L").\nNot for: doing the web task itself: you give your worker its steps.`;

/** A description in the template: Owns, Ask for, and an optional Not for, one line each. */
export const descriptionSchema = z
  .string()
  .max(DESCRIPTION_MAX_CHARS, `description is at most ${DESCRIPTION_MAX_CHARS} characters`)
  .transform((text) => text.trim().replace(/\r\n/g, "\n"))
  .refine((text) => /^Owns: [^\n]+\nAsk for: [^\n]+(\nNot for: [^\n]+)?$/.test(text), {
    message: `description must follow the template. ${DESCRIPTION_TEMPLATE}`,
  });

/** How much of a charter stands in for an agent that has no description yet. */
const CHARTER_EXCERPT_CHARS = 160;

/** A directory entry's agent. */
export type DirectoryAgent = {
  id: string;
  description: string | null;
  systemPrompt: string;
  parentAgentId: string | null;
};

/**
 * directoryBlock lists `agents` (standing and active, the reader itself left out) for
 * the agent `readerId` (null: the router): each id, marked when it is the reader's parent
 * or child, then its description indented under it, or its charter's opening when it
 * has none yet.
 */
export function directoryBlock(agents: DirectoryAgent[], readerId: string | null, readerParentId: string | null): string {
  const entries = agents
    .filter((agent) => agent.id !== readerId)
    .map((agent) => {
      const mark =
        readerId !== null && agent.parentAgentId === readerId
          ? " (your child)"
          : agent.id === readerParentId
            ? " (your parent)"
            : "";
      const body =
        agent.description ??
        `(no description yet) ${clip(agent.systemPrompt.trim().replace(/\s+/g, " "), CHARTER_EXCERPT_CHARS)}`;
      return `- ${agent.id}${mark}\n${body
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`;
    });
  return [
    "Agent directory: every standing agent and what to bring it. Message the one that owns what you need; workers are not listed (list_agents finds them).",
    ...entries,
  ].join("\n");
}

/**
 * ownDescriptionLine tells an agent its own directory entry, or that it has none yet and
 * how to write one, so each agent keeps its entry true to what it owns.
 */
export function ownDescriptionLine(description: string | null): string {
  return description === null
    ? `You have no directory entry yet, so other agents only see your charter's opening. Set one with modify_agent_prompt's description. ${DESCRIPTION_TEMPLATE}`
    : `Your directory entry, which every agent sees:\n${description}\nWhen what you own changes, update it with modify_agent_prompt's description.`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
