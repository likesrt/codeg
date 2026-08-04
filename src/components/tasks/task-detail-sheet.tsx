"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Archive,
  ArchiveRestore,
  Ban,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleX,
  Coins,
  FileDiff,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
  ListTodo,
  Trash2,
  Undo2,
} from "lucide-react"
import {
  workTaskArchive,
  workTaskCancel,
  getFolderConversation,
  workTaskChangedFiles,
  workTaskCleanup,
  workTaskDelete,
  workTaskDiff,
  workTaskEvents,
  workTaskRequeue,
  workTaskRetry,
  workTaskReturn,
  workTaskStart,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { formatTokenCount } from "@/lib/token-format"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "@/components/ai-elements/message"
import { AgentIcon } from "@/components/agent-icon"
import { getAgentLabel } from "@/lib/custom-agents"
import { StatusChip, statusLabelKey } from "./task-card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  WorkTask,
  WorkTaskChangedFile,
  WorkTaskEvent,
} from "@/lib/types"

const WORK_TASK_CHANGED_EVENT = "task://changed"

/**
 * Typography for the agent's Markdown result inside the drawer's compact
 * panel. Streamdown sizes its own elements for the full-width chat column
 * (h1 at `text-3xl`, 24px above every heading), which is far too loud at the
 * panel's 12px scale — and a descendant selector outranks the class Streamdown
 * puts on the element itself, so these win without `!important`. Lists and the
 * first/last block's collapsed margin already come from `MessageResponse`.
 * `prose` is deliberately absent: the repo has no typography plugin, so those
 * classes generate nothing.
 */
const RESULT_MARKDOWN =
  "[&_h1]:text-[0.8125rem] [&_h2]:text-[0.8125rem] [&_h3]:text-xs [&_h4]:text-xs " +
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold " +
  "[&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_h4]:mt-2 " +
  "[&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1 " +
  "[&_p]:mt-0 [&_p]:mb-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_blockquote]:my-2 [&_hr]:my-3"

interface TaskDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The live task row (already refreshed by the board's provider). */
  task: WorkTask | null
  folderName: string | null
  /** Opens the page-owned read-only live session viewer. */
  onViewSession: (task: WorkTask) => void
  onMerge: (task: WorkTask) => void
  onEdit: (task: WorkTask) => void
}

/** One button of the sheet's action panel (see below). */
interface ZoneAction {
  icon: typeof Play
  label: string
  onClick: () => void
  /** The status's single primary — filled, and it grows to fill the row. */
  filled?: boolean
  /** Pushed to the right edge and rendered ghost: an escape hatch (abandon),
   *  not a step forward. */
  trailing?: boolean
}

/**
 * Right-side detail drawer: metadata, the action zone (the status's primary
 * actions — the review acceptance panel takes its slot while reviewing), and
 * the append-only progress timeline (`work_task_event`). The bottom bar keeps
 * utilities only (cleanup recovery + delete).
 */
