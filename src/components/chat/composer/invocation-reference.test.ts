import { describe, expect, it } from "vitest"

import type {
  AgentSkillItem,
  AvailableCommandInfo,
  ExpertListItem,
} from "@/lib/types"

import {
  commandToReference,
  expertToReference,
  skillToReference,
} from "./invocation-reference"
import { referenceToMarkdown } from "./reference-text"

const cmd = (name: string): AvailableCommandInfo => ({
  name,
  description: `${name} command`,
})

const skill = (id: string, name: string): AgentSkillItem =>
  ({
    id,
    name,
    scope: "project",
    layout: "markdown_file",
    path: `/skills/${id}.md`,
    description: "desc",
    read_only: false,
  }) as AgentSkillItem

const expert = (id: string): ExpertListItem => ({
  metadata: {
    id,
    category: "review",
    icon: null,
    sort_order: 0,
    display_name: { en: id },
    description: { en: `${id} desc` },
    bundled_hash: "h",
  },
  installed_centrally: true,
  user_modified: false,
  central_path: `/experts/${id}`,
})

describe("commandToReference", () => {
  it("builds a skill-kind reference that serializes to /name", () => {
    const ref = commandToReference(cmd("build"))
    expect(ref).toEqual({
      refType: "skill",
      id: "build",
      label: "build",
      uri: null,
      meta: { invocationPrefix: "/" },
    })
    expect(referenceToMarkdown(ref)).toBe("/build")
  })
})

describe("skillToReference", () => {
  it("uses the `$` prefix for a Codex skill and keeps the friendly label", () => {
    const ref = skillToReference(skill("deploy", "Deploy"), "$")
    expect(ref).toMatchObject({
      refType: "skill",
      id: "deploy",
      label: "Deploy",
      uri: null,
      meta: { invocationPrefix: "$", scope: "project" },
    })
    // Serialization uses the id, not the label.
    expect(referenceToMarkdown(ref)).toBe("$deploy")
  })

  it("uses the `/` prefix for a non-Codex skill", () => {
    expect(referenceToMarkdown(skillToReference(skill("x", "X"), "/"))).toBe(
      "/x"
    )
  })

  it("falls back to the id when the skill has no name", () => {
    expect(skillToReference(skill("only-id", ""), "/").label).toBe("only-id")
  })
})

describe("expertToReference", () => {
  it("builds an expert badge (scope=expert) with the given localized label", () => {
    const ref = expertToReference(expert("reviewer"), "$", "审查员")
    expect(ref).toEqual({
      refType: "skill",
      id: "reviewer",
      label: "审查员",
      uri: null,
      meta: { invocationPrefix: "$", scope: "expert" },
    })
    expect(referenceToMarkdown(ref)).toBe("$reviewer")
  })

  it("falls back to the id when the label is empty", () => {
    expect(expertToReference(expert("reviewer"), "/", "").label).toBe(
      "reviewer"
    )
  })
})
