"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

/** 冲突条目在前端对话框中的展示模型。 */
export interface PasteConflictItem {
  /** 冲突条目在源树中的相对路径，也是后端逐项解析的匹配键。 */
  path: string
  /** 源条目的工作区相对路径，用于让用户确认被粘贴的来源。 */
  sourcePath: string
  /** 目标条目的工作区相对路径，用于在覆盖前明确展示将被替换的位置。 */
  targetPath: string
  /** 冲突条目名称（路径最后一段）。 */
  name: string
  /** 条目类型。 */
  kind: "file" | "dir"
}

export type PasteConflictBatchStrategy = "overwrite" | "duplicate"
export type PerItemResolutions = {
  path: string
  strategy: PasteConflictBatchStrategy
}[]

export interface FileTreePasteConflictDialogProps {
  open: boolean
  conflicts: PasteConflictItem[]
  title?: string
  summaryDescription?: string
  overwriteAllLabel?: string
  duplicateAllLabel?: string
  choosePerItemLabel?: string
  cancelLabel?: string
  sourcePathLabel?: string
  targetPathLabel?: string
  overwriteLabel?: string
  duplicateLabel?: string
  backLabel?: string
  applyLabel?: string
  onConfirmAll: (strategy: PasteConflictBatchStrategy) => void
  onConfirmPerItem: (resolutions: PerItemResolutions) => void
  onOpenChange: (open: boolean) => void
}

/**
 * 文件树粘贴冲突对话框（增强版）。
 * @param props 冲突列表、来源名称、批量/逐项确认回调和打开状态控制。
 * @returns 批量全部覆盖/全部复制/逐项选择或取消的对话框。
 * @remarks 内部管理摘要/逐项两种视图，只收集选择不调用后端。
 */
export function FileTreePasteConflictDialog({
  open,
  conflicts,
  title = "Paste conflict",
  summaryDescription,
  overwriteAllLabel = "Overwrite all",
  duplicateAllLabel = "Paste all as copies",
  choosePerItemLabel = "Choose per item",
  cancelLabel = "Cancel",
  sourcePathLabel = "Source",
  targetPathLabel = "Target",
  overwriteLabel = "Overwrite",
  duplicateLabel = "Paste as copy",
  backLabel = "Back",
  applyLabel = "Apply",
  onConfirmAll,
  onConfirmPerItem,
  onOpenChange,
}: FileTreePasteConflictDialogProps) {
  const [mode, setMode] = useState<"summary" | "perItem">("summary")
  const [perItemStrategies, setPerItemStrategies] = useState<
    Record<string, PasteConflictBatchStrategy>
  >({})

  /**
   * 弹窗打开时重置内部状态，避免上次残留的视图和策略影响新操作。
   * setState 直接用于 effect 内是故意为之——需要根据外部 open 属性同步重置内部状态，
   * 没有更合适的触发时机。
   */
  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect -- 外部关闭后重开需重置内部状态 */
      setMode("summary")
      setPerItemStrategies({})
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open])

  /** 弹窗关闭时重置内部状态，避免下次打开残留旧视图。 */
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setMode("summary")
      setPerItemStrategies({})
    }
    onOpenChange(nextOpen)
  }

  /** 进入逐项选择视图并初始化默认策略为覆盖。 */
  const handleChoosePerItem = () => {
    const defaults: Record<string, PasteConflictBatchStrategy> = {}
    for (const c of conflicts) {
      defaults[c.path] = "overwrite"
    }
    setPerItemStrategies(defaults)
    setMode("perItem")
  }

  /** 切换单条冲突的逐项策略。 */
  const handleTogglePerItem = (
    path: string,
    strategy: PasteConflictBatchStrategy
  ) => {
    setPerItemStrategies((prev) => ({ ...prev, [path]: strategy }))
  }

  /** 收集逐项选择并通过回调外传。 */
  const handleApplyPerItem = () => {
    const resolutions: PerItemResolutions = Object.entries(
      perItemStrategies
    ).map(([path, strategy]) => ({ path, strategy }))
    onConfirmPerItem(resolutions)
  }

  if (mode === "perItem") {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {summaryDescription ??
                `Choose how to handle each conflicting item.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {conflicts.map((c) => (
              <div
                key={c.path}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="min-w-0 mr-4">
                  <span className="text-sm font-medium truncate block">
                    {c.path}
                  </span>
                  <span className="text-xs text-muted-foreground truncate block">
                    {sourcePathLabel}: {c.sourcePath}
                  </span>
                  <span className="text-xs text-muted-foreground truncate block">
                    {targetPathLabel}: {c.targetPath}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      perItemStrategies[c.path] === "overwrite"
                        ? "destructive"
                        : "secondary"
                    }
                    onClick={() => handleTogglePerItem(c.path, "overwrite")}
                  >
                    {overwriteLabel}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      perItemStrategies[c.path] === "duplicate"
                        ? "default"
                        : "secondary"
                    }
                    onClick={() => handleTogglePerItem(c.path, "duplicate")}
                  >
                    {duplicateLabel}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setMode("summary")}
            >
              {backLabel}
            </Button>
            <Button type="button" onClick={handleApplyPerItem}>
              {applyLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {summaryDescription ??
              `${conflicts.length} conflicting item${conflicts.length !== 1 ? "s" : ""} found.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {conflicts.map((c) => (
            <div key={c.path} className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium truncate">{c.path}</div>
              <div className="mt-1 grid gap-1 text-muted-foreground">
                <div className="truncate">
                  {sourcePathLabel}: {c.sourcePath}
                </div>
                <div className="truncate">
                  {targetPathLabel}: {c.targetPath}
                </div>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onConfirmAll("overwrite")}
          >
            {overwriteAllLabel}
          </Button>
          <Button type="button" onClick={() => onConfirmAll("duplicate")}>
            {duplicateAllLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleChoosePerItem}
          >
            {choosePerItemLabel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
