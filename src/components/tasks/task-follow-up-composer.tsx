"use client"

import { useEffect, useRef, type RefObject } from "react"

import {
  ComposerInvocationsPopup,
  useComposerInvocations,
} from "@/components/automations/composer-invocations"
import {
  isComposerChromeClick,
  restampSkillPrefixes,
} from "@/components/chat/composer/composer-commands"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { useComposerMentionLabels } from "@/components/chat/composer/use-composer-mention-labels"
import { useReferenceSearch } from "@/components/chat/composer/use-reference-search"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import type { AgentType } from "@/lib/types"

export interface TaskFollowUpComposerProps {
  /** Agent the task runs as — decides the skill trigger and which CLI is probed. */
  agentType: AgentType
  /**
   * Host-owned handle to the editor (same shape the invocations hook takes), so
   * the host can read the serialized text at send time. Omit for an entirely
   * self-contained box.
   */
  editorRef?: RefObject<RichComposerHandle | null>
  /** Working directory the references and commands are resolved against. */
  folderPath: string | null
  /** Content on mount; read once (the editor is uncontrolled afterwards). */
  defaultText: string
  placeholder: string
  /** Accessible name for the editing surface. */
  ariaLabel: string
  autoFocus?: boolean
  /** Key binding that sends. Omit `onSubmit` to make every Enter a newline. */
  submitShortcut?: string
  newlineShortcut?: string
  onChange: (text: string) => void
  onSubmit?: () => void
}

/**
 * The follow-up / note box of the task detail drawer, with the same invocation
 * surface as the conversation composer: `@` references (files, agents,
 * sessions, commits), `/` slash commands from the agent's own probe, and `$`
 * skills on Codex (every other agent advertises its skills as `/` commands).
 *
 * The step this box drives — "here is what to do next" — is exactly where
 * naming a file or a command matters most, so it gets the real composer rather
 * than a textarea. Nothing about the wire format changes: badges serialize back
 * to `[label](file:///…)` / `/cmd` / `$skill` (`referenceToMarkdown`), which is
 * the same text the chat composer sends, and the backend still receives one
 * string.
 *
 * The transient agent probe runs on mount, and the host only mounts this while
 * the box is open — opening the drawer alone never spawns a CLI.
 */
export function TaskFollowUpComposer({
  agentType,
  editorRef: hostRef,
  folderPath,
  defaultText,
  placeholder,
  ariaLabel,
  autoFocus,
  submitShortcut,
  newlineShortcut,
  onChange,
  onSubmit,
}: TaskFollowUpComposerProps) {
  const ownRef = useRef<RichComposerHandle>(null)
  const editorRef = hostRef ?? ownRef

  const { groupLabels, uiLabels } = useComposerMentionLabels()
  const referenceSearch = useReferenceSearch({
    defaultPath: folderPath,
    enabled: true,
    labels: groupLabels,
  })

  // One transient probe backs the `/` menu (the snapshot carries
  // available_commands); `$` skills are a filesystem scan inside the hook.
  const agentOptions = useAgentOptions(agentType, folderPath)
  const invocations = useComposerInvocations({
    editorRef,
    agentType,
    folderPath,
    availableCommands: agentOptions.snapshot?.available_commands ?? [],
  })

  // Keep already-inserted skill badges on the current agent's trigger (`$` is
  // Codex's; everyone else invokes skills as `/`).
  useEffect(() => {
    const editor = editorRef.current?.getEditor()
    if (editor) restampSkillPrefixes(editor, agentType === "codex" ? "$" : "/")
  }, [agentType, editorRef])

  return (
    <div
      onMouseDown={(e) => {
        // Clicking the box's padding focuses the nearest caret, like a textarea.
        if (!isComposerChromeClick(e.target)) return
        e.preventDefault()
        editorRef.current?.focusAtCoords(e.clientX, e.clientY)
      }}
      // Same shell the drawer's Textarea had (and the same rounding as every
      // other box in it); the editor brings the matching px-3 padding.
      className="codeg-composer-chrome relative rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50"
    >
      <ComposerInvocationsPopup inv={invocations} />
      {/* Keyed by the placeholder because Tiptap bakes it into an extension at
          creation and never re-reads it: the scenario chips above this box each
          bring their own prompt, and a stale one would describe the wrong
          scenario. What the user typed survives the remount — `defaultText` is
          the host's live text, and serialized references rehydrate as badges. */}
      <RichComposer
        key={placeholder}
        ref={editorRef}
        defaultText={defaultText}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        referenceSearch={referenceSearch}
        mentionUiLabels={uiLabels}
        tabLabels={groupLabels}
        submitShortcut={submitShortcut}
        newlineShortcut={newlineShortcut}
        onChange={(text) => {
          onChange(text)
          invocations.detect()
        }}
        onSubmit={onSubmit}
        isExternalMenuOpen={invocations.isOpen}
        onExternalMenuKeyDown={invocations.onKeyDown}
        className="max-h-[12rem] min-h-[4.5rem]"
      />
    </div>
  )
}
