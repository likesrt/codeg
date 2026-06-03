import { describe, expect, it } from "vitest"

import { extractLatestPlanEntriesFromMessages } from "./agent-plan"
import type { AdaptedMessage } from "@/lib/adapters/ai-elements-adapter"

describe("extractLatestPlanEntriesFromMessages", () => {
  it("finds plan updates nested inside a goal run", () => {
    const messages: AdaptedMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        timestamp: "2026-06-02T00:00:00.000Z",
        content: [
          {
            type: "goal-run",
            start: {
              type: "tool-call",
              toolCallId: "create-goal",
              toolName: "create_goal",
              input: JSON.stringify({ objective: "Analyze README" }),
              state: "output-available",
            },
            end: null,
            items: [
              {
                type: "tool-call",
                toolCallId: "plan",
                toolName: "update_plan",
                input: JSON.stringify({
                  plan: [{ content: "Read README", status: "completed" }],
                }),
                state: "output-available",
              },
            ],
            isRunning: true,
          },
        ],
      },
    ]

    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      {
        content: "Read README",
        status: "completed",
        priority: "medium",
      },
    ])
  })
})
