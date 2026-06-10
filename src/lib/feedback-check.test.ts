import { describe, expect, it } from "vitest"

import {
  feedbackCheckHasContent,
  parseFeedbackCheckOutcome,
} from "./feedback-check"

// Real strings captured from a Codex session transcript (the persisted
// `function_call_output` for `check_user_feedback`).
const CODEX_WITH_FEEDBACK =
  'Wall time: 0.0029 seconds\nOutput:\n{"count":1,"feedback":[{"created_at":"2026-06-09T07:47:12.920050Z","text":"还有package"}]}'
const CODEX_NO_FEEDBACK =
  'Wall time: 0.0017 seconds\nOutput:\n{"count":0,"feedback":[]}'

describe("parseFeedbackCheckOutcome", () => {
  it("parses the Codex exec-wrapped envelope with feedback", () => {
    expect(parseFeedbackCheckOutcome(CODEX_WITH_FEEDBACK)).toEqual({
      entries: [
        { createdAt: "2026-06-09T07:47:12.920050Z", text: "还有package" },
      ],
    })
  })

  it("parses the Codex envelope with no feedback as empty entries", () => {
    expect(parseFeedbackCheckOutcome(CODEX_NO_FEEDBACK)).toEqual({
      entries: [],
    })
  })

  it("parses bare structured JSON (no envelope)", () => {
    const out = parseFeedbackCheckOutcome(
      '{"count":2,"feedback":[{"created_at":"2026-06-09T07:47:12Z","text":"a"},{"created_at":"2026-06-09T07:48:00Z","text":"b"}]}'
    )
    expect(out?.entries.map((e) => e.text)).toEqual(["a", "b"])
  })

  it("unwraps a full MCP result nested under structuredContent", () => {
    const out = parseFeedbackCheckOutcome(
      JSON.stringify({
        content: [{ type: "text", text: "The user sent 1 message(s)…" }],
        structuredContent: {
          count: 1,
          feedback: [{ created_at: "2026-06-09T07:47:12Z", text: "hi" }],
        },
        isError: false,
      })
    )
    expect(out).toEqual({
      entries: [{ createdAt: "2026-06-09T07:47:12Z", text: "hi" }],
    })
  })

  it("accepts the createdAt camelCase spelling", () => {
    const out = parseFeedbackCheckOutcome(
      '{"feedback":[{"createdAt":"2026-06-09T07:47:12Z","text":"x"}]}'
    )
    expect(out?.entries[0]).toEqual({
      createdAt: "2026-06-09T07:47:12Z",
      text: "x",
    })
  })

  it("drops notes with empty/whitespace text", () => {
    const out = parseFeedbackCheckOutcome(
      '{"count":2,"feedback":[{"text":"   "},{"created_at":null,"text":"real"}]}'
    )
    expect(out?.entries).toEqual([{ createdAt: null, text: "real" }])
  })

  it("falls back to the human-readable no-feedback text", () => {
    expect(
      parseFeedbackCheckOutcome(
        "No new feedback from the user. Continue with your current plan."
      )
    ).toEqual({ entries: [] })
  })

  it("falls back to parsing the human-readable numbered list", () => {
    const text =
      "The user sent 2 message(s) while you were working. Treat this as high-priority steering.\n1. first note\n2. second note\n"
    expect(parseFeedbackCheckOutcome(text)).toEqual({
      entries: [
        { createdAt: null, text: "first note" },
        { createdAt: null, text: "second note" },
      ],
    })
  })

  it("returns null for in-flight (no output) and unrecognized text", () => {
    expect(parseFeedbackCheckOutcome(null)).toBeNull()
    expect(parseFeedbackCheckOutcome("")).toBeNull()
    expect(parseFeedbackCheckOutcome("   ")).toBeNull()
    expect(parseFeedbackCheckOutcome("some unrelated tool output")).toBeNull()
  })
})

describe("feedbackCheckHasContent", () => {
  it("is true only when notes were received", () => {
    expect(feedbackCheckHasContent(CODEX_WITH_FEEDBACK)).toBe(true)
    expect(feedbackCheckHasContent(CODEX_NO_FEEDBACK)).toBe(false)
    expect(feedbackCheckHasContent(null)).toBe(false)
    expect(feedbackCheckHasContent("No new feedback from the user.")).toBe(
      false
    )
  })
})
