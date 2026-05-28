import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { RenderNode } from "./aux-panel-file-tree-tab"
import { copyTextToClipboard } from "@/lib/utils"

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string) => {
    if (namespace === "Folder.fileTreeTab" && key === "copyFilePath") {
      return "Copy path"
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
    return key
  },
}))

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils")
  return {
    ...actual,
    copyTextToClipboard: vi.fn(async () => true),
  }
})

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
})
