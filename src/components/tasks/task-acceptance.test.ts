import { describe, expect, it } from "vitest"
import type { WorkTask } from "@/lib/types"
import { hasNothingToMerge } from "./task-acceptance"

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Answer the question",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: 3,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 0,
    additions: 0,
    deletions: 0,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

describe("hasNothingToMerge", () => {
  it("is true for a reviewed task whose diff came back empty", () => {
    expect(hasNothingToMerge(task())).toBe(true)
  })

  it("is false once anything changed", () => {
    expect(hasNothingToMerge(task({ files_changed: 1 }))).toBe(false)
  })

  it("keeps merge as the default when the stats are unknown", () => {
    // `null` = the engine could not read the worktree, NOT "nothing changed".
    expect(hasNothingToMerge(task({ files_changed: null }))).toBe(false)
  })

  it("only speaks for tasks that are actually up for review", () => {
    expect(hasNothingToMerge(task({ status: "running" }))).toBe(false)
    expect(hasNothingToMerge(task({ status: "done" }))).toBe(false)
  })
})
