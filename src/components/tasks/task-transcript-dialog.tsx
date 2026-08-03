"use client"

/**
 * Live session viewer for a work task — the same read-only streaming surface
 * as the delegation sub-agent dialog (`LiveTranscriptView`), without opening
 * the conversation in the workbench. Every "查看会话" affordance on the board
 * (card secondary button, detail-sheet action zone) lands here.
 *
 * Unlike delegation children (attached by the delegation provider), a
 * headless work-task connection is invisible to the frontend until attached:
 * on desktop the global acp://event router drops envelopes with no reverse-map
 * entry, and on web there is no per-connection stream at all. So while the
 * task is in a live status this dialog owns an
 * `attachDelegationChild`/`detachDelegationChild` pair for the task's
 * connection (identity parent mapping — there is no real parent tool call).
 * For settled tasks the DB row's connection_id is stale and the connection is
 * gone; we skip the attach and the viewer renders the persisted transcript.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import { type ResolvedMessageGroup } from "@/components/message/message-list-view"
import { StatusChip } from "./task-card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { getFolderConversation, workTaskEvents } from "@/lib/api"
import {
  extractRounds,
  firstTextOfParts,
  matchRoundKind,
  type TaskRound,
} from "@/lib/task-rounds"
import { type AgentType, type WorkTask } from "@/lib/types"

interface TaskTranscriptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/** Statuses in which the engine holds a live connection worth attaching
 *  (`merging` included — the merge is an agent turn too). */
function isLive(task: WorkTask): boolean {
  return (
    task.status === "running" ||
    task.status === "awaiting_input" ||
    task.status === "merging"
  )
}

export function TaskTranscriptDialog({
  open,
  onOpenChange,
  task,
}: TaskTranscriptDialogProps) {
  const t = useTranslations("Tasks")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeButtonClassName="top-2 right-2"
        className="flex h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl p-0 lg:max-w-4xl"
      >
        <DialogTitle className="sr-only">{t("transcriptTitle")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("transcriptDescription")}
        </DialogDescription>
        {open && task != null && task.conversation_id != null ? (
          <TaskAgentResolver task={task} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Resolve the session's agent BEFORE the viewer mounts. The live-event parser
 * is fixed by the attach latch below and never re-attached (a late change
 * would drop buffered events), so guessing here would render live chunks with
 * the wrong renderer. A per-task override is definitive and instant;
 * otherwise one conversation read returns the agent recorded at dispatch,
 * with the folder's default agent covering a failed read.
 */
function TaskAgentResolver({ task }: { task: WorkTask }) {
  const folders = useAppWorkspaceStore((s) => s.folders)
  const override = task.config?.agent_type ?? null
  const folderDefault =
    folders.find((f) => f.id === task.folder_id)?.default_agent_type ?? null
  const conversationId = task.conversation_id as number // gated by the host
  const [resolved, setResolved] = useState<AgentType | null>(override)
  useEffect(() => {
    if (override != null) return
    let cancelled = false
    getFolderConversation(conversationId)
      .then((detail) => {
        if (cancelled) return
        setResolved(detail.summary.agent_type ?? folderDefault ?? "claude_code")
      })
      .catch(() => {
        // Transcript unreadable (agent gone, file pruned) — best-effort.
        if (!cancelled) setResolved(folderDefault ?? "claude_code")
      })
    return () => {
      cancelled = true
    }
  }, [override, conversationId, folderDefault])

  if (resolved == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          className="size-5 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      </div>
    )
  }
  return <TaskTranscriptBody task={task} agentType={resolved} />
}

function TaskTranscriptBody({
  task,
  agentType,
}: {
  task: WorkTask
  agentType: AgentType
}) {
  const t = useTranslations("Tasks")
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()

  // Round markers → phase dividers above the matching user turns. Refetched
  // when a new generation dispatches (run_seq moves) so a merge started while
  // watching gets its divider too.
  const [rounds, setRounds] = useState<TaskRound[]>([])
  const runSeq = task.run_seq
  useEffect(() => {
    let cancelled = false
    workTaskEvents(task.id, 500)
      .then((events) => {
        if (!cancelled) setRounds(extractRounds(events))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [task.id, runSeq])
  const userTurnHeader = useCallback(
    (group: ResolvedMessageGroup) => {
      switch (matchRoundKind(rounds, firstTextOfParts(group.parts))) {
        case "work":
          return t("phaseWork")
        case "retry":
          return t("phaseRetry")
        case "return":
          return t("phaseReturn")
        case "merge":
          return t("phaseMerge")
        default:
          return null
      }
    },
    [rounds, t]
  )

  // Latched at mount: attach only when the task is live *now*, and keep the
  // attach until the dialog closes. Re-deriving per render would detach the
  // instant the provider refetch flips the task to review — racing the final
  // turn-complete event the bridge needs to promote the live reply — and a
  // task that settled long ago must not attach at all (on web that would open
  // a per-connection stream for a connection the backend no longer has).
  const [attach] = useState(() => ({
    id: isLive(task) ? task.connection_id : null,
    // Agent as resolved at open; a late refinement must not re-attach — it
    // would drop buffered events.
    agentType,
  }))
  const attachId = attach.id
  const taskId = task.id
  useEffect(() => {
    const id = attachId
    if (id == null) return
    attachDelegationChild({
      connectionId: id,
      parentConnectionId: id,
      parentToolUseId: `work-task-${taskId}`,
      agentType: attach.agentType,
      // Unlike a real delegation child (attached the moment it spawns), this
      // viewer opens onto a turn already in progress — hydrate its state
      // before routing or the desktop firehose would only show whatever the
      // agent happens to emit next.
      hydrate: true,
    })
    return () => detachDelegationChild(id)
  }, [attachId, attach, taskId, attachDelegationChild, detachDelegationChild])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-2.5 pr-12">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
          <AgentIcon agentType={agentType} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {task.title}
        </span>
        <StatusChip task={task} />
      </div>
      <LiveTranscriptView
        conversationId={task.conversation_id as number}
        connectionId={attachId}
        agentType={agentType}
        kickoffText={task.config?.display_text ?? null}
        userTurnHeader={userTurnHeader}
      />
    </div>
  )
}
