"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { BookmarkPlus, Folder, LayoutTemplate, Trash2 } from "lucide-react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import {
  isComposerChromeClick,
  restampSkillPrefixes,
} from "@/components/chat/composer/composer-commands"
import {
  ComposerInvocationsPopup,
  useComposerInvocations,
} from "@/components/automations/composer-invocations"
import {
  useReferenceSearch,
  type ReferenceGroupLabels,
} from "@/components/chat/composer/use-reference-search"
import { docToPromptBlocks } from "@/components/chat/composer/to-prompt-blocks"
import type { MentionUiLabels } from "@/components/chat/composer/suggestion/types"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useScrollbarSafeDismiss } from "@/hooks/use-scrollbar-safe-dismiss"
import {
  workTaskSettingsEffective,
  workTaskTemplateDelete,
  workTaskTemplateList,
  workTaskTemplateSave,
} from "@/lib/api"
import type {
  AgentType,
  PromptInputBlock,
  WorkTask,
  WorkTaskConfig,
  WorkTaskDraft,
  WorkTaskTemplate,
} from "@/lib/types"

interface TaskEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing task to edit, or null for a blank create. */
  task: WorkTask | null
  /** Preselected folder for a create (the board's folder filter). */
  defaultFolderId: number | null
  /** Seed text for a create (the "task from message" hand-off). */
  prefillText?: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
}

/**
 * Create/edit a task, laid out like the automation editor: borderless title,
 * the agent pill above the real conversation composer (rich text +
 * @-mentions) with the ACP-probed mode/model bar inside the box, and a Target
 * section for the folder. The agent controls prefill from the folder's
 * EFFECTIVE task settings; untouched they keep inheriting (nothing is frozen
 * into the task), and only an explicit change is saved as a per-task override.
 */
