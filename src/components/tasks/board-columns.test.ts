import { describe, expect, it } from "vitest"
import { columnForStatus, groupTasksByColumn } from "./board-columns"
import type { WorkTask, WorkTaskStatus } from "@/lib/types"

function task(
  id: number,
  status: WorkTaskStatus,
  extra?: Partial<WorkTask>
): WorkTask {
  return {
    id,
    folder_id: 1,
    title: `t${id}`,
    config: null,
    status,
    failure_reason: null,
    last_error: null,
    run_seq: 0,
    sort_order: id,
    worktree_folder_id: null,
    conversation_id: null,
    connection_id: null,
    base_branch: null,
    base_sha: null,
    work_branch: null,
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: null,
    additions: null,
    deletions: null,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...extra,
  }
}

describe("columnForStatus", () => {
  it("maps every DB status to its board column per the spec", () => {
    // 待办 = todo + queued
    expect(columnForStatus("todo")).toBe("todo")
    expect(columnForStatus("queued")).toBe("todo")
    // 进行中 = running
    expect(columnForStatus("running")).toBe("inProgress")
    // 等你处理 = awaiting_input + review + merging + failed — a merge is an
    // agent turn but the card stays in the review column until it lands.
    expect(columnForStatus("awaiting_input")).toBe("attention")
    expect(columnForStatus("review")).toBe("attention")
    expect(columnForStatus("merging")).toBe("attention")
    expect(columnForStatus("failed")).toBe("attention")
    // 已完成 = done (+ canceled behind the toggle)
    expect(columnForStatus("done")).toBe("done")
    expect(columnForStatus("canceled")).toBe("done")
  })
})

describe("groupTasksByColumn", () => {
  it("hides canceled tasks unless the toggle is on", () => {
    const tasks = [task(1, "todo"), task(2, "canceled")]
    const hidden = groupTasksByColumn(tasks, false)
    expect(hidden.done).toHaveLength(0)
    const shown = groupTasksByColumn(tasks, true)
    expect(shown.done.map((t) => t.id)).toEqual([2])
  })

  it("keeps board order within columns and sorts done before canceled", () => {
    const tasks = [
      task(1, "queued"),
      task(2, "todo"),
      task(3, "canceled", { finished_at: "2026-08-01T03:00:00Z" }),
      task(4, "done", { finished_at: "2026-08-01T01:00:00Z" }),
      task(5, "done", { finished_at: "2026-08-01T02:00:00Z" }),
    ]
    const grouped = groupTasksByColumn(tasks, true)
    expect(grouped.todo.map((t) => t.id)).toEqual([1, 2])
    // done first (freshest first), canceled last even though it finished later.
    expect(grouped.done.map((t) => t.id)).toEqual([5, 4, 3])
  })

  it("hides archived tasks unless the archive toggle is on", () => {
    const tasks = [
      task(1, "done", { archived_at: "2026-08-01T01:00:00Z" }),
      task(2, "failed", { archived_at: "2026-08-01T01:00:00Z" }),
      task(3, "done"),
    ]
    const hidden = groupTasksByColumn(tasks, false)
    expect(hidden.done.map((t) => t.id)).toEqual([3])
    expect(hidden.attention).toHaveLength(0)
    const shown = groupTasksByColumn(tasks, false, true)
    expect(shown.done.map((t) => t.id)).toEqual([1, 3])
    expect(shown.attention.map((t) => t.id)).toEqual([2])
  })
})
