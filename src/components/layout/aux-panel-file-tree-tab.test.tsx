import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { RenderNode } from "./aux-panel-file-tree-tab"
import { copyTextFromMenu } from "@/lib/utils"

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
      // 组件中实际使用的翻译 key，映射到可读标签用于测试查询
      const fileTreeTabKeys: Record<string, string> = {
        copyPaste: "copyPaste",
        copyEntry: "copyEntry",
        cutEntry: "cutEntry",
        pasteEntry: "pasteEntry",
        copyRelativePath: "copyRelativePath",
        copyAbsolutePath: "copyAbsolutePath",
        copyPath: "Copy path",
        new: "new",
        openIn: "openIn",
        openInTerminal: "openInTerminal",
        openInFileManager: "openInFileManager",
        upload: "upload",
        download: "download",
        downloadAsZip: "downloadAsZip",
        reloadFromDisk: "reloadFromDisk",
        "toasts.pathCopied": "Path copied",
        "toasts.copyPathFailed": "Copy path failed",
        openFile: "openFile",
        attachToCurrentSession: "attachToCurrentSession",
        newFile: "newFile",
        newDirectory: "newDirectory",
        git: "git",
        "git.commitCode": "actions.commitCode",
        "git.addToVcs": "actions.addToVcs",
        "git.viewDiff": "viewDiff",
        "git.compareWithBranch": "compareWithBranch",
        "git.rollback": "actions.rollback",
      }
      if (namespace === "Folder.fileTreeTab" && fileTreeTabKeys[key]) {
        return fileTreeTabKeys[key]
      }
      const folderCommonKeys: Record<string, string> = {
        rename: "rename",
        delete: "delete",
      }
      if (namespace === "Folder.common" && folderCommonKeys[key]) {
        return folderCommonKeys[key]
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
    copyTextFromMenu: vi.fn(async () => true),
  }
})

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
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

    fireEvent.click(screen.getByRole("button", { name: "copyPaste" }))
    fireEvent.click(screen.getByRole("button", { name: "copyAbsolutePath" }))

    await waitFor(() => {
      expect(copyTextFromMenu).toHaveBeenCalledWith(
        "/home/me/project/src/app.ts"
      )
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

    fireEvent.click(screen.getByRole("button", { name: "copyPaste" }))
    fireEvent.click(screen.getByRole("button", { name: "copyAbsolutePath" }))

    await waitFor(() => {
      expect(copyTextFromMenu).toHaveBeenCalledWith(
        "/home/me/project/src/components"
      )
    })
  })

  it("renders and responds to delete action", async () => {
    const onRequestDelete = vi.fn()
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
        onRequestDelete={onRequestDelete}
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

    fireEvent.click(screen.getByRole("button", { name: "delete" }))

    expect(onRequestDelete).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/app.ts" })
    )
  })

  it("renders the file node context menu tree item", () => {
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

    expect(screen.getByRole("treeitem")).toBeTruthy()
    expect(screen.getByText("app.ts")).toBeTruthy()
  })
})
