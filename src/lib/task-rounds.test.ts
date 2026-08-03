import { describe, expect, it } from "vitest"
import {
  extractRounds,
  firstTextOfParts,
  matchRoundKind,
} from "@/lib/task-rounds"
import type { WorkTaskEvent } from "@/lib/types"

function event(
  id: number,
  kind: string,
  payload: Record<string, unknown> | null
): WorkTaskEvent {
  return {
    id,
    task_id: 1,
    kind,
    actor: "engine",
    payload,
    created_at: "2026-08-01T00:00:00Z",
  }
}

describe("extractRounds", () => {
  it("keeps only well-formed round events, in order", () => {
    const rounds = extractRounds([
      event(1, "created", null),
      event(2, "round", { kind: "work", prompt_head: "Fix the login flow" }),
      event(3, "status_changed", { to: "running" }),
      event(4, "round", { kind: "merge", prompt_head: "The user accepted" }),
      // Malformed markers are dropped.
      event(5, "round", { prompt_head: "no kind" }),
      event(6, "round", { kind: "retry", prompt_head: "   " }),
    ])
    expect(rounds).toEqual([
      { kind: "work", promptHead: "Fix the login flow" },
      { kind: "merge", promptHead: "The user accepted" },
    ])
  })
})

describe("matchRoundKind", () => {
  const rounds = extractRounds([
    event(1, "round", { kind: "work", prompt_head: "Fix the login flow and" }),
    event(2, "round", {
      kind: "return",
      prompt_head: "The user reviewed your work on this task",
    }),
    event(3, "round", {
      kind: "merge",
      prompt_head: "The user accepted this task — land it onto",
    }),
  ])

  it("labels a turn whose text starts with a round's prompt head", () => {
    expect(matchRoundKind(rounds, "Fix the login flow and add tests.")).toBe(
      "work"
    )
    expect(
      matchRoundKind(
        rounds,
        "The user accepted this task — land it onto the base branch `main` now"
      )
    ).toBe("merge")
  })

  it("is whitespace-insensitive (prompts re-wrap across surfaces)", () => {
    expect(
      matchRoundKind(
        rounds,
        "The user reviewed  your work\non this task: fix X"
      )
    ).toBe("return")
  })

  it("returns null for unmatched or empty text", () => {
    expect(matchRoundKind(rounds, "A manual steering message")).toBeNull()
    expect(matchRoundKind(rounds, "   ")).toBeNull()
    expect(matchRoundKind([], "Fix the login flow and more")).toBeNull()
  })
})

describe("firstTextOfParts", () => {
  it("returns the first text part and skips non-text parts", () => {
    expect(
      firstTextOfParts([
        { type: "tool_call" },
        { type: "text", text: "hello" },
        { type: "text", text: "second" },
      ])
    ).toBe("hello")
    expect(firstTextOfParts([{ type: "image" }])).toBe("")
  })
})
