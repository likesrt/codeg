/**
 * The card's restart dialog obeys the same rule as the drawer's note box: the
 * note is read from the EDITOR when the action fires, never from the render's
 * state (the editor runs ahead of React by a commit), and one submit means one
 * request even when the send key fires twice.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import type { WorkTask } from "@/lib/types"

import { TaskRestartDialog } from "./task-restart-dialog"
import type { TaskFollowUpComposerProps } from "./task-follow-up-composer"

const workTaskRetry = vi.fn().mockResolvedValue(undefined)
const workTaskRequeue = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskRequeue: (...args: unknown[]) => workTaskRequeue(...args),
  workTaskRetry: (...args: unknown[]) => workTaskRetry(...args),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})

/** The composer, stubbed to a handle whose text the test sets directly. */
let editorText = ""
let composerProps: TaskFollowUpComposerProps | null = null
vi.mock("./task-follow-up-composer", () => ({
  TaskFollowUpComposer: (props: TaskFollowUpComposerProps) => {
    composerProps = props
    const ref = props.editorRef
    useEffect(() => {
      if (ref) ref.current = { getText: () => editorText } as RichComposerHandle
      return () => {
        if (ref) ref.current = null
      }
    }, [ref])
    return <div data-testid="restart-composer" />
  },
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "failed",
    worktree_folder_id: null,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask, kind: "retry" | "requeue" = "retry") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskRestartDialog open onOpenChange={() => {}} task={row} kind={kind} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  editorText = ""
  composerProps = null
  vi.clearAllMocks()
})

describe("TaskRestartDialog", () => {
  it("retries with what the editor holds, not what the last render saw", async () => {
    const user = userEvent.setup()
    mount(task())
    // Text the parent's state has not received yet — exactly what a click on
    // the same tick as the keystroke sees.
    editorText = "look at [retry.ts](file:///repo/retry.ts) first"

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(1))
    expect(workTaskRetry).toHaveBeenCalledWith(
      7,
      "look at [retry.ts](file:///repo/retry.ts) first"
    )
  })

  it("requeues with a null note when the box is untouched", async () => {
    const user = userEvent.setup()
    mount(task({ status: "canceled" }), "requeue")
    await user.click(screen.getByRole("button", { name: "Requeue" }))
    await waitFor(() => expect(workTaskRequeue).toHaveBeenCalledTimes(1))
    expect(workTaskRequeue).toHaveBeenCalledWith(7, null)
  })

  it("sends once when the send key fires twice before React catches up", async () => {
    let release: (() => void) | undefined
    workTaskRetry.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve()))
    )
    mount(task())
    editorText = "one restart only"

    await act(async () => {
      composerProps?.onSubmit?.()
      composerProps?.onSubmit?.()
    })
    expect(workTaskRetry).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.()
    })
    expect(workTaskRetry).toHaveBeenCalledTimes(1)
  })
})
