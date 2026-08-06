"use client"

import { useTranslations } from "next-intl"
import {
  Archive,
  ArchiveRestore,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  GitMerge,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import { hasNothingToMerge } from "./task-acceptance"
import type { WorkTask } from "@/lib/types"

type StatusLabelKey =
  | "statusTodo"
  | "statusQueued"
  | "statusPreparing"
  | "statusRunning"
  | "statusAwaitingInput"
  | "statusReview"
  | "statusMerging"
  | "statusDone"
  | "statusFailed"
  | "statusCanceled"

export function statusLabelKey(status: WorkTask["status"]): StatusLabelKey {
  switch (status) {
    case "todo":
      return "statusTodo"
    case "queued":
      return "statusQueued"
    case "preparing":
      return "statusPreparing"
    case "running":
      return "statusRunning"
    case "awaiting_input":
      return "statusAwaitingInput"
    case "review":
      return "statusReview"
    case "merging":
      return "statusMerging"
    case "done":
      return "statusDone"
    case "failed":
      return "statusFailed"
    case "canceled":
      return "statusCanceled"
  }
}

/**
 * Per-status presentation, so the board reads by shape rather than nine
 * same-looking chips: live statuses are primary-colored spinner text,
 * attention statuses an outlined amber pill, `done` a bare green check,
 * `failed` a tinted red pill, the rest a muted pill.
 */
export function StatusChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  // An interrupted failure (restart) reads differently from an agent failure.
  const label =
    task.status === "failed" && task.failure_reason === "interrupted"
      ? t("statusInterrupted")
      : t(statusLabelKey(task.status))
  switch (task.status) {
    case "queued":
    case "preparing":
    case "running":
    case "merging":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium text-primary">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {label}
        </span>
      )
    case "awaiting_input":
    case "review":
      return (
        <span className="inline-flex shrink-0 items-center rounded-full border border-amber-500/45 bg-amber-500/5 px-2 py-1 text-[0.625rem] font-medium leading-none text-amber-600 dark:border-amber-400/40 dark:text-amber-400">
          {label}
        </span>
      )
    case "done":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[0.625rem] font-medium leading-none text-emerald-600 dark:text-emerald-400">
          <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
          {label}
        </span>
      )
    case "failed":
      return (
        <span className="inline-flex shrink-0 items-center rounded-full bg-destructive/10 px-2 py-1 text-[0.625rem] font-medium leading-none text-destructive">
          {label}
        </span>
      )
    default:
      return (
        <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-1 text-[0.625rem] font-medium leading-none text-muted-foreground">
          {label}
        </span>
      )
  }
}

interface TaskCardProps {
  task: WorkTask
  folderName: string | null
  /** Shared render-tick timestamp for relative times (refreshed by the page). */
  now: number
  onOpen: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRequeue: () => void
  /** Opens the read-only live session viewer (TaskTranscriptDialog). */
  onViewSession: () => void
  onMerge: () => void
  /** Takes the merge slot when the task changed nothing (see
   *  `hasNothingToMerge`) — accepts it outright instead. */
  onComplete: () => void
  /** Toggles by `task.archived_at` (archive ⇄ unarchive). */
  onArchive: () => void
  /** Opens the editor dialog — offered while editable (todo / failed). */
  onEdit: () => void
}

/** The acceptance red/green light for a reviewed card. */
export function PreflightChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  const light = task.preflight
  if (!light || task.status !== "review") return null
  const tone =
    light.status === "passed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : light.status === "failed"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground"
  return (
    <span
      className={cn(
        // max-w-full: a long command wraps the chip to its own row in the
        // flex-wrap meta line and then truncates instead of overflowing.
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none",
        tone
      )}
      title={
        light.status === "passed"
          ? t("preflightPassed", { name: light.command })
          : light.status === "failed"
            ? t("preflightFailed", { name: light.command })
            : t("preflightRunning", { name: light.command })
      }
    >
      {light.status === "running" ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
      ) : light.status === "passed" ? (
        <CircleCheck className="size-2.5" aria-hidden="true" />
      ) : (
        <CircleX className="size-2.5" aria-hidden="true" />
      )}
      <span className="truncate">{light.command}</span>
    </span>
  )
}

interface CardActionItem {
  icon: typeof Play
  label: string
  onClick: () => void
}

/**
 * One board card. The whole card opens the detail sheet; the footer carries
 * exactly one filled primary action per status on the left, and on the right a
 * row of round icon buttons for the secondaries (edit / archive), always
 * ending in "查看会话" when a session exists. The full action set — with
 * labels — lives in the sheet. `merging` has no primary: it cannot be
 * canceled.
 */
