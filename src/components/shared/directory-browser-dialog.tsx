"use client"

import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react"
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
  deleteFileTreeEntry,
  getHomeDirectory,
  listDirectoryEntries,
} from "@/lib/api"
import { parentFsPath } from "@/lib/path-utils"
import type { DirectoryEntry } from "@/lib/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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

type DirectoryBrowserTranslator = ReturnType<
  typeof useTranslations<"DirectoryBrowser">
>

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
  onBeginDeleteDirectory: (entry: DirectoryEntry) => void
  translate: DirectoryBrowserTranslator
}

/**
 * 将父目录路径与子目录名拼接，兼容 Unix 和 Windows 路径分隔符。
 *
 * 关键参数为父路径与已验证的子目录名；返回绝对子路径。边界上会保留父路径的
 * 分隔符风格，副作用为无。
 */
function joinChildDirectory(parent: string, child: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`
}

/**
 * 在发送最终路径到后端前验证新子文件夹名称。
 *
 * 关键参数为用户输入名称和本地化函数；返回错误文案或 null。边界上拒绝空名称
 * 与路径分隔符，后端仍会执行最终安全校验。
 */
function validateNewFolderName(
  name: string,
  translate: DirectoryBrowserTranslator
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return translate("newFolderNameRequired")
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return translate("newFolderNameInvalid")
  }
  return null
}

/**
 * 规范化目录浏览器中的路径以便跨平台比较。
 *
 * 关键参数为原始路径；返回仅用于比较的路径。边界上保留根目录，副作用为无，
 * 不会改变真实文件系统路径。
 */
function normalizeDirectoryBrowserPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || path
}

/**
 * 将绝对目标目录转换成文件树删除 API 需要的相对路径。
 *
 * 关键参数为浏览根路径和待删路径；返回相对路径。边界上如果目标不在根路径下，
 * 保留原路径交给后端拒绝，避免前端误裁剪。
 */
function getRelativeDirectoryPath(
  rootPath: string,
  targetPath: string
): string {
  const normalizedRoot = normalizeDirectoryBrowserPath(rootPath)
  const normalizedTarget = normalizeDirectoryBrowserPath(targetPath)
  if (normalizedTarget === normalizedRoot) return ""
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1)
  }
  return targetPath
}

/**
 * 判断候选路径是否等于目标目录或位于目标目录内部。
 *
 * 关键参数为候选路径和目标路径；返回布尔值。边界上会统一 Windows 与 Unix
 * 分隔符，副作用为无。
 */
function isSameOrDescendantPath(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizeDirectoryBrowserPath(candidate)
  const normalizedTarget = normalizeDirectoryBrowserPath(target)
  return (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.startsWith(`${normalizedTarget}/`)
  )
}

/**
 * 渲染单行目录条目及其右键菜单命令。
 *
 * 关键参数包含目录条目、层级和回调；返回 React 节点。副作用仅来自用户交互时
 * 调用父组件传入的选择、展开、新建、删除回调。
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
  onBeginDeleteDirectory,
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
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onBeginDeleteDirectory(entry)}
        >
          {translate("deleteDirectory")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 渲染目录行左侧的展开/折叠箭头图标。
 *
 * 关键参数为目录条目、展开状态、加载状态和展开回调；返回 React 节点。边界上
 * 没有子项时只保留占位宽度，副作用是阻止事件冒泡避免误选中行。
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

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * 内置目录选择对话框，支持展开文件夹、输入路径校验、创建子目录和删除目录。
 *
 * 关键参数控制打开状态、选择回调和初始路径；返回对话框节点。边界上通过会话号
 * 丢弃关闭重开后的过期异步结果，副作用为调用文件系统 API 与父组件回调。
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
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [createParentPath, setCreateParentPath] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DirectoryEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const initialized = useRef(false)
  const sessionGen = useRef(0)
  const navSeq = useRef(0)
  const creatingRef = useRef(false)
  const deletingRef = useRef(false)
  const prevOpen = useRef(open)
  const pathInputRef = useRef(pathInput)

  useIsomorphicLayoutEffect(() => {
    if (prevOpen.current !== open) {
      prevOpen.current = open
      sessionGen.current += 1
    }
  }, [open])

  useIsomorphicLayoutEffect(() => {
    pathInputRef.current = pathInput
  }, [pathInput])

  /**
   * 加载目录条目，可选跳过缓存进行强制刷新。
   *
   * 关键参数为目录路径和 force 选项；返回条目列表或 null。边界上过期会话不会写入
   * 状态，副作用为更新加载、错误和缓存状态。
   */
  const loadEntries = useCallback(
    async (
      path: string,
      options: { force?: boolean } = {}
    ): Promise<DirectoryEntry[] | null> => {
      if (!options.force && entries.has(path)) return entries.get(path)!

      const gen = sessionGen.current
      setLoading((prev) => new Set(prev).add(path))
      setError(null)
      try {
        const result = await listDirectoryEntries(path)
        if (gen === sessionGen.current) {
          setEntries((prev) => new Map(prev).set(path, result))
        }
        return result
      } catch {
        if (gen === sessionGen.current) setError(t("errorLoadingDir"))
        return null
      } finally {
        if (gen === sessionGen.current) {
          setLoading((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        }
      }
    },
    [entries, t]
  )

  const navigateTo = useCallback(
    async (path: string) => {
      const gen = sessionGen.current
      const seq = (navSeq.current += 1)
      const result = await loadEntries(path)
      if (gen !== sessionGen.current || seq !== navSeq.current) return
      if (result !== null) {
        setRootPath(path)
        setPathInput(path)
        setExpandedPaths(new Set())
      }
    },
    [loadEntries]
  )

  useEffect(() => {
    if (!open) {
      initialized.current = false
      return
    }
    if (initialized.current) return
    initialized.current = true

    const gen = sessionGen.current
    const seq = navSeq.current
    setRootPath("")
    setPathInput(initialPath ?? "")
    setExpandedPaths(new Set())
    setEntries(new Map())
    setError(null)
    setLoading(new Set())
    setConfirming(false)
    setCreateParentPath(null)
    setNewFolderName("")
    setDeleteTarget(null)

    const init = async () => {
      try {
        const startPath = initialPath || (await getHomeDirectory())
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setRootPath(startPath)
        setPathInput(startPath)
        setLoading(new Set([startPath]))

        const result = await listDirectoryEntries(startPath)
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setEntries(new Map([[startPath, result]]))
        setLoading(new Set())
      } catch {
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setError(t("errorLoadingDir"))
        setLoading(new Set())
      }
    }
    init()
  }, [open, initialPath, t])

  const handleToggleExpand = useCallback(
    async (path: string) => {
      if (expandedPaths.has(path)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return
      }
      const gen = sessionGen.current
      await loadEntries(path)
      if (gen !== sessionGen.current) return
      setExpandedPaths((prev) => new Set(prev).add(path))
    },
    [expandedPaths, loadEntries]
  )

  const handleSelect = useCallback((path: string) => {
    setPathInput(path)
  }, [])

  const handleConfirm = useCallback(async () => {
    const path = pathInput.trim()
    if (!path || confirming) return
    const gen = sessionGen.current
    setConfirming(true)
    const result = await loadEntries(path)
    if (gen !== sessionGen.current) return
    setConfirming(false)
    if (pathInputRef.current.trim() !== path) return
    if (result !== null) {
      onSelect(path)
      onOpenChange(false)
    }
  }, [pathInput, confirming, loadEntries, onSelect, onOpenChange])

  const handleNavigateUp = useCallback(() => {
    const parent = parentFsPath(pathInput.trim() || rootPath)
    if (!parent) return
    navigateTo(parent)
  }, [pathInput, rootPath, navigateTo])

  const handleGoHome = useCallback(async () => {
    const gen = sessionGen.current
    try {
      const home = await getHomeDirectory()
      if (gen !== sessionGen.current) return
      navigateTo(home)
    } catch {
      if (gen !== sessionGen.current) return
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

  const beginCreateChildDirectory = useCallback((parentPath: string) => {
    setCreateParentPath(parentPath)
    setNewFolderName("")
    setPathInput(parentPath)
    setError(null)
  }, [])

  const handleCreateChildDirectory = useCallback(async () => {
    if (!createParentPath || creatingRef.current) return
    const validationError = validateNewFolderName(newFolderName, t)
    if (validationError) return setError(validationError)

    const gen = sessionGen.current
    const target = joinChildDirectory(createParentPath, newFolderName.trim())
    creatingRef.current = true
    setCreating(true)
    setError(null)
    try {
      await createFolderDirectory(target)
      await loadEntries(createParentPath, { force: true })
      if (gen !== sessionGen.current) return
      setPathInput(target)
      setCreateParentPath(null)
      setNewFolderName("")
    } catch {
      if (gen === sessionGen.current) setError(t("errorCreatingDir"))
    } finally {
      if (gen === sessionGen.current) setCreating(false)
      creatingRef.current = false
    }
  }, [createParentPath, loadEntries, newFolderName, t])

  const beginDeleteDirectory = useCallback((entry: DirectoryEntry) => {
    setDeleteTarget(entry)
    setCreateParentPath(null)
    setNewFolderName("")
    setError(null)
  }, [])

  const handleDeleteDirectoryConfirm = useCallback(async () => {
    if (!deleteTarget || deletingRef.current) return
    const gen = sessionGen.current
    const target = deleteTarget
    const parentPath = parentFsPath(target.path) || rootPath
    const deletePath = getRelativeDirectoryPath(rootPath, target.path)
    deletingRef.current = true
    setDeleting(true)
    setError(null)
    try {
      await deleteFileTreeEntry(rootPath, deletePath)
      await loadEntries(parentPath, { force: true })
      if (gen !== sessionGen.current) return
      setEntries((current) => {
        const next = new Map(current)
        const normalizedParent = normalizeDirectoryBrowserPath(parentPath)
        for (const path of next.keys()) {
          if (
            normalizeDirectoryBrowserPath(path) !== normalizedParent &&
            isSameOrDescendantPath(path, target.path)
          ) {
            next.delete(path)
          }
        }
        return next
      })
      setPathInput((current) =>
        isSameOrDescendantPath(current, target.path) ? parentPath : current
      )
      setExpandedPaths((current) => {
        const next = new Set(current)
        for (const path of next) {
          if (isSameOrDescendantPath(path, target.path)) next.delete(path)
        }
        return next
      })
      setCreateParentPath((current) =>
        current && isSameOrDescendantPath(current, target.path) ? null : current
      )
      setDeleteTarget(null)
    } catch {
      if (gen === sessionGen.current) setError(t("errorDeletingDir"))
    } finally {
      if (gen === sessionGen.current) setDeleting(false)
      deletingRef.current = false
    }
  }, [deleteTarget, rootPath, loadEntries, t])

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
      const isSelected =
        normalizeDirectoryBrowserPath(entry.path) ===
        normalizeDirectoryBrowserPath(pathInput)

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
            onBeginDeleteDirectory={beginDeleteDirectory}
            translate={t}
          />
          {isExpanded && renderEntries(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <>
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

            {pathInput && (
              <p className="truncate text-xs text-muted-foreground">
                {pathInput}
              </p>
            )}

            {createParentPath && (
              <div className="flex items-center gap-2 rounded-md border p-2">
                <Input
                  value={newFolderName}
                  disabled={creating}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (creating) return
                    if (e.key === "Enter") void handleCreateChildDirectory()
                    if (e.key === "Escape") setCreateParentPath(null)
                  }}
                  placeholder={t("newFolderNamePlaceholder")}
                  className="h-8 text-sm"
                />
                <Button
                  size="sm"
                  onClick={handleCreateChildDirectory}
                  disabled={creating}
                  type="button"
                >
                  {creating ? t("loading") : t("create")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreateParentPath(null)}
                  disabled={creating}
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
              disabled={!pathInput.trim() || confirming}
              type="button"
            >
              {confirming ? t("loading") : t("select")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(nextOpen) => {
          if (nextOpen || deleting) return
          setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus disabled={deleting}>
              {t("cancelDelete")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void handleDeleteDirectoryConfirm()
              }}
              disabled={deleting}
            >
              {deleting ? t("loading") : t("confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
