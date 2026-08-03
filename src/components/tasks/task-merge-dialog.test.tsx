import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskFolderSettings } from "@/lib/types"

const mergeMock = vi.fn().mockResolvedValue(undefined)
const settingsMock = vi.fn()

vi.mock("@/lib/api", () => ({
  workTaskMerge: (...args: unknown[]) => mergeMock(...args),
  workTaskSettingsEffective: (...args: unknown[]) => settingsMock(...args),
}))

import { TaskMergeDialog } from "./task-merge-dialog"

function task(): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
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
    files_changed: 2,
    additions: 10,
    deletions: 3,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
  }
}

function settings(
  overrides?: Partial<WorkTaskFolderSettings>
): WorkTaskFolderSettings {
  return {
    default_agent_type: null,
    mode_id: null,
    config_values: {},
    auto_process: false,
    max_concurrent: 2,
    merge_strategy: "squash",
    delete_worktree_default: true,
    ...overrides,
  }
}

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskMergeDialog open onOpenChange={() => {}} task={task()} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mergeMock.mockClear()
  settingsMock.mockReset()
})

describe("TaskMergeDialog", () => {
  it("defaults to an agent-written message and passes null on submit", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    // Auto-message on by default → no textarea, message goes out as null.
    expect(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    ).toBeChecked()
    expect(screen.queryByLabelText("Commit message")).toBeNull()
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete worktree after merge/ })
      ).toBeChecked()
    )

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith(7, null, true))
  })

  it("unchecking auto reveals the title-prefilled message and sends it", async () => {
    settingsMock.mockResolvedValue(settings({ delete_worktree_default: false }))
    renderDialog()

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Delete worktree after merge/ })
      ).not.toBeChecked()
    )
    await userEvent.click(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    )
    const message = await screen.findByLabelText("Commit message")
    expect((message as HTMLTextAreaElement).value).toBe("Fix login")

    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    await waitFor(() =>
      expect(mergeMock).toHaveBeenCalledWith(7, "Fix login", false)
    )
  })

  it("refuses to submit a manual empty message", async () => {
    settingsMock.mockResolvedValue(settings())
    renderDialog()

    await userEvent.click(
      screen.getByRole("checkbox", { name: /write the commit message/ })
    )
    const message = await screen.findByLabelText("Commit message")
    await userEvent.clear(message)
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled()
    expect(mergeMock).not.toHaveBeenCalled()
  })
})
