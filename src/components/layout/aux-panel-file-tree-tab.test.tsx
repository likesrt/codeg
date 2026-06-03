import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileTreeTab, RenderNode } from "./aux-panel-file-tree-tab"
import { pasteFileTreeEntry, previewPasteFileTreeEntry } from "@/lib/api"
import { copyTextToClipboard } from "@/lib/utils"

const mockContext = vi.hoisted(() => {
  const store = {
    tree: [] as import("@/lib/types").FileTreeNode[],
    git: [] as import("@/lib/types").GitStatusEntry[],
    health: "ready",
    seq: 1,
    error: null,
    requestResync: vi.fn(async () => {}),
  }
  return { store }
})

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace?: string) => (key: string, params?: Record<string, string>) => {
      if (namespace === "Folder.fileTreeTab" && key === "copyFilePath") {
        return "Copy path"
      }
      if (namespace === "Folder.fileTreeTab" && key === "copyPaste") {
        return "Copy / Paste"
      }
      if (namespace === "Folder.fileTreeTab" && key === "copyEntry") {
        return "Copy"
      }
      if (namespace === "Folder.fileTreeTab" && key === "cutEntry") {
        return "Cut"
      }
      if (namespace === "Folder.fileTreeTab" && key === "pasteEntry") {
        return "Paste"
      }
      if (namespace === "Folder.fileTreeTab" && key === "copyRelativePath") {
        return "Copy relative path"
      }
      if (namespace === "Folder.fileTreeTab" && key === "copyAbsolutePath") {
        return "Copy absolute path"
      }
      if (namespace === "Folder.fileTreeTab" && key === "toasts.pathCopied") {
        return "Path copied"
      }
      if (namespace === "Folder.fileTreeTab" && key === "pasteConflict.title") {
        return "Paste conflict"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.summary"
      ) {
        return `Pasting "${params?.name}" will conflict with ${params?.count} existing item(s).`
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.overwriteAll"
      ) {
        return "Overwrite all"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.duplicateAll"
      ) {
        return "Paste all as copies"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.choosePerItem"
      ) {
        return "Choose per item"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.cancel"
      ) {
        return "Cancel"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.overwrite"
      ) {
        return "Overwrite"
      }
      if (
        namespace === "Folder.fileTreeTab" &&
        key === "pasteConflict.duplicate"
      ) {
        return "Paste as copy"
      }
      if (namespace === "Folder.fileTreeTab" && key === "pasteConflict.back") {
        return "Back"
      }
      if (namespace === "Folder.fileTreeTab" && key === "pasteConflict.apply") {
        return "Apply"
      }
      return key
    },
}))

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { path: "/home/me/project" },
  }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    pendingRevealPath: null,
    consumePendingRevealPath: vi.fn(),
  }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabContext: () => ({ tabs: [], activeTabId: null }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ createTerminalInDirectory: vi.fn() }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceContext: () => ({
    activeFileTab: null,
    activeFilePath: null,
    fileTabs: [],
    openBranchDiff: vi.fn(),
    openExternalConflictDiff: vi.fn(),
    openFilePreview: vi.fn(),
    openWorkingTreeDiff: vi.fn(),
    reloadOpenFileBackground: vi.fn(),
    applyExternalReload: vi.fn(),
    markTabsStale: vi.fn(),
    rejectFileTab: vi.fn(),
  }),
  isImageFile: () => false,
}))

vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => mockContext.store,
}))

vi.mock("@/components/layout/workspace-degraded-banner", () => ({
  WorkspaceDegradedBanner: () => null,
}))

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils")
  return {
    ...actual,
    copyTextToClipboard: vi.fn(async () => true),
  }
})

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    pasteFileTreeEntry: vi.fn(async () => "src/app-副本.ts"),
    previewPasteFileTreeEntry: vi.fn(async () => []),
  }
})

vi.mock("@/lib/app-error", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/app-error")>("@/lib/app-error")
  return {
    ...actual,
    extractAppCommandError: vi.fn((error) =>
      typeof error === "string"
        ? { code: "already_exists", message: error }
        : null
    ),
  }
})

vi.mock("@/components/layout/file-tree-paste-conflict-dialog", () => ({
  FileTreePasteConflictDialog: ({
    conflicts,
    open,
    onConfirmAll,
    onConfirmPerItem,
  }: {
    conflicts?: { path: string; sourcePath: string; targetPath: string }[]
    open: boolean
    onConfirmAll?: (strategy: string) => void
    onConfirmPerItem?: (
      resolutions: { path: string; strategy: string }[]
    ) => void
  }) =>
    open ? (
      <div>
        <span>{conflicts?.length ?? 0} conflicts</span>
        {conflicts?.map((conflict) => (
          <div key={conflict.path}>
            <span>Source: {conflict.sourcePath}</span>
            <span>Target: {conflict.targetPath}</span>
          </div>
        ))}
        <button onClick={() => onConfirmAll?.("overwrite")} type="button">
          Overwrite all
        </button>
        <button onClick={() => onConfirmAll?.("duplicate")} type="button">
          Paste all as copies
        </button>
        <button
          onClick={() =>
            onConfirmPerItem?.([{ path: "app.ts", strategy: "overwrite" }])
          }
          type="button"
        >
          Apply per item
        </button>
      </div>
    ) : null,
}))

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button disabled={disabled} onClick={onSelect} type="button">
      {children}
    </button>
  ),
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({
    children,
    disabled,
  }: {
    children: React.ReactNode
    disabled?: boolean
  }) => <button disabled={disabled}>{children}</button>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