export function TaskDetailSheet({
  open,
  onOpenChange,
  task,
  folderName,
  onViewSession,
  onMerge,
  onEdit,
}: TaskDetailSheetProps) {
  const t = useTranslations("Tasks")
  const [events, setEvents] = useState<WorkTaskEvent[]>([])
  const [files, setFiles] = useState<WorkTaskChangedFile[]>([])
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnText, setReturnText] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const [diffFile, setDiffFile] = useState<string | null | false>(false)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const taskId = task?.id ?? null
  const hasWorktree = task?.worktree_folder_id != null
  const conversationId = task?.conversation_id ?? null
  const taskStatus = task?.status ?? null
  // Total token usage of the task's conversation — parsed from the agent's own
  // transcript on open and re-read when the task settles (status flip), not on
  // every progress nudge (the parse is the expensive part).
  const [tokenTotal, setTokenTotal] = useState<number | null>(null)
  // The conversation's own agent — drives the header glyph. Read from the same
  // detail fetch as the token total (a task row carries an agent only when it
  // overrides the folder's default).
  const [convAgentType, setConvAgentType] = useState<AgentType | null>(null)
  useEffect(() => {
    if (!open || conversationId == null) {
      setTokenTotal(null)
      setConvAgentType(null)
      return
    }
    let cancelled = false
    getFolderConversation(conversationId)
      .then((detail) => {
        if (cancelled) return
        setConvAgentType(detail.summary.agent_type ?? null)
        const stats = detail.session_stats
        const usage = stats?.total_usage ?? null
        const total =
          stats?.total_tokens ??
          (usage
            ? usage.input_tokens +
              usage.output_tokens +
              usage.cache_creation_input_tokens +
              usage.cache_read_input_tokens
            : null)
        setTokenTotal(total ?? null)
      })
      .catch(() => {
        // Transcript may be unreadable (agent gone, file pruned) — no chip.
      })
    return () => {
      cancelled = true
    }
  }, [open, conversationId, taskStatus])

  const reload = useCallback(async () => {
    if (taskId == null) return
    const id = ++reqRef.current
    try {
      const [evs, fls] = await Promise.all([
        workTaskEvents(taskId),
        hasWorktree ? workTaskChangedFiles(taskId) : Promise.resolve([]),
      ])
      if (id === reqRef.current) {
        setEvents(evs)
        setFiles(fls)
      }
    } catch {
      // keep previous data on transient error
    }
  }, [taskId, hasWorktree])

  useEffect(() => {
    if (!open || taskId == null) return

    setEvents([])
    setFiles([])
    setReturnOpen(false)
    setReturnText("")
    void reload()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void reload()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    const offReconnect = onTransportReconnect(() => {
      void reload()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
  }, [open, taskId, reload])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  // Snapshot first (it carries the model the run actually used); otherwise the
  // resolved agent's display name, so a task that simply follows the folder's
  // defaults still names its agent beside the icon.
  const agentLabel = useMemo(() => {
    const snap = task?.config?.label_snapshot
    const name =
      snap?.agent_label ??
      (convAgentType ? (getAgentLabel(convAgentType) ?? convAgentType) : null)
    if (!name) return null
    const model = snap?.config_labels?.model
    return model ? `${name} · ${model}` : name
  }, [task, convAgentType])

  if (!task) return null

  // Conversation truth first; a task that overrides the folder default carries
  // its own agent, and before the detail lands that override is all we have.
  const agentType = convAgentType ?? task.config?.agent_type ?? null

  // The user-authored brief, as typed (the agent receives the block form).
  const promptText = task.config?.display_text?.trim() || null
  const archived = task.archived_at != null

  const canEdit = task.status === "todo" || task.status === "failed"

  // The next-step panel's buttons — ONE list for every status, review
  // included, so the panel never changes shape from one status to the next.
  // The board card's filled primary leads; archive is the only other action
  // that advances the task's state. "查看会话" and "编辑" don't advance
  // anything, so they sit in the bottom bar instead.
  const zoneActions: ZoneAction[] = []
  const isReview = task.status === "review" && !archived
  if (isReview) {
    zoneActions.push({
      icon: GitMerge,
      label: t("actionMerge"),
      filled: true,
      onClick: () => onMerge(task),
    })
    zoneActions.push({
      icon: Undo2,
      label: t("actionReturn"),
      onClick: () => setReturnOpen((v) => !v),
    })
    zoneActions.push({
      icon: Ban,
      label: t("actionAbandon"),
      trailing: true,
      onClick: () => run(() => workTaskCancel(task.id)),
    })
  } else {
    const archive = (label: string, filled?: boolean): ZoneAction => ({
      icon: archived ? ArchiveRestore : Archive,
      label,
      filled,
      onClick: () => run(() => workTaskArchive(task.id, !archived)),
    })
    if (archived) {
      zoneActions.push(archive(t("actionUnarchive"), true))
    } else {
      switch (task.status) {
        case "todo":
          zoneActions.push({
            icon: Play,
            label: t("actionStart"),
            filled: true,
            onClick: () => run(() => workTaskStart(task.id)),
          })
          break
        case "queued":
        case "preparing":
        case "running":
        case "awaiting_input":
          zoneActions.push({
            icon: Ban,
            label: t("actionCancel"),
            filled: true,
            onClick: () => run(() => workTaskCancel(task.id)),
          })
          break
        case "merging":
          break
        case "failed":
          zoneActions.push({
            icon: RotateCw,
            label: t("actionRetry"),
            filled: true,
            onClick: () => run(() => workTaskRetry(task.id)),
          })
          zoneActions.push(archive(t("actionArchive")))
          break
        case "done":
          zoneActions.push(archive(t("actionArchive"), true))
          break
        case "canceled":
          zoneActions.push({
            icon: RotateCw,
            label: t("actionRequeue"),
            filled: true,
            onClick: () => run(() => workTaskRequeue(task.id)),
          })
          zoneActions.push(archive(t("actionArchive")))
          break
      }
    }
  }

  const hasTrailingAction = zoneActions.some((a) => a.trailing)

  const submitReturn = () =>
    run(async () => {
      const feedback = returnText.trim()
      if (!feedback) return
      await workTaskReturn(task.id, feedback)
      setReturnOpen(false)
      setReturnText("")
    })

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[44rem]"
        >
          <SheetHeader className="shrink-0 gap-0 border-b border-border px-5 py-4">
            {/* Agent glyph, then the title block. The status chip rides
                directly beside the title rather than being pinned to the far
                edge — it reads as part of the name, not as a separate
                column. */}
            <div className="flex items-start gap-3 pr-8">
              {/* The agent that actually ran the task, not a generic glyph. */}
              <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 text-foreground">
                {agentType ? (
                  <AgentIcon
                    agentType={agentType}
                    className="size-[1.125rem]"
                  />
                ) : (
                  <ListTodo
                    className="size-[1.125rem] text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-start gap-2">
                  <SheetTitle className="min-w-0 break-words text-[0.9375rem] font-semibold leading-5">
                    {task.title}
                  </SheetTitle>
                  {/* One title line tall, centring its own content: the chips
                      differ in height (pill vs bare spinner text), so a fixed
                      margin would only ever centre one of them — and a
                      wrapping title still keeps the chip on line one. */}
                  <span className="flex h-5 shrink-0 items-center">
                    <StatusChip task={task} />
                  </span>
                </div>
                {/* Identity only, dot-separated like the board card — git
                    facts live in the Details grid below. One line, never
                    wrapping: the agent and the model it ran belong beside the
                    folder, so the parts truncate proportionally instead of
                    dropping the model onto a line of its own. */}
                <div className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-none text-muted-foreground">
                  {folderName ? (
                    <span className="min-w-0 shrink truncate">
                      {folderName}
                    </span>
                  ) : null}
                  {folderName && agentLabel ? <MetaDot /> : null}
                  {agentLabel ? (
                    <span className="min-w-0 shrink truncate">
                      {agentLabel}
                    </span>
                  ) : null}
                  {(folderName || agentLabel) &&
                  tokenTotal != null &&
                  tokenTotal > 0 ? (
                    <MetaDot />
                  ) : null}
                  {tokenTotal != null && tokenTotal > 0 ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 tabular-nums"
                      title={t("detailTokens")}
                    >
                      <Coins className="size-3" aria-hidden="true" />
                      {formatTokenCount(tokenTotal)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <SheetDescription className="sr-only">
              {t("detailDescription")}
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 px-5 py-4">
              {task.last_error ? (
                <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {task.last_error}
                  </span>
                </div>
              ) : null}

              {/* The original task brief — always above the agent's result. */}
              {promptText ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("promptLabel")}
                  </h3>
                  {/* Filled, not outlined: without a border the fill has to
                      carry the block, so the surface is opaque enough to read
                      on a white drawer. The brief and the result share it —
                      they are the same kind of thing (quoted prose), and the
                      section headings already say whose words they are. */}
                  <CollapsibleBlock maxPx={192} fadeClass="from-muted">
                    <div className="whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-xs leading-relaxed">
                      {promptText}
                    </div>
                  </CollapsibleBlock>
                </section>
              ) : null}

              {task.result_summary ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("detailSummary")}
                  </h3>
                  {/* The agent writes its verdict the way it writes anything
                      else — bullets, `code`, bold — so it goes through the
                      same renderer as the chat instead of showing its own
                      source. Capped taller than the brief above: this is the
                      thing the drawer was opened to read. */}
                  <CollapsibleBlock maxPx={256} fadeClass="from-muted">
                    <div
                      className={cn(
                        "break-words rounded-xl bg-muted p-3 text-xs leading-relaxed",
                        RESULT_MARKDOWN
                      )}
                    >
                      <MessageResponse>{task.result_summary}</MessageResponse>
                    </div>
                  </CollapsibleBlock>
                </section>
              ) : null}

              {/* Next-step panel — one shell for EVERY status, below the
                  result and above the details. Amber while the task waits on
                  the user's acceptance, neutral otherwise: the tone changes,
                  the shape never does. The primary grows to fill the row, so
                  a single-action status reads as a deliberate call to action
                  rather than a lone button afloat in the drawer. */}
              {zoneActions.length > 0 ? (
                <section
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-3",
                    isReview
                      ? "border-amber-500/30 bg-amber-500/5 dark:border-amber-400/25"
                      : "border-border/70 bg-muted/30"
                  )}
                >
                  {isReview && task.preflight ? (
                    <div className="flex flex-col gap-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-xs",
                          task.preflight.status === "passed" &&
                            "text-emerald-600 dark:text-emerald-400",
                          task.preflight.status === "failed" &&
                            "text-destructive",
                          task.preflight.status === "running" &&
                            "text-muted-foreground"
                        )}
                      >
                        {task.preflight.status === "running" ? (
                          <Loader2
                            className="size-3.5 shrink-0 animate-spin"
                            aria-hidden="true"
                          />
                        ) : task.preflight.status === "passed" ? (
                          <CircleCheck
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleX
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 break-words">
                          {task.preflight.status === "passed"
                            ? t("preflightPassed", {
                                name: task.preflight.command,
                              })
                            : task.preflight.status === "failed"
                              ? t("preflightFailed", {
                                  name: task.preflight.command,
                                })
                              : t("preflightRunning", {
                                  name: task.preflight.command,
                                })}
                        </span>
                      </div>
                      {task.preflight.status === "failed" &&
                      task.preflight.output_tail ? (
                        <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-background/70 p-2 font-mono text-[0.625rem] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                          {task.preflight.output_tail}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    {zoneActions.map((action) => (
                      <Button
                        key={action.label}
                        type="button"
                        variant={
                          action.trailing
                            ? "ghost"
                            : action.filled
                              ? "default"
                              : "outline"
                        }
                        disabled={busy}
                        className={cn(
                          "h-8 gap-1.5",
                          // The primary claims the row unless an escape hatch
                          // holds the right edge — then it sizes to content and
                          // the spacer does the pushing.
                          action.filled && !hasTrailingAction && "flex-1",
                          action.trailing && "ml-auto text-muted-foreground",
                          !action.filled && !action.trailing && "bg-background"
                        )}
                        onClick={action.onClick}
                      >
                        <action.icon className="size-3.5" aria-hidden="true" />
                        {action.label}
                      </Button>
                    ))}
                  </div>

                  {returnOpen ? (
                    <div className="flex flex-col gap-1.5">
                      <Textarea
                        className="bg-background"
                        value={returnText}
                        onChange={(e) => setReturnText(e.target.value)}
                        placeholder={t("returnPlaceholder")}
                        rows={3}
                        autoFocus
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy || !returnText.trim()}
                          onClick={submitReturn}
                        >
                          {t("returnSubmit")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* Key-value facts: git coordinates, change size, lifecycle. */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailInfo")}
                </h3>
                {/* Boxed and ruled, like the changed-files list. No column
                    gap: the label/value spacing is padding INSIDE the cells,
                    so the two cells' bottom borders meet and each rule runs
                    unbroken across the box. nth-last-child(-n+2) is the dt/dd
                    of the final row, which drops its rule. */}
                <dl className="grid grid-cols-[auto_1fr] overflow-hidden rounded-xl border border-border text-xs [&>*:nth-last-child(-n+2)]:border-b-0">
                  {task.work_branch ? (
                    <InfoRow label={t("detailBranch")}>
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.6875rem]">
                        <GitBranch
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {task.work_branch}
                          {task.base_branch ? ` ← ${task.base_branch}` : null}
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  {task.merge_commit ? (
                    <InfoRow label={t("detailMergeCommit")}>
                      <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem]">
                        <GitCommitHorizontal
                          className="size-3 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {task.merge_commit.slice(0, 8)}
                      </span>
                    </InfoRow>
                  ) : null}
                  {task.files_changed != null && task.files_changed > 0 ? (
                    <InfoRow label={t("detailChanges")}>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5">
                        {t("filesChanged", { count: task.files_changed })}
                        <span className="font-mono text-[0.6875rem]">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{task.additions ?? 0}
                          </span>{" "}
                          <span className="text-destructive">
                            -{task.deletions ?? 0}
                          </span>
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  <InfoRow label={t("detailCreated")}>
                    {formatDateTime(task.created_at)}
                  </InfoRow>
                  {task.started_at ? (
                    <InfoRow label={t("detailStarted")}>
                      {formatDateTime(task.started_at)}
                    </InfoRow>
                  ) : null}
                  {task.finished_at ? (
                    <InfoRow label={t("detailFinished")}>
                      {formatDateTime(task.finished_at)}
                    </InfoRow>
                  ) : null}
                </dl>
              </section>

              {/* Changed files vs the recorded base. */}
              {hasWorktree ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("detailFiles")}
                      {files.length > 0 ? (
                        <span className="ml-1.5 font-normal text-muted-foreground/70 tabular-nums">
                          {files.length}
                        </span>
                      ) : null}
                    </h3>
                    {files.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-[0.6875rem] text-muted-foreground"
                        onClick={() => setDiffFile(null)}
                      >
                        <FileDiff className="size-3" aria-hidden="true" />
                        {t("detailDiffAll")}
                      </Button>
                    ) : null}
                  </div>
                  {files.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("detailNoChanges")}
                    </p>
                  ) : (
                    <CollapsibleBlock maxPx={224}>
                      <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
                        {files.map((f) => (
                          <li key={f.file}>
                            <button
                              type="button"
                              onClick={() => setDiffFile(f.file)}
                              className={cn(
                                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                                "transition-colors hover:bg-accent/50"
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">
                                {f.file}
                              </span>
                              <span className="shrink-0 font-mono text-[0.625rem] text-emerald-600 dark:text-emerald-400">
                                +{f.additions}
                              </span>
                              <span className="shrink-0 font-mono text-[0.625rem] text-destructive">
                                -{f.deletions}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </CollapsibleBlock>
                  )}
                </section>
              ) : null}

              {/* Progress timeline (work_task_event, append-only). */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailTimeline")}
                </h3>
                {events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("detailTimelineEmpty")}
                  </p>
                ) : (
                  <ol className="flex flex-col">
                    {events
                      // `round` markers feed the transcript viewer's phase
                      // dividers; here the status headers already segment.
                      .filter((ev) => ev.kind !== "round")
                      .map((ev) => (
                        <TimelineRow key={ev.id} event={ev} />
                      ))}
                  </ol>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Footer: everything that does NOT advance the task's state — the
              status's own actions live in the action zone / acceptance panel
              above. Left: session viewer, edit (while editable), cleanup
              retry; right: destructive delete (`merging` cannot be deleted).
              Deleting offers the worktree checkbox in its confirm dialog, so
              that is the only worktree affordance kept here. */}
          {task.conversation_id != null ||
          canEdit ||
          task.status !== "merging" ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-5 py-3">
              {task.conversation_id != null ? (
                <FooterAction
                  icon={MessageSquareText}
                  label={t("actionViewSession")}
                  busy={false}
                  onClick={() => onViewSession(task)}
                />
              ) : null}
              {canEdit ? (
                <FooterAction
                  icon={Pencil}
                  label={t("actionEdit")}
                  busy={busy}
                  onClick={() => onEdit(task)}
                />
              ) : null}
              {hasWorktree && task.cleanup_state === "failed" ? (
                <FooterAction
                  icon={FolderX}
                  label={t("actionRetryCleanup")}
                  busy={busy}
                  onClick={() => run(() => workTaskCleanup(task.id))}
                />
              ) : null}
              <div className="flex-1" />
              {task.status !== "merging" ? (
                <FooterAction
                  icon={Trash2}
                  label={t("actionDelete")}
                  busy={busy}
                  destructive
                  onClick={() => setDeleteOpen(true)}
                />
              ) : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Per-file / full diff viewer. */}
      <Dialog
        open={diffFile !== false}
        onOpenChange={(o) => !o && setDiffFile(false)}
      >
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[56rem]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
            <DialogTitle className="truncate font-mono text-sm">
              {diffFile === false ? "" : (diffFile ?? t("detailDiffAllTitle"))}
            </DialogTitle>
          </DialogHeader>
          {diffFile !== false ? (
            <TaskDiffBody taskId={task.id} file={diffFile} />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirm (optionally with the worktree). */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmBody", { title: task.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasWorktree ? (
            <Label className="text-sm font-normal">
              <Checkbox
                checked={deleteWorktree}
                onCheckedChange={(v) => setDeleteWorktree(v === true)}
              />
              {t("deleteWithWorktree")}
            </Label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(async () => {
                  await workTaskDelete(task.id, hasWorktree && deleteWorktree)
                  setDeleteOpen(false)
                  onOpenChange(false)
                })
              }
            >
              {t("actionDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TaskDiffBody({
  taskId,
  file,
}: {
  taskId: number
  file: string | null
}) {
  const t = useTranslations("Tasks")
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    /* eslint-disable react-hooks/set-state-in-effect */
    setDiff(null)
    setError(null)
    workTaskDiff(taskId, file)
      .then((d) => {
        if (!cancelled) setDiff(d)
      })
      .catch((e) => {
        if (!cancelled) setError(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [taskId, file])

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>
  }
  if (diff == null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("diffLoading")}
      </div>
    )
  }
  if (!diff.trim()) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("detailNoChanges")}
      </p>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        {/* `unbounded`: the preview would otherwise put every file in its own
            420px scroll box, nesting a second vertical scroll inside this
            one. Here the whole diff is capped once and revealed on demand. */}
        <CollapsibleBlock maxPx={420}>
          <UnifiedDiffPreview diffText={diff} unbounded />
        </CollapsibleBlock>
      </div>
    </ScrollArea>
  )
}

/**
 * Caps its content at `maxPx` and offers a reveal toggle — but only once the
 * content actually exceeds the cap, so short lists and small diffs render
 * untouched. Measured from the content's own box (not the clipped one) so the
 * toggle survives expanding.
 */
function CollapsibleBlock({
  maxPx,
  fadeClass = "from-background",
  children,
}: {
  maxPx: number
  /** Gradient source for the clip fade — it has to match the surface being
   *  clipped, or the fade reads as a stripe rather than a soft edge. */
  fadeClass?: string
  children: ReactNode
}) {
  const t = useTranslations("Tasks")
  const innerRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => setContentHeight(el.scrollHeight)
    measure()
    // Content grows asynchronously (a diff reparse, a refreshed file list).
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Slack absorbs sub-pixel rounding — a 2px overflow isn't worth a toggle.
  const overflows = contentHeight > maxPx + 8
  const clipped = overflows && !expanded

  return (
    <div className="flex flex-col">
      <div
        className="relative overflow-hidden"
        style={clipped ? { maxHeight: maxPx } : undefined}
      >
        <div ref={innerRef}>{children}</div>
        {clipped ? (
          <div
            aria-hidden="true"
            className={cn(
              // Rounded to the clipped surface's own corners: a square
              // gradient would paint its colour into them. Invisible for the
              // default fade (page colour over the page), load-bearing for a
              // filled panel.
              "pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-xl bg-gradient-to-t to-transparent",
              fadeClass
            )}
          />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 self-center rounded-full px-2 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronUp className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
          {expanded ? t("showLess") : t("showMore")}
        </button>
      ) : null}
    </div>
  )
}

/** One label/value pair inside the Details grid (grid supplies the columns).
 *  Both cells carry the row's underline so it spans both columns. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="border-b border-border/60 py-2 pl-3 pr-4 text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words border-b border-border/60 py-2 pr-3">
        {children}
      </dd>
    </>
  )
}

/** Full date-time, minute precision — the Details grid. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Compact date-time for timeline rows (year dropped; events are recent). */
function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function FooterAction({
  icon: Icon,
  label,
  onClick,
  busy,
  destructive,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  busy: boolean
  destructive?: boolean
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={busy}
      className={cn(
        "h-7 gap-1.5 px-2.5 text-xs",
        destructive
          ? "text-destructive hover:text-destructive"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}

const EVENT_KIND_KEYS = {
  created: "eventCreated",
  status_changed: "eventStatusChanged",
  config_effective: "eventConfigEffective",
  init_command: "eventInitCommand",
  agent_progress: "eventAgentProgress",
  agent_verdict: "eventAgentVerdict",
  merge_attempt: "eventMergeAttempt",
  merge_conflict: "eventMergeConflict",
  preflight_result: "eventPreflight",
  cleanup_failed: "eventCleanupFailed",
  resume_fallback: "eventResumeFallback",
  user_action: "eventUserAction",
  diff_stat: "eventDiffStat",
} as const

const STATUS_KEYS = new Set([
  "todo",
  "queued",
  "preparing",
  "running",
  "awaiting_input",
  "review",
  "merging",
  "done",
  "failed",
  "canceled",
])

/** Dot tone per status — the same colour language as the board columns. */
function statusDotClass(status: string): string {
  switch (status) {
    case "running":
    case "queued":
    case "preparing":
      return "bg-primary"
    case "awaiting_input":
    case "review":
    case "merging":
      return "bg-amber-500"
    case "failed":
      return "bg-destructive"
    case "done":
      return "bg-emerald-500"
    default:
      return "bg-muted-foreground/50"
  }
}

/**
 * A `status_changed` event is a phase header — a coloured dot plus the status
 * name; every other event hangs off the rail beneath it. The two used to be
 * near-identical single lines, which is what made the log hard to scan: now
 * the header carries the colour and the weight, the rail groups what belongs
 * to it, and each entry's detail gets its own line instead of sharing a
 * baseline with the label and wrapping unpredictably.
 */
function TimelineRow({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  if (event.kind === "status_changed") {
    return <TimelineStatusHeader event={event} />
  }
  const key =
    event.kind in EVENT_KIND_KEYS
      ? EVENT_KIND_KEYS[event.kind as keyof typeof EVENT_KIND_KEYS]
      : null
  const label = key ? t(key) : event.kind
  const detail = timelineDetail(event)
  return (
    // ml-[3px] puts the rail under the centre of the header's dot above, and
    // 3px + the 1px rail + pl-2.5 lands the text at the same 14px inset as the
    // header's label — the entry hangs off the rail without stepping right.
    <li className="ml-[3px] flex items-baseline gap-2 border-l border-border/70 py-1 pl-2.5">
      {/* Label and detail share one line (truncated, full text on hover) so
          the log scans as a column of events rather than a stack of
          two-line paragraphs. */}
      <p
        className="min-w-0 flex-1 truncate text-[0.6875rem] leading-tight"
        title={detail ? `${label} — ${detail}` : label}
      >
        <span className="font-medium">{label}</span>
        {detail ? (
          <span className="ml-1.5 text-muted-foreground">{detail}</span>
        ) : null}
      </p>
      <TimelineTime iso={event.created_at} />
    </li>
  )
}

function TimelineStatusHeader({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  const p = event.payload
  const str = (k: string) =>
    p && typeof p[k] === "string" ? (p[k] as string) : null
  const to = str("to")
  const known = to != null && STATUS_KEYS.has(to)
  const label = known
    ? t(statusLabelKey(to as WorkTask["status"]))
    : (to ?? t("eventStatusChanged"))
  const note = str("error") ?? str("reason")
  return (
    <li className="flex flex-col gap-0.5 pb-1 pt-3 first:pt-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusDotClass(known ? (to as string) : "")
          )}
        />
        <span className="min-w-0 flex-1 break-words text-xs font-semibold text-foreground">
          {label}
        </span>
        <TimelineTime iso={event.created_at} />
      </div>
      {note ? (
        <p className="min-w-0 break-words pl-3.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {note}
        </p>
      ) : null}
    </li>
  )
}

/** Right-aligned, never wrapping — the log's time gutter. */
function TimelineTime({ iso }: { iso: string }) {
  return (
    <span className="ml-auto shrink-0 text-[0.625rem] tabular-nums text-muted-foreground/70">
      {formatEventTime(iso)}
    </span>
  )
}

/** Muted separator between the header's identity chips. */
function MetaDot() {
  return <span className="shrink-0 text-muted-foreground/40">·</span>
}

/** Human-readable one-liner for an event payload (best-effort, schema-loose). */
function timelineDetail(event: WorkTaskEvent): string | null {
  const p = event.payload
  if (!p) return null
  const str = (k: string) =>
    typeof p[k] === "string" ? (p[k] as string) : null
  switch (event.kind) {
    case "init_command": {
      const command = str("command")
      const exit =
        typeof p.exit_code === "number" ? `exit ${p.exit_code}` : null
      return [command, exit].filter(Boolean).join(" · ") || null
    }
    case "config_effective": {
      const agent = str("agent")
      const model = str("model")
      return [agent, model].filter(Boolean).join(" · ") || null
    }
    case "agent_progress":
      return str("message")
    case "agent_verdict":
      return (
        [str("verdict"), str("summary")].filter(Boolean).join(" · ") || null
      )
    case "merge_attempt":
      return str("strategy")
    case "merge_conflict": {
      const files = Array.isArray(p.files) ? (p.files as string[]) : []
      return files.join(", ") || null
    }
    case "preflight_result": {
      const status = str("status")
      const command = str("command")
      return [command, status].filter(Boolean).join(" · ") || null
    }
    case "cleanup_failed":
      return str("error")
    case "user_action": {
      const action = str("action")
      const feedback = str("feedback")
      return [action, feedback].filter(Boolean).join(": ") || null
    }
    case "diff_stat": {
      const fc = p.files_changed
      const a = p.additions
      const d = p.deletions
      if (typeof fc === "number") return `${fc} files · +${a ?? 0} -${d ?? 0}`
      return null
    }
    default:
      return null
  }
}
