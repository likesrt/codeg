import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"
import { TaskCard } from "./task-card"

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
    conversation_id: null,
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

function renderCard(
  t: WorkTask,
  handlers: { onMerge: () => void; onComplete: () => void }
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskCard
        task={t}
        folderName="repo"
        now={Date.parse("2026-08-01T01:00:00Z")}
        onOpen={() => {}}
        onStart={() => {}}
        onCancel={() => {}}
        onRetry={() => {}}
        onRequeue={() => {}}
        onViewSession={() => {}}
        onArchive={() => {}}
        onEdit={() => {}}
        {...handlers}
      />
    </NextIntlClientProvider>
  )
}

describe("TaskCard review primary", () => {
  it("offers completion — not a merge — when the task changed nothing", async () => {
    const onMerge = vi.fn()
    const onComplete = vi.fn()
    renderCard(task(), { onMerge, onComplete })

    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onMerge).not.toHaveBeenCalled()
  })

  it("keeps the merge button once the task changed something", () => {
    const onMerge = vi.fn()
    const onComplete = vi.fn()
    renderCard(task({ files_changed: 3, additions: 20, deletions: 1 }), {
      onMerge,
      onComplete,
    })

    expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull()
  })
})