describe("RenderNode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("copies the workspace-relative path from the file node menu", async () => {
    render(
      <RenderNode
        activeSessionTabId={null}
        ancestorGitignoreIgnored={false}
        ancestorUntracked={false}
        expandedPaths={new Set()}
        folderUploadSupported={false}
        gitChangedDirPaths={new Set()}
        gitEnabled={false}
        gitStatusByPath={new Map()}
        gitignoreIgnoredPaths={new Set()}
        node={{ kind: "file", name: "app.ts", path: "src/app.ts" }}
        onOpenCommitWindow={vi.fn()}
        onOpenDirDiff={vi.fn()}
        onOpenDirInTerminal={vi.fn()}
        onOpenFileDiff={vi.fn()}
        onOpenFilePreview={vi.fn()}
        onRefresh={vi.fn()}
        onRequestAddToVcs={vi.fn()}
        onRequestCompareWithBranch={vi.fn()}
        onRequestCreate={vi.fn()}
        onRequestDelete={vi.fn()}
        onRequestDownloadDir={vi.fn()}
        onRequestDownloadFile={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestRollback={vi.fn()}
        onRequestUpload={vi.fn()}
        untrackedDirPaths={new Set()}
        webMode={false}
        workspacePath="/home/me/project"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy relative path" }))

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith("src/app.ts")
    })
  })

  it("copies the absolute path from the file node menu", async () => {
    render(
      <RenderNode
        activeSessionTabId={null}
        ancestorGitignoreIgnored={false}
        ancestorUntracked={false}
        expandedPaths={new Set()}
        folderUploadSupported={false}
        gitChangedDirPaths={new Set()}
        gitEnabled={false}
        gitStatusByPath={new Map()}
        gitignoreIgnoredPaths={new Set()}
        node={{ kind: "file", name: "app.ts", path: "src/app.ts" }}
        onOpenCommitWindow={vi.fn()}
        onOpenDirDiff={vi.fn()}
        onOpenDirInTerminal={vi.fn()}
        onOpenFileDiff={vi.fn()}
        onOpenFilePreview={vi.fn()}
        onRefresh={vi.fn()}
        onRequestAddToVcs={vi.fn()}
        onRequestCompareWithBranch={vi.fn()}
        onRequestCreate={vi.fn()}
        onRequestDelete={vi.fn()}
        onRequestDownloadDir={vi.fn()}
        onRequestDownloadFile={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestRollback={vi.fn()}
        onRequestUpload={vi.fn()}
        untrackedDirPaths={new Set()}
        webMode={false}
        workspacePath="/home/me/project"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy absolute path" }))

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith(
        "/home/me/project/src/app.ts"
      )
    })
  })

  it("copies the workspace-relative path from the directory node menu", async () => {
    render(
      <RenderNode
        activeSessionTabId={null}
        ancestorGitignoreIgnored={false}
        ancestorUntracked={false}
        expandedPaths={new Set()}
        folderUploadSupported={false}
        gitChangedDirPaths={new Set()}
        gitEnabled={false}
        gitStatusByPath={new Map()}
        gitignoreIgnoredPaths={new Set()}
        node={{
          children: [],
          kind: "dir",
          name: "components",
          path: "src/components",
        }}
        onOpenCommitWindow={vi.fn()}
        onOpenDirDiff={vi.fn()}
        onOpenDirInTerminal={vi.fn()}
        onOpenFileDiff={vi.fn()}
        onOpenFilePreview={vi.fn()}
        onRefresh={vi.fn()}
        onRequestAddToVcs={vi.fn()}
        onRequestCompareWithBranch={vi.fn()}
        onRequestCreate={vi.fn()}
        onRequestDelete={vi.fn()}
        onRequestDownloadDir={vi.fn()}
        onRequestDownloadFile={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestRollback={vi.fn()}
        onRequestUpload={vi.fn()}
        untrackedDirPaths={new Set()}
        webMode={false}
        workspacePath="/home/me/project"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy relative path" }))

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith("src/components")
    })
  })

  it("copies the absolute path from the directory node menu", async () => {
    render(
      <RenderNode
        activeSessionTabId={null}
        ancestorGitignoreIgnored={false}
        ancestorUntracked={false}
        expandedPaths={new Set()}
        folderUploadSupported={false}
        gitChangedDirPaths={new Set()}
        gitEnabled={false}
        gitStatusByPath={new Map()}
        gitignoreIgnoredPaths={new Set()}
        node={{
          children: [],
          kind: "dir",
          name: "components",
          path: "src/components",
        }}
        onOpenCommitWindow={vi.fn()}
        onOpenDirDiff={vi.fn()}
        onOpenDirInTerminal={vi.fn()}
        onOpenFileDiff={vi.fn()}
        onOpenFilePreview={vi.fn()}
        onRefresh={vi.fn()}
        onRequestAddToVcs={vi.fn()}
        onRequestCompareWithBranch={vi.fn()}
        onRequestCreate={vi.fn()}
        onRequestDelete={vi.fn()}
        onRequestDownloadDir={vi.fn()}
        onRequestDownloadFile={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestRollback={vi.fn()}
        onRequestUpload={vi.fn()}
        untrackedDirPaths={new Set()}
        webMode={false}
        workspacePath="/home/me/project"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy absolute path" }))

    await waitFor(() => {
      expect(copyTextToClipboard).toHaveBeenCalledWith(
        "/home/me/project/src/components"
      )
    })
  })

  it("pastes without conflict dialog when precheck returns no conflicts", async () => {
    const onRefresh = vi.fn()
    vi.mocked(previewPasteFileTreeEntry).mockResolvedValue([])

    render(
      <RenderNode
        activeSessionTabId={null}
        ancestorGitignoreIgnored={false}
        ancestorUntracked={false}
        canPasteEntry
        expandedPaths={new Set()}
        folderUploadSupported={false}
        gitChangedDirPaths={new Set()}
        gitEnabled={false}
        gitStatusByPath={new Map()}
        gitignoreIgnoredPaths={new Set()}
        node={{ kind: "file", name: "app.ts", path: "src/app.ts" }}
        onOpenCommitWindow={vi.fn()}
        onOpenDirDiff={vi.fn()}
        onOpenDirInTerminal={vi.fn()}
        onOpenFileDiff={vi.fn()}
        onOpenFilePreview={vi.fn()}
        onRefresh={onRefresh}
        onRequestAddToVcs={vi.fn()}
        onRequestCompareWithBranch={vi.fn()}
        onRequestCopyEntry={vi.fn()}
        onRequestCreate={vi.fn()}
        onRequestDelete={vi.fn()}
        onRequestDownloadDir={vi.fn()}
        onRequestDownloadFile={vi.fn()}
        onRequestPasteEntry={() => {
          void (async () => {
            const conflicts = await previewPasteFileTreeEntry({
              rootPath: "/home/me/project",
              sourcePath: "lib/app.ts",
              targetDirPath: "src",
            })
            if (conflicts.length === 0) {
              void pasteFileTreeEntry({
                rootPath: "/home/me/project",
                sourcePath: "lib/app.ts",
                targetDirPath: "src",
                mode: "copy",
                conflict: "abort",
              }).then(onRefresh)
            }
          })()
        }}
        onRequestRename={vi.fn()}
        onRequestRollback={vi.fn()}
        onRequestUpload={vi.fn()}
        untrackedDirPaths={new Set()}
        webMode={false}
        workspacePath="/home/me/project"
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Paste" }))

    await waitFor(() => {
      expect(previewPasteFileTreeEntry).toHaveBeenCalled()
      expect(pasteFileTreeEntry).toHaveBeenCalled()
      expect(onRefresh).toHaveBeenCalled()
    })
  })

  it("runs the real preview dialog paste flow and keeps target paths visible", async () => {
    mockContext.store.tree = [
      { kind: "file", name: "app.ts", path: "src/app.ts" },
    ]
    mockContext.store.requestResync.mockResolvedValue(undefined)
    vi.mocked(previewPasteFileTreeEntry).mockResolvedValue([
      {
        path: "app.ts",
        sourcePath: "src/app.ts",
        targetPath: "src/app.ts",
        kind: "file",
      },
    ])

    render(<FileTreeTab />)

    const copyButtons = screen.getAllByRole("button", { name: "Copy" })
    fireEvent.click(copyButtons[copyButtons.length - 1])
    const pasteButtons = screen.getAllByRole("button", { name: "Paste" })
    fireEvent.click(pasteButtons[pasteButtons.length - 1])

    await waitFor(() => {
      expect(screen.getByText(/Target:/)).toHaveTextContent("src/app.ts")
    })

    fireEvent.click(screen.getByRole("button", { name: "Overwrite all" }))

    await waitFor(() => {
      expect(previewPasteFileTreeEntry).toHaveBeenCalledWith({
        rootPath: "/home/me/project",
        sourcePath: "src/app.ts",
        targetDirPath: "",
      })
      expect(pasteFileTreeEntry).toHaveBeenCalledWith({
        rootPath: "/home/me/project",
        sourcePath: "src/app.ts",
        targetDirPath: "",
        mode: "copy",
        conflict: "overwrite",
        resolutions: undefined,
      })
      expect(mockContext.store.requestResync).toHaveBeenCalled()
    })
  })
})
