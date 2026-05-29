"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRight,
  ChevronUp,
  FolderIcon,
  FolderOpenIcon,
  Home,
  Loader2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  createFolderDirectory,
  getHomeDirectory,
  listDirectoryEntries,
} from "@/lib/api"
import type { DirectoryEntry } from "@/lib/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

interface DirectoryBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  title?: string
  initialPath?: string
}

interface DirectoryBrowserEntryRowProps {
  depth: number
  entry: DirectoryEntry
  isExpanded: boolean
  isSelected: boolean
  isLoading: boolean
  onSelect: (path: string) => void
  onDoubleClick: (path: string) => void
  onToggleExpand: (path: string) => void
  onBeginCreateChildDirectory: (path: string) => void
  translate: (key: string) => string
}

/**
 * Join a parent directory path and a child name without assuming local OS paths.
 *
 * The in-app browser may point at remote Unix or Windows paths, so the returned
 * path preserves the separator style already present in `parent`. Empty trailing
 * separators are removed before appending `child`.
 */
function joinChildDirectory(parent: string, child: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`
}

/**
 * Validate a new child folder name before sending the final path to the backend.
 *
 * `translate` returns localized validation text. The backend still validates the
 * complete path; this only catches empty names and path separators immediately.
 */
function validateNewFolderName(
  name: string,
  translate: (key: string) => string
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return translate("newFolderNameRequired")
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return translate("newFolderNameInvalid")
  }
  return null
}

/**
 * Render one directory row plus its context-menu commands.
 *
 * The row delegates selection, expansion, double-click confirmation, and child
 * creation to callbacks so the parent keeps ownership of tree and dialog state.
 */
function DirectoryBrowserEntryRow({
  depth,
  entry,
  isExpanded,
  isSelected,
  isLoading,
  onSelect,
  onDoubleClick,
  onToggleExpand,
  onBeginCreateChildDirectory,
  translate,
}: DirectoryBrowserEntryRowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50",
            isSelected && "bg-accent text-accent-foreground"
          )}
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
          onClick={() => onSelect(entry.path)}
          onDoubleClick={() => onDoubleClick(entry.path)}
          type="button"
        >
          <DirectoryExpandToggle
            entry={entry}
            isExpanded={isExpanded}
            isLoading={isLoading}
            onToggleExpand={onToggleExpand}
          />
          {isExpanded ? (
            <FolderOpenIcon className="size-4 shrink-0 text-blue-500" />
          ) : (
            <FolderIcon className="size-4 shrink-0 text-blue-500" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onDoubleClick(entry.path)}>
          {translate("selectThisFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onBeginCreateChildDirectory(entry.path)}
        >
          {translate("newChildFolder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Render the disclosure affordance for a directory row.
 *
 * The toggle stops event propagation so expanding a directory does not also
 * select the row. Entries without children keep layout width via invisibility.
 */
function DirectoryExpandToggle({
  entry,
  isExpanded,
  isLoading,
  onToggleExpand,
}: {
  entry: DirectoryEntry
  isExpanded: boolean
  isLoading: boolean
  onToggleExpand: (path: string) => void
}) {
  const toggle = () => {
    if (!isLoading && entry.hasChildren) onToggleExpand(entry.path)
  }

  return (
    <span
      className="shrink-0 p-0.5"
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation()
          toggle()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <ChevronRight
        className={cn(
          "size-3.5 text-muted-foreground transition-transform",
          isExpanded && "rotate-90",
          !entry.hasChildren && "invisible"
        )}
      />
    </span>
  )
}

/**
 * Render an in-app directory chooser with expandable folders and create actions.
 *
 * The dialog browses server-side paths via API calls, reports selection through
 * `onSelect`, and only closes itself after explicit selection or double-click.
 */
export function DirectoryBrowserDialog({
  open,
  onOpenChange,
  onSelect,
  title,
  initialPath,
}: DirectoryBrowserDialogProps) {
  const t = useTranslations("DirectoryBrowser")

  const [rootPath, setRootPath] = useState("")
  const [pathInput, setPathInput] = useState("")
  const [entries, setEntries] = useState<Map<string, DirectoryEntry[]>>(
    new Map()
  )
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [createParentPath, setCreateParentPath] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState("")

  const initialized = useRef(false)

  /**
   * Load directory entries with optional cache bypass for refreshes.
   *
   * `options.force` skips the current `entries` cache, updates loading/error
   * state around the API call, and returns `null` when the directory cannot be
   * read so navigation callers can avoid changing roots after failures.
   */
  const loadEntries = useCallback(
    async (
      path: string,
      options: { force?: boolean } = {}
    ): Promise<DirectoryEntry[] | null> => {
      if (!options.force && entries.has(path)) return entries.get(path)!

      setLoading((prev) => new Set(prev).add(path))
      setError(null)
      try {
        const result = await listDirectoryEntries(path)
        setEntries((prev) => new Map(prev).set(path, result))
        return result
      } catch {
        setError(t("errorLoadingDir"))
        return null
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [entries, t]
  )

  const navigateTo = useCallback(
    async (path: string) => {
      const result = await loadEntries(path)
      if (result !== null) {
        setRootPath(path)
        setPathInput(path)
        setExpandedPaths(new Set())
        setSelectedPath(null)
      }
    },
    [loadEntries]
  )

  // Initialize on open
  useEffect(() => {
    if (!open) {
      initialized.current = false
      return
    }
    if (initialized.current) return
    initialized.current = true

    const init = async () => {
      try {
        const startPath = initialPath || (await getHomeDirectory())
        setRootPath(startPath)
        setPathInput(startPath)
        setSelectedPath(null)
        setExpandedPaths(new Set())
        setEntries(new Map())
        setError(null)
        setLoading(new Set([startPath]))

        const result = await listDirectoryEntries(startPath)
        setEntries(new Map([[startPath, result]]))
        setLoading(new Set())
      } catch {
        setError(t("errorLoadingDir"))
        setLoading(new Set())
      }
    }
    init()
  }, [open, initialPath, t])

  const handleToggleExpand = useCallback(
    async (path: string) => {
      const newExpanded = new Set(expandedPaths)
      if (newExpanded.has(path)) {
        newExpanded.delete(path)
        setExpandedPaths(newExpanded)
      } else {
        await loadEntries(path)
        newExpanded.add(path)
        setExpandedPaths(newExpanded)
      }
    },
    [expandedPaths, loadEntries]
  )

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path === selectedPath ? null : path)
    },
    [selectedPath]
  )

  const handleConfirm = useCallback(() => {
    if (selectedPath) {
      onSelect(selectedPath)
      onOpenChange(false)
    }
  }, [selectedPath, onSelect, onOpenChange])

  const handleNavigateUp = useCallback(() => {
    if (!rootPath) return
    const parts = rootPath.replace(/\/$/, "").split("/")
    if (parts.length <= 1) return
    parts.pop()
    const parent = parts.join("/") || "/"
    navigateTo(parent)
  }, [rootPath, navigateTo])

  const handleGoHome = useCallback(async () => {
    try {
      const home = await getHomeDirectory()
      navigateTo(home)
    } catch {
      setError(t("errorLoadingDir"))
    }
  }, [navigateTo, t])

  const handlePathInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && pathInput.trim()) {
        navigateTo(pathInput.trim())
      }
    },
    [pathInput, navigateTo]
  )

  const handleDoubleClick = useCallback(
    (path: string) => {
      onSelect(path)
      onOpenChange(false)
    },
    [onSelect, onOpenChange]
  )

  /**
   * Start inline creation for a child folder under `parentPath`.
   *
   * This also selects the parent so users can see which directory receives the
   * new child; existing input is cleared to avoid reusing stale names.
   */
  const beginCreateChildDirectory = useCallback((parentPath: string) => {
    setCreateParentPath(parentPath)
    setNewFolderName("")
    setSelectedPath(parentPath)
    setError(null)
  }, [])

  /**
   * Create the requested child directory and refresh only the affected parent.
   *
   * Validation errors stay in the dialog. On success, the new directory becomes
   * selected and the parent cache is force-refreshed so new contents appear.
   */
  const handleCreateChildDirectory = useCallback(async () => {
    if (!createParentPath) return
    const validationError = validateNewFolderName(newFolderName, t)
    if (validationError) return setError(validationError)

    const target = joinChildDirectory(createParentPath, newFolderName.trim())
    setError(null)
    try {
      await createFolderDirectory(target)
      await loadEntries(createParentPath, { force: true })
      setSelectedPath(target)
      setCreateParentPath(null)
      setNewFolderName("")
    } catch {
      setError(t("errorCreatingDir"))
    }
  }, [createParentPath, loadEntries, newFolderName, t])

  /**
   * Render cached child directories for `parentPath` at the requested tree depth.
   *
   * Loading and empty states are rendered in-place, while each real directory row
   * exposes selection, expansion, double-click selection, and context-menu actions.
   */
  const renderEntries = (parentPath: string, depth: number) => {
    const children = entries.get(parentPath)
    const isLoading = loading.has(parentPath)

    if (isLoading) {
      return (
        <div
          className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          <span>{t("loading")}</span>
        </div>
      )
    }

    if (!children) return null

    if (children.length === 0) {
      return (
        <div
          className="py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * 20 + 28}px` }}
        >
          {t("emptyDirectory")}
        </div>
      )
    }

    return children.map((entry) => {
      const isExpanded = expandedPaths.has(entry.path)
      const isSelected = selectedPath === entry.path

      return (
        <div key={entry.path}>
          <DirectoryBrowserEntryRow
            depth={depth}
            entry={entry}
            isExpanded={isExpanded}
            isSelected={isSelected}
            isLoading={loading.has(entry.path)}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onToggleExpand={handleToggleExpand}
            onBeginCreateChildDirectory={beginCreateChildDirectory}
            translate={t}
          />
          {isExpanded && renderEntries(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t("title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleGoHome}
              title={t("goHome")}
              type="button"
            >
              <Home className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleNavigateUp}
              title={t("navigateUp")}
              type="button"
            >
              <ChevronUp className="size-4" />
            </Button>
            <Input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={handlePathInputKeyDown}
              placeholder={t("pathPlaceholder")}
              className="flex-1 h-8 text-sm font-mono"
            />
          </div>

          <ScrollArea className="h-[300px] rounded-md border">
            <div className="p-1">
              {renderEntries(rootPath, 0)}
              {error && !loading.size && (
                <div className="p-4 text-center text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          </ScrollArea>

          {selectedPath && (
            <p className="truncate text-xs text-muted-foreground">
              {selectedPath}
            </p>
          )}

          {createParentPath && (
            <div className="flex items-center gap-2 rounded-md border p-2">
              <Input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateChildDirectory()
                  if (e.key === "Escape") setCreateParentPath(null)
                }}
                placeholder={t("newFolderNamePlaceholder")}
                className="h-8 text-sm"
              />
              <Button
                size="sm"
                onClick={handleCreateChildDirectory}
                type="button"
              >
                {t("create")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreateParentPath(null)}
                type="button"
              >
                {t("cancel")}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedPath}
            type="button"
          >
            {t("select")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