export function TaskCard({
  task,
  folderName,
  now,
  onOpen,
  onStart,
  onCancel,
  onRetry,
  onRequeue,
  onViewSession,
  onMerge,
  onComplete,
  onArchive,
  onEdit,
}: TaskCardProps) {
  const t = useTranslations("Tasks")
  const archived = task.archived_at != null
  const live =
    task.status === "running" ||
    task.status === "awaiting_input" ||
    task.status === "merging"

  const stat =
    task.files_changed != null && task.files_changed > 0 ? (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.625rem]">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{task.additions ?? 0}
        </span>
        <span className="text-destructive">-{task.deletions ?? 0}</span>
      </span>
    ) : null
  const when = formatRelative(
    task.finished_at ?? task.settled_at ?? task.started_at ?? task.created_at,
    now
  )

  const { primary, more } = (() => {
    const more: CardActionItem[] = []
    let primary: CardActionItem | null = null
    // An archived card offers exactly one way back.
    if (archived) {
      primary = {
        icon: ArchiveRestore,
        label: t("actionUnarchive"),
        onClick: onArchive,
      }
      return { primary, more }
    }
    switch (task.status) {
      case "todo":
        primary = { icon: Play, label: t("actionStart"), onClick: onStart }
        more.push({ icon: Pencil, label: t("actionEdit"), onClick: onEdit })
        break
      case "queued":
      case "preparing":
      case "running":
      case "awaiting_input":
        primary = { icon: Ban, label: t("actionCancel"), onClick: onCancel }
        break
      case "review":
        // Nothing was changed ⟹ nothing to merge: the card offers the
        // acceptance that actually applies.
        primary = hasNothingToMerge(task)
          ? {
              icon: CircleCheck,
              label: t("actionComplete"),
              onClick: onComplete,
            }
          : { icon: GitMerge, label: t("actionMerge"), onClick: onMerge }
        break
      case "merging":
        break
      case "failed":
        primary = { icon: RotateCw, label: t("actionRetry"), onClick: onRetry }
        more.push({ icon: Pencil, label: t("actionEdit"), onClick: onEdit })
        more.push({
          icon: Archive,
          label: t("actionArchive"),
          onClick: onArchive,
        })
        break
      case "done":
        primary = {
          icon: Archive,
          label: t("actionArchive"),
          onClick: onArchive,
        }
        break
      case "canceled":
        primary = {
          icon: RotateCw,
          label: t("actionRequeue"),
          onClick: onRequeue,
        }
        more.push({
          icon: Archive,
          label: t("actionArchive"),
          onClick: onArchive,
        })
        break
    }
    return { primary, more }
  })()

  // Round icon row on the right: the status's own secondaries, then the
  // uniform session viewer — offered in every status once a session exists
  // (live ones stream it in real time).
  const secondaries = [...more]
  if (task.conversation_id != null) {
    secondaries.push({
      icon: MessageSquareText,
      label: t("actionViewSession"),
      onClick: onViewSession,
    })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        // ws-msg-card: with a workspace background image on, the card goes
        // translucent like message-stream cards (e.g. the file-edit card).
        // border-foreground/15, not border-border: a card is white-on-white
        // here, and the token border all but vanishes on that canvas (the
        // empty column's dashed outline had to be derived the same way).
        "group/card flex cursor-pointer flex-col rounded-xl border border-foreground/15 bg-card ws-msg-card p-3 text-left",
        // Hover is a border colour change only — no lift, no shadow.
        "transition-colors hover:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        archived && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-[0.8125rem] font-medium leading-snug">
          {task.title}
        </span>
        <StatusChip task={task} />
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {folderName ? (
          <span className="max-w-40 truncate">{folderName}</span>
        ) : null}
        {folderName && task.work_branch ? (
          <span className="text-muted-foreground/40">/</span>
        ) : null}
        {task.work_branch ? (
          <span className="truncate font-mono text-[0.625rem]">
            {task.work_branch}
          </span>
        ) : null}
        {(folderName || task.work_branch) && (stat || when) ? (
          <span className="text-muted-foreground/40">·</span>
        ) : null}
        {stat}
        {stat && when ? (
          <span className="text-muted-foreground/40">·</span>
        ) : null}
        {when ? <span className="shrink-0">{when}</span> : null}
        <PreflightChip task={task} />
        {task.cleanup_state === "failed" ? (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] text-amber-600 dark:text-amber-400">
            {t("badgeCleanupFailed")}
          </span>
        ) : null}
        {task.status === "canceled" && task.worktree_folder_id != null ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem]">
            {t("badgeWorktreeKept")}
          </span>
        ) : null}
      </div>

      {task.last_error &&
      (task.status === "failed" || task.status === "review") ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[0.6875rem] text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{task.last_error}</span>
          <button
            type="button"
            className="shrink-0 font-medium hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {t("errorView")}
          </button>
        </div>
      ) : null}
      {task.status === "review" && task.result_summary ? (
        <p className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground">
          {task.result_summary}
        </p>
      ) : null}
      {live && task.latest_progress ? (
        <p className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground italic">
          {task.latest_progress}
        </p>
      ) : null}

      {/* mt-3 / pt-3 = the card's own p-3: the divider clears the content above
          it by the same 12px the buttons clear the card's left, right and
          bottom edges, so the footer sits on one even inset. */}
      {primary || secondaries.length > 0 ? (
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3">
          {primary ? (
            <Button
              type="button"
              size="xs"
              onClick={(e) => {
                // The card itself opens the detail sheet — keep actions local.
                e.stopPropagation()
                primary.onClick()
              }}
            >
              <primary.icon className="size-3" aria-hidden="true" />
              {primary.label}
            </Button>
          ) : null}
          <div className="flex-1" />
          {/* Secondaries are icon-only and round: they are one-per-status at
              most, so a "…" menu just hid them behind an extra click. The
              session viewer always sorts last, anchoring the corner. They
              fade in on hover (opacity only — the row keeps its height, so
              nothing reflows) and on keyboard focus. */}
          {secondaries.map((item) => (
            <CardIconAction key={item.label} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CardIconAction({ item }: { item: CardActionItem }) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="outline"
      className="rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
      title={item.label}
      aria-label={item.label}
      onClick={(e) => {
        // The card itself opens the detail sheet — keep actions local.
        e.stopPropagation()
        item.onClick()
      }}
    >
      <item.icon aria-hidden="true" />
    </Button>
  )
}
