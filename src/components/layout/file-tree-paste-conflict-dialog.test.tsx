import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  FileTreePasteConflictDialog,
  type PasteConflictItem,
} from "./file-tree-paste-conflict-dialog"

const sampleConflicts: PasteConflictItem[] = [
  {
    path: "app.ts",
    name: "app.ts",
    sourcePath: "lib/app.ts",
    targetPath: "src/app.ts",
    kind: "file",
  },
  {
    path: "lib/util.ts",
    name: "util.ts",
    sourcePath: "lib/util.ts",
    targetPath: "src/lib/util.ts",
    kind: "file",
  },
]

describe("FileTreePasteConflictDialog", () => {
  it("shows the conflict count in summary view", () => {
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getByText(/2 conflicting items found/i)).toBeInTheDocument()
  })

  it("shows source and target paths before destructive choices", () => {
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    const sourceRows = screen.getAllByText(/Source:/)
    const targetRows = screen.getAllByText(/Target:/)
    expect(sourceRows[0]).toHaveTextContent("lib/app.ts")
    expect(targetRows[0]).toHaveTextContent("src/app.ts")
    expect(sourceRows[1]).toHaveTextContent("lib/util.ts")
    expect(targetRows[1]).toHaveTextContent("src/lib/util.ts")
  })

  it("uses custom source and target labels in summary and per-item views", () => {
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        sourcePathLabel="来源"
        targetPathLabel="目标"
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    expect(screen.getAllByText(/来源:/)[0]).toHaveTextContent("lib/app.ts")
    expect(screen.getAllByText(/目标:/)[0]).toHaveTextContent("src/app.ts")

    fireEvent.click(screen.getByRole("button", { name: "Choose per item" }))

    expect(screen.getAllByText(/来源:/)[0]).toHaveTextContent("lib/app.ts")
    expect(screen.getAllByText(/目标:/)[0]).toHaveTextContent("src/app.ts")
  })

  it("returns overwrite when the overwrite-all button is clicked", () => {
    const onConfirmAll = vi.fn()
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={onConfirmAll}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Overwrite all" }))

    expect(onConfirmAll).toHaveBeenCalledWith("overwrite")
  })

  it("returns duplicate when the duplicate-all button is clicked", () => {
    const onConfirmAll = vi.fn()
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={onConfirmAll}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Paste all as copies" }))

    expect(onConfirmAll).toHaveBeenCalledWith("duplicate")
  })

  it("switches to per-item view when choose-per-item is clicked", () => {
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose per item" }))

    // 逐项视图应该渲染每个冲突条目的路径
    expect(screen.getByText("app.ts")).toBeInTheDocument()
    expect(screen.getByText("lib/util.ts")).toBeInTheDocument()
  })

  it("returns per-item resolutions when apply is clicked in per-item view", () => {
    const onConfirmPerItem = vi.fn()
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={onConfirmPerItem}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose per item" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(onConfirmPerItem).toHaveBeenCalledWith([
      { path: "app.ts", strategy: "overwrite" },
      { path: "lib/util.ts", strategy: "overwrite" },
    ])
  })

  it("closes when cancel is clicked in summary view", () => {
    const onOpenChange = vi.fn()
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("returns to summary view when back is clicked in per-item view", () => {
    render(
      <FileTreePasteConflictDialog
        open
        conflicts={sampleConflicts}
        onConfirmAll={vi.fn()}
        onConfirmPerItem={vi.fn()}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose per item" }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))

    // 回到 summary 视图后应该再次看到冲突数量
    expect(screen.getByText(/2 conflicting items found/i)).toBeInTheDocument()
  })
})
