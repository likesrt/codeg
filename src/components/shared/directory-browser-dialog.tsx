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
  deleteFileTreeEntry,
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
 * 目录浏览面板可能指向远程 Unix 或 Windows 路径，因此返回路径保留
 * `parent` 中已有的分隔符风格。拼接前会移除尾部多余分隔符。
 */
function joinChildDirectory(parent: string, child: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`
}

/**
 * 在发送最终路径到后端前验证新子文件夹名称。
 *
 * `translate` 返回本地化验证文本。后端仍会验证完整路径；
 * 此函数仅即时拦截空名称和路径分隔符。
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
 * 获取给定路径的父目录路径，兼容 Unix 和 Windows 路径分隔符。
 *
 * 如果路径已经是根目录（Unix "/" 或 Windows "C:\\" 等），返回原路径；
 * 否则移除最后一个路径段后返回父目录。
 */
function getParentDirectoryPath(path: string): string {
  // 检测路径使用的分隔符风格（优先判定为 Unix，除非仅含反斜杠）
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/"

  // Windows 绝对路径（如 "C:\\"）与 Unix 根 "/" 作为终止条件
  if (path === "/") return "/"
  if (/^[a-zA-Z]:\\?$/.test(path)) return path

  const parts = path.replace(/[\\/]$/, "").split(separator)
  parts.pop()
  if (parts.length === 0) return separator === "\\" ? path : "/"

  // Windows 盘符根：如 "C:" 后面需要追加分隔符
  const parent = parts.join(separator)
  if (/^[a-zA-Z]:$/.test(parent)) return parent + "\\"
  return parent || "/"
}

/**
 * 规范化目录浏览器中的路径以便跨平台比较。
 *
 * 该函数只用于前端状态清理：把反斜杠统一成斜杠，并移除尾部分隔符，
 * 不改变真实路径，也不会发起文件系统访问。
 */
function normalizeDirectoryBrowserPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * 将绝对目标目录转换成文件树删除 API 需要的相对路径。
 *
 * `deleteFileTreeEntry` 的后端以 `rootPath` 为根解析相对路径；目录浏览器拿到的是
 * 绝对路径，因此这里统一分隔符后裁掉根路径前缀，避免把绝对路径传给后端被拒绝。
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
 * 远程目录可能使用 Unix 或 Windows 分隔符，因此比较前统一分隔符并去掉尾部分隔符，
 * 避免删除 Windows 目录后遗漏其子路径状态。
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
 * 该行将选择、展开、双击确认、子目录创建以及目录删除委托给父组件的回调函数，
 * 使父组件能集中管理树状态和对话框状态。
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
        <ContextMenuItem onSelect={() => onBeginDeleteDirectory(entry)}>
          {translate("deleteDirectory")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 渲染目录行左侧的展开/折叠箭头图标。
 *
 * 点击或键盘操作时阻止事件冒泡，避免同时选中该行。
 * 没有子项的条目仅保留占位宽度（不可见）。
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
 * 内置目录选择对话框，支持展开文件夹、创建子目录和删除目录。
 *
 * 通过 API 调用浏览服务端路径，选择后通过 `onSelect` 通知调用方。
 * 仅在用户显式选择或双击后自行关闭。
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
  const [creating, setCreating] = useState(false)

  // 目录删除相关状态
  const [deleteTarget, setDeleteTarget] = useState<DirectoryEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const initialized = useRef(false)
  const creatingRef = useRef(false)
  const deletingRef = useRef(false)

  /**
   * 加载目录条目，可选跳过缓存进行强制刷新。
   *
   * `options.force` 跳过当前 `entries` 缓存，围绕 API 调用更新加载/错误状态，
   * 并在目录无法读取时返回 `null`，使导航调用方可避免在失败后更改根路径。
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
   * 在指定父目录下开始创建子文件夹的内联编辑。
   *
   * 同时选中父目录以便用户看到新建位置；
   * 清空已有输入避免重用旧名称。
   */
  const beginCreateChildDirectory = useCallback((parentPath: string) => {
    setCreateParentPath(parentPath)
    setNewFolderName("")
    setSelectedPath(parentPath)
    setError(null)
  }, [])

  /**
   * 创建子目录并仅刷新受影响的父目录。
   *
   * 验证错误保留在对话框中。ref 在 React 提交禁用 UI 前阻止重复提交。
   * 成功后选中新目录并对父缓存强制刷新以显示新条目。
   */
  const handleCreateChildDirectory = useCallback(async () => {
    if (!createParentPath || creatingRef.current) return
    const validationError = validateNewFolderName(newFolderName, t)
    if (validationError) return setError(validationError)

    const target = joinChildDirectory(createParentPath, newFolderName.trim())
    creatingRef.current = true
    setCreating(true)
    setError(null)
    try {
      await createFolderDirectory(target)
      await loadEntries(createParentPath, { force: true })
      setSelectedPath(target)
      setCreateParentPath(null)
      setNewFolderName("")
    } catch {
      setError(t("errorCreatingDir"))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [createParentPath, loadEntries, newFolderName, t])

  /**
   * 打开目录删除确认框，并不直接执行删除。
   *
   * 将待删除的目录条目存入 `deleteTarget`，同时清理新建目录状态，避免用户在
   * 同一个目录上同时进行新建和删除两种互斥操作。
   */
  const beginDeleteDirectory = useCallback((entry: DirectoryEntry) => {
    setDeleteTarget(entry)
    setCreateParentPath(null)
    setNewFolderName("")
    setError(null)
  }, [])

  /**
   * 确认删除选中的目录，完成后刷新父目录并清理失效状态。
   *
   * 通过 `deletingRef` 防重复提交；删除成功后对父目录进行强制刷新，
   * 并仅清除指向已删除目录的选择、展开、新建状态和条目缓存，避免影响其他有效目录状态。
   * 失败时设置错误信息为 `errorDeletingDir`。
   */
  const handleDeleteDirectoryConfirm = useCallback(async () => {
    if (!deleteTarget || deletingRef.current) return
    const target = deleteTarget
    const parentPath = getParentDirectoryPath(target.path)
    const deletePath = getRelativeDirectoryPath(rootPath, target.path)
    deletingRef.current = true
    setDeleting(true)
    setError(null)
    try {
      await deleteFileTreeEntry(rootPath, deletePath)
      await loadEntries(parentPath, { force: true })
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
      setSelectedPath((current) =>
        current && isSameOrDescendantPath(current, target.path) ? null : current
      )
      setExpandedPaths((current) => {
        const next = new Set(current)
        for (const path of next) {
          if (isSameOrDescendantPath(path, target.path)) {
            next.delete(path)
          }
        }
        return next
      })
      setCreateParentPath((current) =>
        current && isSameOrDescendantPath(current, target.path) ? null : current
      )
      setDeleteTarget(null)
    } catch {
      setError(t("errorDeletingDir"))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }, [deleteTarget, rootPath, loadEntries, t])

  /**
   * 渲染指定路径下的子目录列表，支持加载态、空目录态及正常行。
   *
   * 每行传递选择、展开、双击、创建和删除回调。
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

            {selectedPath && (
              <p className="truncate text-xs text-muted-foreground">
                {selectedPath}
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
              disabled={!selectedPath}
              type="button"
            >
              {t("select")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (open || deleting) return
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
