import { useCallback, useState } from "react"

export interface FileTreeClipboardSource {
  kind: "file" | "dir"
  name: string
  path: string
}

export interface FileTreeClipboardItem {
  mode: "copy" | "cut"
  sourcePath: string
  sourceName: string
  sourceKind: "file" | "dir"
}

/**
 * 维护辅助面板文件树的局部剪贴板状态。
 * @returns 当前剪贴板内容，以及复制、剪切、清空三个状态操作。
 * @remarks 状态只保存在当前组件树内，不写入全局 store 或系统剪贴板。
 */
export function useFileTreeClipboard() {
  const [clipboard, setClipboard] = useState<FileTreeClipboardItem | null>(null)

  /**
   * 记录一个复制来源。
   * @param source 文件树里的来源条目，包含类型、名称和工作区相对路径。
   * @returns 无返回值。
   * @remarks 会覆盖上一次复制或剪切状态，方便连续选择新的来源。
   */
  const copy = useCallback((source: FileTreeClipboardSource) => {
    setClipboard({
      mode: "copy",
      sourcePath: source.path,
      sourceName: source.name,
      sourceKind: source.kind,
    })
  }, [])

  /**
   * 记录一个剪切来源。
   * @param source 文件树里的来源条目，包含类型、名称和工作区相对路径。
   * @returns 无返回值。
   * @remarks 真正移动只在粘贴成功后发生；这里不会触碰文件系统。
   */
  const cut = useCallback((source: FileTreeClipboardSource) => {
    setClipboard({
      mode: "cut",
      sourcePath: source.path,
      sourceName: source.name,
      sourceKind: source.kind,
    })
  }, [])

  /**
   * 清空当前文件树剪贴板。
   * @returns 无返回值。
   * @remarks 剪切粘贴成功后调用；复制粘贴成功后通常保留以支持连续粘贴。
   */
  const clear = useCallback(() => {
    setClipboard(null)
  }, [])

  return { clipboard, copy, cut, clear }
}

/**
 * 计算文件树条目的默认粘贴目标目录。
 * @param target 用户右键或选中的文件树条目。
 * @returns 工作区相对目录路径；文件返回其父目录，目录返回自身路径。
 * @remarks 根目录以空字符串表示，便于直接传给后端粘贴命令。
 */
export function resolveFileTreePasteTarget(
  target: FileTreeClipboardSource
): string {
  if (target.kind === "dir") return target.path
  const splitIndex = Math.max(
    target.path.lastIndexOf("/"),
    target.path.lastIndexOf("\\")
  )
  if (splitIndex < 0) return ""
  return target.path.slice(0, splitIndex)
}
