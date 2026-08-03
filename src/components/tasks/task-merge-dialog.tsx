"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskMerge, workTaskSettingsEffective } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { WorkTask } from "@/lib/types"

interface TaskMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/**
 * Accept a reviewed task. The merge itself is performed by the agent in the
 * task's session (conflicts resolved in the same turn), so the form is down to
 * two choices: let the agent write the commit message (default) or provide one,
 * and whether to delete the worktree after landing. Submit awaits only the
 * dispatch; the outcome rides `task://changed` (merging → done, or back to
 * review with a readable error on the card).
 */
export function TaskMergeDialog({
  open,
  onOpenChange,
  task,
}: TaskMergeDialogProps) {
  const t = useTranslations("Tasks")
  const [autoMessage, setAutoMessage] = useState(true)
  const [message, setMessage] = useState("")
  const [deleteWorktree, setDeleteWorktree] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !task) return
    // Seed per open: message from the title, delete-worktree from the folder's
    // effective task settings.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAutoMessage(true)
    setMessage(task.title)
    setSubmitting(false)
    let cancelled = false
    workTaskSettingsEffective(task.folder_id)
      .then((s) => {
        if (cancelled) return
        setDeleteWorktree(s.delete_worktree_default)
      })
      .catch(() => {
        if (cancelled) return
        setDeleteWorktree(true)
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, task])

  const submit = async () => {
    if (!task || (!autoMessage && !message.trim())) return
    setSubmitting(true)
    try {
      await workTaskMerge(
        task.id,
        autoMessage ? null : message.trim(),
        deleteWorktree
      )
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{t("mergeTitle")}</DialogTitle>
          <DialogDescription>
            {task
              ? t("mergeDescription", {
                  branch: task.work_branch ?? "?",
                  base: task.base_branch ?? "?",
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Label className="text-sm font-normal">
            <Checkbox
              checked={autoMessage}
              onCheckedChange={(v) => setAutoMessage(v === true)}
            />
            {t("mergeAutoMessage")}
          </Label>

          {autoMessage ? null : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-merge-message">{t("mergeMessage")}</Label>
              <Textarea
                id="task-merge-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("mergeMessagePlaceholder")}
                rows={3}
              />
            </div>
          )}

          <Label className="text-sm font-normal">
            <Checkbox
              checked={deleteWorktree}
              onCheckedChange={(v) => setDeleteWorktree(v === true)}
            />
            {t("mergeDeleteWorktree")}
          </Label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || (!autoMessage && !message.trim())}
          >
            {t("mergeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
