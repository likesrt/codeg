"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  listFolderCommands,
  workTaskSettingsDelete,
  workTaskSettingsGet,
  workTaskSettingsGetOwn,
  workTaskSettingsSet,
} from "@/lib/api"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { AgentType, WorkTaskFolderSettings } from "@/lib/types"

/** Sentinel folder id of the global-defaults settings row (backend contract). */
const GLOBAL_SCOPE = 0

interface TaskSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Board's current folder selection; null = "all folders" → global scope. */
  folderId: number | null
}

/**
 * Task defaults, per folder or global: the default processing agent + its
 * ACP-probed mode/model options, auto-process, max concurrency, merge/cleanup
 * defaults, worktree init command and the preflight command. The scope
 * selector at the top switches which settings row is being edited; the global
 * row (folder id 0) applies wholesale to folders that never saved their own.
 */
export function TaskSettingsDialog({
  open,
  onOpenChange,
  folderId,
}: TaskSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[30rem]">
        {open ? (
          <TaskSettingsScoped
            initialFolderId={folderId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskSettingsScoped({
  initialFolderId,
  onClose,
}: {
  initialFolderId: number | null
  onClose: () => void
}) {
  // Mounted fresh per dialog open, so the scope re-seeds from the board's
  // selection every time; switching remounts the body wholesale (clean load).
  const [scope, setScope] = useState<number>(initialFolderId ?? GLOBAL_SCOPE)
  return (
    <TaskSettingsBody
      key={scope}
      folderId={scope}
      onScopeChange={setScope}
      onClose={onClose}
    />
  )
}

function TaskSettingsBody({
  folderId,
  onScopeChange,
  onClose,
}: {
  /** `GLOBAL_SCOPE` (0) edits the global-defaults row. */
  folderId: number
  onScopeChange: (folderId: number) => void
  onClose: () => void
}) {
  const t = useTranslations("Tasks")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const isGlobal = folderId === GLOBAL_SCOPE
  const folder = useMemo(
    () => (isGlobal ? null : (folders.find((f) => f.id === folderId) ?? null)),
    [folders, folderId, isGlobal]
  )
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  const [loaded, setLoaded] = useState<WorkTaskFolderSettings | null>(null)
  // Folder scope only: whether this folder follows the global defaults or has
  // its own settings row. Seeded from what actually exists in the DB, so the
  // dialog shows the true source instead of guessing.
  const [source, setSource] = useState<"global" | "custom">("custom")
  const [agentType, setAgentType] = useState<AgentType>("claude_code")
  const [modeId, setModeId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [autoProcess, setAutoProcess] = useState(false)
  const [maxConcurrent, setMaxConcurrent] = useState("2")
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge">(
    "squash"
  )
  const [deleteWorktreeDefault, setDeleteWorktreeDefault] = useState(true)
  const [initCommand, setInitCommand] = useState("")
  const [preflightCommand, setPreflightCommand] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Folder scope loads the folder's OWN row (may be absent) plus the global
    // row: the own row decides the source indicator, and the global values
    // seed the form when the folder has nothing of its own — so flipping to
    // "custom" starts from what actually applies today. Folder commands are
    // only fetched to migrate a legacy id-based preflight selection into the
    // free-text field (saving always writes text now).
    Promise.all([
      isGlobal ? Promise.resolve(null) : workTaskSettingsGetOwn(folderId),
      workTaskSettingsGet(GLOBAL_SCOPE),
      isGlobal
        ? Promise.resolve([])
        : listFolderCommands(folderId).catch(() => []),
    ])
      .then(([own, global, commands]) => {
        if (cancelled) return
        const s = isGlobal ? global : (own ?? global)
        setLoaded(s)
        setSource(isGlobal || own != null ? "custom" : "global")
        setAgentType(
          s.default_agent_type ?? folder?.default_agent_type ?? "claude_code"
        )
        setModeId(s.mode_id ?? null)
        setConfigValues(s.config_values ?? {})
        setAutoProcess(s.auto_process)
        setMaxConcurrent(String(s.max_concurrent))
        setMergeStrategy(s.merge_strategy === "merge" ? "merge" : "squash")
        setDeleteWorktreeDefault(s.delete_worktree_default)
        setInitCommand(s.init_command ?? "")
        const legacy =
          s.preflight_command_id != null
            ? (commands.find((c) => c.id === s.preflight_command_id)?.command ??
              "")
            : ""
        setPreflightCommand(s.preflight_command?.trim() || legacy)
      })
      .catch((e) => {
        if (!cancelled) toast.error(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [folderId, folder?.default_agent_type, isGlobal])

  // The form (and thus the config surface) is live for the global scope and
  // for a folder editing its own settings; while a folder follows the global
  // defaults the form is hidden and the agent probe is skipped.
  const editing = isGlobal || source === "custom"

  const agentOptions = useAgentOptions(
    agentType,
    folder?.path ?? null,
    loaded != null && editing
  )

  const save = async () => {
    setSaving(true)
    try {
      // "Use global defaults" saves by dropping the folder's own row.
      if (!isGlobal && source === "global") {
        await workTaskSettingsDelete(folderId)
        onClose()
        return
      }
      const snapshot = await agentOptions.ensure()
      const { mode_id, config_values } = effectiveSelections(
        snapshot,
        modeId,
        configValues
      )
      const parsed = Number.parseInt(maxConcurrent, 10)
      const settings: WorkTaskFolderSettings = {
        default_agent_type: agentType,
        mode_id,
        config_values,
        label_snapshot: {
          agent_label: getAgentLabel(agentType) ?? agentType,
          ...snapshotLabels(snapshot, mode_id, config_values),
        },
        auto_process: autoProcess,
        max_concurrent: Number.isFinite(parsed) && parsed >= 0 ? parsed : 2,
        merge_strategy: mergeStrategy,
        delete_worktree_default: deleteWorktreeDefault,
        // Free text is the only surface now; a legacy id was migrated into
        // the text field on load, so the id is always cleared on save.
        preflight_command_id: null,
        preflight_command: preflightCommand.trim() || null,
        init_command: initCommand.trim() || null,
      }
      await workTaskSettingsSet(folderId, settings)
      onClose()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("settingsTitle")}</DialogTitle>
        <DialogDescription>
          {folder
            ? t("settingsDescription", { folder: folder.name })
            : t("settingsScopeGlobalHint")}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm">{t("settingsScope")}</Label>
          <Select
            value={String(folderId)}
            onValueChange={(v) => onScopeChange(Number(v))}
          >
            <SelectTrigger size="sm" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={String(GLOBAL_SCOPE)}>
                {t("settingsScopeGlobal")}
              </SelectItem>
              {projectFolders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.alias ?? f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Folder scope: which source is in effect — following the global
            defaults, or this folder's own row. Seeded from the DB truth. */}
        {!isGlobal ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm">{t("settingsSource")}</Label>
              <Tabs
                value={source}
                onValueChange={(v) =>
                  setSource(v === "global" ? "global" : "custom")
                }
              >
                <TabsList>
                  <TabsTrigger value="global" className="px-2.5 text-xs">
                    {t("settingsSourceGlobal")}
                  </TabsTrigger>
                  <TabsTrigger value="custom" className="px-2.5 text-xs">
                    {t("settingsSourceCustom")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <span className="text-xs text-muted-foreground">
              {source === "global"
                ? t("settingsSourceGlobalFollow")
                : t("settingsSourceCustomHint")}
            </span>
          </div>
        ) : null}

        {editing ? (
          <>
            <div className="flex flex-col gap-2">
              <Label className="text-sm">{t("settingsAgent")}</Label>
              <div className="flex">
                <AgentSelector
                  defaultAgentType={agentType}
                  onSelect={(a) => {
                    setAgentType(a)
                    setModeId(null)
                    setConfigValues({})
                  }}
                  onFallback={setAgentType}
                />
              </div>
              <AgentConfigSection
                snapshot={agentOptions.snapshot}
                loading={agentOptions.loading}
                error={agentOptions.error}
                onReload={agentOptions.reload}
                modeId={modeId}
                configValues={configValues}
                layout="inline"
                onModeChange={setModeId}
                onConfigChange={(optionId, valueId) =>
                  setConfigValues((prev) => {
                    const next = { ...prev }
                    if (valueId === null) delete next[optionId]
                    else next[optionId] = valueId
                    return next
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <Label htmlFor="task-auto-process" className="text-sm">
                  {t("settingsAutoProcess")}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t("settingsAutoProcessHint")}
                </span>
              </div>
              <Switch
                id="task-auto-process"
                checked={autoProcess}
                onCheckedChange={setAutoProcess}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <Label htmlFor="task-max-concurrent" className="text-sm">
                  {t("settingsMaxConcurrent")}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t("settingsMaxConcurrentHint")}
                </span>
              </div>
              <Input
                id="task-max-concurrent"
                inputMode="numeric"
                value={maxConcurrent}
                onChange={(e) =>
                  setMaxConcurrent(e.target.value.replace(/[^0-9]/g, ""))
                }
                className="w-20 text-right"
              />
            </div>

            {/* Plain-language options (no git jargon); the hint under the
                row explains whichever one is selected — same pattern as the
                settings-source switcher above. */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">{t("settingsMergeStrategy")}</Label>
                <Select
                  value={mergeStrategy}
                  onValueChange={(v) =>
                    setMergeStrategy(v === "merge" ? "merge" : "squash")
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="squash">
                      {t("strategySquash")}
                    </SelectItem>
                    <SelectItem value="merge">{t("strategyMerge")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span className="text-xs text-muted-foreground">
                {mergeStrategy === "squash"
                  ? t("strategySquashHint")
                  : t("strategyMergeHint")}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-init-command" className="text-sm">
                {t("settingsInitCommand")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settingsInitCommandHint")}
              </span>
              <Input
                id="task-init-command"
                value={initCommand}
                onChange={(e) => setInitCommand(e.target.value)}
                placeholder={t("settingsInitCommandPlaceholder")}
                className="font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-preflight-command" className="text-sm">
                {t("settingsPreflight")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settingsPreflightHint")}
              </span>
              <Input
                id="task-preflight-command"
                value={preflightCommand}
                onChange={(e) => setPreflightCommand(e.target.value)}
                placeholder={t("settingsPreflightCustomPlaceholder")}
                className="font-mono text-xs"
              />
            </div>

            <Label className="text-sm font-normal">
              <Checkbox
                checked={deleteWorktreeDefault}
                onCheckedChange={(v) => setDeleteWorktreeDefault(v === true)}
              />
              {t("settingsDeleteWorktree")}
            </Label>
          </>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={saving || loaded == null}
        >
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
