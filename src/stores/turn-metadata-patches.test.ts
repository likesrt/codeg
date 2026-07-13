import { describe, expect, it } from "vitest"
import { computeTurnMetadataPatches } from "@/stores/conversation-runtime-store"
import type { MessageTurn, TurnUsage } from "@/lib/types"

// The post-turn reparse (`syncTurnMetadata`) backfills usage/duration/model
// onto this session's completed local turns by aligning them to a fresh parse.
// The parse contains persisted history + this session's turns; only the tail
// past `persistedAssistantCount` may align to `localTurns`. These tests pin the
// history anchor — without it, resuming a conversation folded every prior
// turn's stats into the first new reply (first reply after resume showed the
// SUM of all durations; second reply onward was correct; a full reload fixed
// every reply because it renders parsed turns directly).

function usage(input: number, output = 0): TurnUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function asst(over: Partial<MessageTurn>): MessageTurn {
  return {
    id: "a",
    role: "assistant",
    blocks: [],
    timestamp: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("computeTurnMetadataPatches", () => {
  it("does not fold historical turns' stats into the first reply after resume", () => {
    // Resume a conversation with 3 historical assistant turns (in `detail`),
    // then send one prompt. localTurns = [user, assistant] → assistant at 1.
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
      asst({ id: "new", duration_ms: 1234, usage: usage(50) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
    })

    // The new reply gets ITS OWN duration/usage — not 1234 + 5000+7000+9000.
    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 1234,
        usage: usage(50),
        model: undefined,
        completed_at: undefined,
      },
    ])
  })

  it("folds extra parser sub-turns into local[0] when there is no history", () => {
    // Fresh conversation: the parser split one live reply into 3 sub-turns,
    // but the live stream produced a single assistant turn (index 0). Their
    // stats must sum so the post-stream total matches a fresh reload.
    const parsedAssistantTurns = [
      asst({ id: "s0", duration_ms: 1000, usage: usage(10, 1) }),
      asst({ id: "s1", duration_ms: 2000, usage: usage(20, 2) }),
      asst({
        id: "s2",
        duration_ms: 3000,
        usage: usage(30, 3),
        model: "gpt-x",
        completed_at: "2026-01-01T00:05:00Z",
      }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [0],
      parsedAssistantTurns,
      persistedAssistantCount: 0,
    })

    expect(patches).toEqual([
      {
        index: 0,
        duration_ms: 6000,
        usage: usage(60, 6),
        model: "gpt-x",
        // Completion time is the matched (last) sub-turn's, not aggregated.
        completed_at: "2026-01-01T00:05:00Z",
      },
    ])
  })

  it("folds only this session's sub-turns after resume, never history", () => {
    // Resume (3 historical), then a reply the parser split into 2 sub-turns
    // while the live stream produced a single assistant turn (index 1).
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
      asst({ id: "n0", duration_ms: 400, usage: usage(4) }),
      asst({ id: "n1", duration_ms: 600, usage: usage(6), model: "m" }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
    })

    // 400 + 600 = 1000 (only n0 + n1), usage 4 + 6 = 10 — history excluded.
    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 1000,
        usage: usage(10),
        model: "m",
        completed_at: undefined,
      },
    ])
  })

  it("emits no patch when the parse has not caught up to the new reply", () => {
    // The turn completed but the transcript hasn't flushed the new reply yet:
    // the parse only has the 3 historical turns. Rather than mapping the new
    // local turn onto the last historical parsed turn (the original bug — a
    // non-null usage there also suppressed the retry, locking a wrong value),
    // emit nothing so the caller's retry picks up the complete parse.
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000, usage: usage(100) }),
      asst({ id: "h1", duration_ms: 7000, usage: usage(200) }),
      asst({ id: "h2", duration_ms: 9000, usage: usage(300) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 3,
    })

    expect(patches).toEqual([])
  })

  it("maps each resumed reply to its own parsed turn (second reply onward)", () => {
    // Two prompts after resume: localTurns = [u1, a1, u2, a2].
    const parsedAssistantTurns = [
      asst({ id: "h0", duration_ms: 5000 }),
      asst({ id: "h1", duration_ms: 7000 }),
      asst({ id: "a1", duration_ms: 111, usage: usage(11) }),
      asst({ id: "a2", duration_ms: 222, usage: usage(22) }),
    ]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns,
      persistedAssistantCount: 2,
    })

    expect(patches).toEqual([
      {
        index: 1,
        duration_ms: 111,
        usage: usage(11),
        model: undefined,
        completed_at: undefined,
      },
      {
        index: 3,
        duration_ms: 222,
        usage: usage(22),
        model: undefined,
        completed_at: undefined,
      },
    ])
  })

  it("clamps an over-count boundary instead of slicing past the parse", () => {
    // Defensive: if `detail` momentarily reports more assistant turns than the
    // fresh parse (e.g. a transient in-flight partial), the clamp keeps the
    // slice empty rather than going negative — no patch, safe retry.
    const parsedAssistantTurns = [asst({ id: "n0", duration_ms: 400 })]

    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1],
      parsedAssistantTurns,
      persistedAssistantCount: 5,
    })

    expect(patches).toEqual([])
  })
})
