"use client"

/**
 * Viewer for a delegated sub-agent's full conversation.
 *
 * Opens from `DelegatedSubThread`'s header. The whole read-only streaming
 * surface — the shared `MessageListView`, the live bridge into the runtime
 * session, and the child's blocking prompts (permission / ask_user_question /
 * plan approval, answered through the CHILD connection id) — lives in
 * `LiveTranscriptView`; this file only owns the Dialog chrome and header.
 * No attach lifecycle here: delegation children are attached by the
 * delegation provider for the parent card, and the connection registration
 * outlives this dialog.
 */

import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { type AgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  childConversationId: number
  childConnectionId: string | null
  agentType: AgentType | null
  /**
   * The parent's `delegate_to_agent` task text — the child's kickoff prompt,
   * known synchronously in the card. Surfaced so the kickoff user turn can be
   * shown immediately while the child's persisted transcript still lags the
   * live stream (the agent CLI writes its JSONL asynchronously).
   */
  kickoffTask?: string | null
}

export function SubAgentSessionDialog({
  open,
  onOpenChange,
  childConversationId,
  childConnectionId,
  agentType,
  kickoffTask,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeButtonClassName="top-2 right-2"
        className="flex h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl p-0 lg:max-w-4xl"
      >
        <DialogTitle className="sr-only">{t("detailTitle")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("detailDescription")}
        </DialogDescription>
        {open ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-3 border-b border-border px-5 py-2.5 pr-12">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
                {agentType ? (
                  <AgentIcon agentType={agentType} className="h-4 w-4" />
                ) : (
                  <span className="h-2 w-2 rounded-sm bg-muted-foreground/60" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                {agentType ? getAgentLabel(agentType) : t("unknownAgent")}
              </span>
            </div>
            <LiveTranscriptView
              conversationId={childConversationId}
              connectionId={childConnectionId}
              agentType={agentType}
              kickoffText={kickoffTask}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