export function TaskEditorDialog({
  open,
  onOpenChange,
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
}: TaskEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem]">
        {/* Remount per open so a reopened editor never leaks previous state. */}
        {open ? (
          <TaskEditorBody
            task={task}
            defaultFolderId={defaultFolderId}
            prefillText={prefillText ?? null}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskEditorBody({
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
  onCancel,
}: {
  task: WorkTask | null
  defaultFolderId: number | null
  prefillText: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("Tasks")
  const tComposer = useTranslations("Folder.chat.messageInput")
  const folders = useAppWorkspaceStore((s) => s.folders)
  // Tasks bind to project roots only (never worktrees / chat scratch dirs).
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  // A create seeded from a chat message: the text becomes the description and
  // its first line (trimmed) the suggested title.
  const seededText = task == null ? (prefillText ?? "") : ""
  const [title, setTitle] = useState(
    task?.title ?? seededText.split("\n")[0]?.trim().slice(0, 80) ?? ""
  )
  const [prompt, setPrompt] = useState(task?.config?.display_text ?? seededText)
  const [folderId, setFolderId] = useState<number | null>(
    task?.folder_id ?? defaultFolderId ?? projectFolders[0]?.id ?? null
  )
  // `agentDirty` = the user explicitly chose agent/mode/config for THIS task.
  // While clean, the controls display the folder's effective task settings and
  // the draft keeps inheriting (agent_type null) — nothing is frozen.
  const [agentDirty, setAgentDirty] = useState(task?.config?.agent_type != null)
  const [agentType, setAgentType] = useState<AgentType>(
    task?.config?.agent_type ?? "claude_code"
  )
  const [modeId, setModeId] = useState<string | null>(
    task?.config?.mode_id ?? null
  )
  const [configValues, setConfigValues] = useState<Record<string, string>>(
    task?.config?.config_values ?? {}
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Saved blueprints (global). Applying one reseeds the composer via a key
  // bump — RichComposer only reads defaultText on mount.
  const [templates, setTemplates] = useState<WorkTaskTemplate[]>([])
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateBusy, setTemplateBusy] = useState(false)
  const [composerSeed, setComposerSeed] = useState(() => ({
    key: 0,
    text: task?.config?.display_text ?? seededText,
  }))
  const { contentRef, onPointerDownOutside, onFocusOutside } =
    useScrollbarSafeDismiss()

  const editorRef = useRef<RichComposerHandle>(null)

  useEffect(() => {
    let cancelled = false
    workTaskTemplateList()
      .then((list) => {
        if (!cancelled) setTemplates(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const folderDefaultAgent = useMemo(
    () => folders.find((f) => f.id === folderId)?.default_agent_type ?? null,
    [folders, folderId]
  )

  // Prefill the agent controls from the folder's effective settings while the
  // user hasn't touched them; follows folder switches and template resets
  // (the effect re-runs when `agentDirty` flips back to false).
  useEffect(() => {
    if (agentDirty || folderId == null) return
    let cancelled = false
    workTaskSettingsEffective(folderId)
      .then((s) => {
        if (cancelled) return
        setAgentType(
          s.default_agent_type ?? folderDefaultAgent ?? "claude_code"
        )
        setModeId(s.mode_id ?? null)
        setConfigValues(s.config_values ?? {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentDirty, folderId, folderDefaultAgent])

  const folderPath = useMemo(
    () => folders.find((f) => f.id === folderId)?.path ?? null,
    [folders, folderId]
  )

  const referenceGroupLabels = useMemo<ReferenceGroupLabels>(
    () => ({
      file: tComposer("mentionGroupFile"),
      agent: tComposer("mentionGroupAgent"),
      session: tComposer("mentionGroupSession"),
      commit: tComposer("mentionGroupCommit"),
      skill: tComposer("mentionGroupSkill"),
    }),
    [tComposer]
  )
  const mentionUiLabels = useMemo<MentionUiLabels>(
    () => ({
      empty: tComposer("mentionEmpty"),
      loading: tComposer("mentionLoading"),
      listbox: tComposer("mentionListLabel"),
      more: tComposer("mentionMore"),
      count: (count: number) => tComposer("mentionCount", { count }),
    }),
    [tComposer]
  )
  const referenceSearch = useReferenceSearch({
    defaultPath: folderPath,
    enabled: true,
    labels: referenceGroupLabels,
  })

  const agentOptions = useAgentOptions(agentType, folderPath, true)

  // `/` slash commands (from the agent-options probe already running above)
  // + Codex-only `$` skills, same behavior as the conversation composer.
  const invocations = useComposerInvocations({
    editorRef,
    agentType,
    folderPath,
    availableCommands: agentOptions.snapshot?.available_commands ?? [],
  })

  // Keep inserted skill badges' trigger prefix in sync when the agent flips
  // (`$` is Codex's trigger; every other agent advertises skills as `/`).
  useEffect(() => {
    const editor = editorRef.current?.getEditor()
    if (editor) restampSkillPrefixes(editor, agentType === "codex" ? "$" : "/")
  }, [agentType])

  // The captured composer + agent state as a `WorkTaskConfig` — the shared
  // payload of both the task draft and a saved template.
  const buildConfig = async (): Promise<WorkTaskConfig> => {
    const editor = editorRef.current?.getEditor()
    const displayText = (editorRef.current?.getText() ?? prompt).trim()
    const blocks: PromptInputBlock[] = editor
      ? docToPromptBlocks(editor)
      : [{ type: "text", text: displayText }]
    if (!agentDirty) {
      return {
        prompt_blocks: blocks,
        display_text: displayText,
        agent_type: null,
        mode_id: null,
        config_values: {},
      }
    }
    const snapshot = await agentOptions.ensure()
    const { mode_id, config_values } = effectiveSelections(
      snapshot,
      modeId,
      configValues
    )
    return {
      prompt_blocks: blocks,
      display_text: displayText,
      agent_type: agentType,
      mode_id,
      config_values,
      label_snapshot: {
        agent_label: getAgentLabel(agentType) ?? agentType,
        ...snapshotLabels(snapshot, mode_id, config_values),
      },
    }
  }

  const submit = async () => {
    setError(null)
    const displayText = (editorRef.current?.getText() ?? prompt).trim()
    if (!title.trim()) return setError(t("errorTitle"))
    if (!displayText) return setError(t("errorPrompt"))
    if (folderId == null) return setError(t("errorFolder"))

    setSaving(true)
    try {
      const draft: WorkTaskDraft = {
        folder_id: folderId,
        title: title.trim(),
        config: await buildConfig(),
      }
      await onSubmit(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const applyTemplate = (tpl: WorkTaskTemplate) => {
    const cfg = tpl.config
    const text = cfg?.display_text ?? ""
    setTitle(tpl.title)
    setPrompt(text)
    setComposerSeed((s) => ({ key: s.key + 1, text }))
    if (cfg?.agent_type != null) {
      setAgentDirty(true)
      setAgentType(cfg.agent_type)
      setModeId(cfg.mode_id ?? null)
      setConfigValues(cfg.config_values ?? {})
    } else {
      // Back to inheriting — the prefill effect reseeds from settings.
      setAgentDirty(false)
    }
    setTemplatesOpen(false)
  }

  // Saved under the current title (upsert by name) — re-saving the same title
  // updates that template instead of piling up copies.
  const saveTemplate = async () => {
    setError(null)
    const displayText = (editorRef.current?.getText() ?? prompt).trim()
    if (!title.trim()) return setError(t("errorTitle"))
    if (!displayText) return setError(t("errorPrompt"))
    setTemplateBusy(true)
    try {
      await workTaskTemplateSave({
        name: title.trim(),
        title: title.trim(),
        config: await buildConfig(),
      })
      setTemplates(await workTaskTemplateList())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTemplateBusy(false)
    }
  }

  const deleteTemplate = async (id: number) => {
    try {
      await workTaskTemplateDelete(id)
      setTemplates((prev) => prev.filter((tpl) => tpl.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
        <DialogTitle className="text-base">
          {task ? t("editorTitleEdit") : t("editorTitleNew")}
        </DialogTitle>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          aria-label={t("titleLabel")}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
        />

        {/* Agent pill above the composer, as in the automation editor. While
            untouched it mirrors the folder's effective task settings. */}
        <div className="flex flex-wrap items-center gap-2">
          <AgentSelector
            defaultAgentType={agentType}
            onSelect={(a) => {
              setAgentDirty(true)
              setAgentType(a)
              setModeId(null)
              setConfigValues({})
            }}
            // A system substitution (agent unavailable) must not count as a
            // user override choice.
            onFallback={setAgentType}
          />
          {agentDirty ? (
            <button
              type="button"
              onClick={() => setAgentDirty(false)}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("agentOverrideReset")}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("agentInheritedHint")}
            </span>
          )}
        </div>

        {/* The real conversation composer with the inline config bottom bar,
            matching the automation editor's box. */}
        <div
          onMouseDown={(e) => {
            if (!isComposerChromeClick(e.target)) return
            e.preventDefault()
            editorRef.current?.focusAtCoords(e.clientX, e.clientY)
          }}
          className="codeg-composer-chrome relative rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50"
        >
          <ComposerInvocationsPopup inv={invocations} />
          <RichComposer
            key={composerSeed.key}
            ref={editorRef}
            defaultText={composerSeed.text}
            placeholder={t("promptPlaceholder")}
            ariaLabel={t("promptLabel")}
            referenceSearch={referenceSearch}
            mentionUiLabels={mentionUiLabels}
            tabLabels={referenceGroupLabels}
            onChange={(text) => {
              setPrompt(text)
              invocations.detect()
            }}
            isExternalMenuOpen={invocations.isOpen}
            onExternalMenuKeyDown={invocations.onKeyDown}
            className="max-h-[14rem] min-h-[6rem]"
          />
          <div className="px-2 pb-2 pt-1">
            <AgentConfigSection
              snapshot={agentOptions.snapshot}
              loading={agentOptions.loading}
              error={agentOptions.error}
              onReload={agentOptions.reload}
              modeId={modeId}
              configValues={configValues}
              layout="inline"
              onModeChange={(m) => {
                setAgentDirty(true)
                setModeId(m)
              }}
              onConfigChange={(optionId, valueId) => {
                setAgentDirty(true)
                setConfigValues((prev) => {
                  const next = { ...prev }
                  if (valueId === null) delete next[optionId]
                  else next[optionId] = valueId
                  return next
                })
              }}
            />
          </div>
        </div>

        {/* Target — which project board the task lives on. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sectionTarget")}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={folderId != null ? String(folderId) : undefined}
              onValueChange={(v) => setFolderId(Number(v))}
              // A task that already ran is pinned to its folder (its worktree
              // lives there) — the backend rejects a move too.
              disabled={task != null && task.worktree_folder_id != null}
            >
              <SelectTrigger size="sm" className="h-7 gap-1.5 text-xs">
                <Folder
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <SelectValue placeholder={t("folderPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {projectFolders.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Popover open={templatesOpen} onOpenChange={setTemplatesOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <LayoutTemplate className="size-3.5" aria-hidden="true" />
              {t("templates")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            ref={contentRef}
            align="start"
            side="top"
            className="w-72 p-2"
            onPointerDownOutside={onPointerDownOutside}
            onFocusOutside={onFocusOutside}
          >
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {templates.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("templatesEmpty")}
                </p>
              ) : (
                templates.map((tpl) => (
                  <div key={tpl.id} className="group flex items-center gap-1">
                    {/* px-2 + gap-1.5 + a size-3.5 glyph puts this row's icon
                        and text on exactly the same two x positions as the
                        save entry below the divider. */}
                    <button
                      type="button"
                      onClick={() => applyTemplate(tpl)}
                      className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <LayoutTemplate
                        className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{tpl.name}</span>
                        {tpl.config?.display_text ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {tpl.config.display_text}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => void deleteTemplate(tpl.id)}
                      aria-label={t("templateDelete")}
                      title={t("templateDelete")}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            {/* pt-2 matches the popover's own p-2 below the button, so it sits
                the same distance from the divider as from the bottom edge;
                mt-2 mirrors that above the divider. */}
            <div className="mt-2 border-t border-border pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-1.5 px-2 text-xs"
                disabled={templateBusy || !title.trim() || !prompt.trim()}
                onClick={() => void saveTemplate()}
              >
                <BookmarkPlus className="size-3.5" aria-hidden="true" />
                {t("templateSaveCurrent")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={saving}>
            {t("save")}
          </Button>
        </div>
      </div>
    </>
  )
}
