import type {
  AgentSkillItem,
  AvailableCommandInfo,
  ExpertListItem,
} from "@/lib/types"

import type { ReferenceAttrs } from "./types"

/**
 * Builders that turn a runtime command / skill / expert into the inline
 * `reference` badge the composer embeds (refType `skill`). They carry no `uri`,
 * so on send `referenceToMarkdown` serializes them to their literal invocation
 * token `${prefix}${id}` — `/command`, `$skill`, `/expert` — exactly the text
 * the agent CLI executes. `meta.invocationPrefix` drives that prefix.
 * `meta.scope === "expert"` is kept for the editor's expert-replace logic; all
 * three render the same command-glyph badge (they aren't distinguished).
 */

export type InvocationPrefix = "/" | "$"

/** A `/`-triggered ACP slash command → command badge (always `/name`). */
export function commandToReference(cmd: AvailableCommandInfo): ReferenceAttrs {
  return {
    refType: "skill",
    id: cmd.name,
    label: cmd.name,
    uri: null,
    meta: { invocationPrefix: "/" },
  }
}

/** A `/`- or `$`-triggered agent skill → skill badge (`${prefix}${id}`). */
export function skillToReference(
  skill: AgentSkillItem,
  prefix: InvocationPrefix
): ReferenceAttrs {
  return {
    refType: "skill",
    id: skill.id,
    label: skill.name || skill.id,
    uri: null,
    meta: { invocationPrefix: prefix, scope: skill.scope },
  }
}

/**
 * An expert (built-in or agent-linked) → expert badge. `label` is the
 * already-localized display name (the caller resolves it the same way the expert
 * menu does, so the badge reads identically to the row that was clicked).
 */
export function expertToReference(
  expert: ExpertListItem,
  prefix: InvocationPrefix,
  label: string
): ReferenceAttrs {
  return {
    refType: "skill",
    id: expert.metadata.id,
    label: label || expert.metadata.id,
    uri: null,
    meta: { invocationPrefix: prefix, scope: "expert" },
  }
}
