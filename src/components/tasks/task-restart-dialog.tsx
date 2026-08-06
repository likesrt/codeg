"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskRequeue, workTaskRetry } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { followUpComposerTarget } from "@/lib/task-follow-up"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TaskFollowUpComposer } from "./task-follow-up-composer"
import type { WorkTask } from "@/lib/types"

export type TaskRestartKind = "retry" | "requeue"

interface TaskRestartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
  /** `retry` for a failed task, `requeue` for a canceled one. */
  kind: TaskRestartKind
}

/**
 * Restart a failed / canceled task from the board, with an optional note for
 * the agent. The drawer can reveal a note box in place; a card has nowhere to
 * unfold one, so the same step happens here.
 *
 * It gets the real composer rather than a textarea for the same reason the
 * drawer's box does: "run pnpm install first" is common, but so is pointing at
 * the file that broke, and `@` references / `/` commands serialize to exactly
 * the string the backend already accepts as the note.
 *
 * Empty is a complete answer — the note is a modifier on the restart, and
 * submitting an untouched box is the plain one-click restart this dialog
 * replaced.
 */
export function TaskRestartDialog({
  open,
  onOpenChange,
  task,
  kind,
}: TaskRestartDialogProps) {
  const t = useTranslations("Tasks")
  // The whole list: a task's worktree is normally not among the open folders.
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { shortcuts } = useShortcutSettings()
  const editorRef = useRef<RichComposerHandle>(null)
  const [text, setText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  /** Synchronous in-flight latch — see `submit`. */
  const submittingRef = useRef(false)

  // A fresh box per open — a note belongs to one restart, not to the next.
  useEffect(() => {
    if (!open) return
    setText("")
    setSubmitting(false)
    submittingRef.current = false
  }, [open, task])

  if (!task) return null

  // No conversation detail on this path (the card never loads one), so the
  // agent resolves from the task's own override → the folder default, the same
  // fallback the drawer runs on before its detail lands.
  const target = followUpComposerTarget({
    task,
    conversationAgentType: null,
    folders: allFolders,
  })

  const submit = async () => {
    // Straight from the editor: reference badges serialize to their inline
    // token here, and this cannot lag a keystroke behind the state.
    const note = (editorRef.current?.getText() ?? text).trim() || null
    // A ref, not `submitting`: the send key is read out of a ref inside the
    // editor's own keydown handler, so a second Enter can arrive before React
    // has re-rendered. The backend's CAS would reject the loser anyway — this
    // keeps it from surfacing as an error toast.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (kind === "retry") await workTaskRetry(task.id, note)
      else await workTaskRequeue(task.id, note)
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    } finally {
      submittingRef.current = false
    }
  }

  const isRetry = kind === "retry"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>
            {isRetry ? t("restartTitleRetry") : t("restartTitleRequeue")}
          </DialogTitle>
          <DialogDescription>{t("restartDescription")}</DialogDescription>
        </DialogHeader>

        <TaskFollowUpComposer
          editorRef={editorRef}
          agentType={target.agentType}
          folderPath={target.folderPath}
          defaultText={text}
          placeholder={
            isRetry
              ? t("followUpPlaceholderRetry")
              : t("followUpPlaceholderRequeue")
          }
          ariaLabel={t("actionAddNote")}
          autoFocus
          submitShortcut={shortcuts.send_message}
          newlineShortcut={shortcuts.newline_in_message}
          onChange={setText}
          onSubmit={() => {
            void submit()
          }}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {isRetry ? t("actionRetry") : t("actionRequeue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
