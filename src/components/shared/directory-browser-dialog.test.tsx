import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DirectoryBrowserDialog } from "./directory-browser-dialog"
import {
  createFolderDirectory,
  deleteFileTreeEntry,
  getHomeDirectory,
  listDirectoryEntries,
} from "@/lib/api"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/lib/api", () => ({
  createFolderDirectory: vi.fn(),
  deleteFileTreeEntry: vi.fn(),
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode
    onSelect?: () => void
  }) => (
    <button onClick={onSelect} type="button">
      {children}
    </button>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

const mockedGetHomeDirectory = vi.mocked(getHomeDirectory)
const mockedListDirectoryEntries = vi.mocked(listDirectoryEntries)
const mockedCreateFolderDirectory = vi.mocked(createFolderDirectory)
const mockedDeleteFileTreeEntry = vi.mocked(deleteFileTreeEntry)

describe("DirectoryBrowserDialog", () => {
  beforeEach(() => {
    mockedGetHomeDirectory.mockReset()
    mockedGetHomeDirectory.mockResolvedValue("/home/me")
    mockedListDirectoryEntries.mockReset()
    mockedListDirectoryEntries.mockImplementation(async (path) => {
      if (path === "/home/me")
        return [
          { name: "project", path: "/home/me/project", hasChildren: false },
          { name: "docs", path: "/home/me/docs", hasChildren: false },
        ]
      if (path === "/home/me/project") return []
      return []
    })
    mockedCreateFolderDirectory.mockReset()
    mockedCreateFolderDirectory.mockResolvedValue(undefined)
    mockedDeleteFileTreeEntry.mockReset()
    mockedDeleteFileTreeEntry.mockResolvedValue(undefined)
  })

  it("creates a child directory from a directory context menu", async () => {
    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath="/home/me"
      />
    )

    await screen.findByText("project")
    const newChildButtons = screen.getAllByRole("button", {
      name: "newChildFolder",
    })
    fireEvent.click(newChildButtons[0])
    fireEvent.change(screen.getByPlaceholderText("newFolderNamePlaceholder"), {
      target: { value: "src" },
    })
    fireEvent.click(screen.getByRole("button", { name: "create" }))

    await waitFor(() => {
      expect(mockedCreateFolderDirectory).toHaveBeenCalledWith(
        "/home/me/project/src"
      )
    })
    expect(mockedListDirectoryEntries).toHaveBeenCalledWith("/home/me/project")
  })

  it("ignores repeated create submissions while creation is pending", async () => {
    mockedCreateFolderDirectory.mockImplementation(
      () => new Promise(() => undefined)
    )

    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath="/home/me"
      />
    )

    await screen.findByText("project")
    const newChildButtons = screen.getAllByRole("button", {
      name: "newChildFolder",
    })
    fireEvent.click(newChildButtons[0])
    const nameInput = screen.getByPlaceholderText("newFolderNamePlaceholder")
    fireEvent.change(nameInput, { target: { value: "src" } })
    fireEvent.click(screen.getByRole("button", { name: "create" }))
    fireEvent.keyDown(nameInput, { key: "Enter" })

    await waitFor(() => {
      expect(mockedCreateFolderDirectory).toHaveBeenCalledTimes(1)
    })
    expect(nameInput).toBeDisabled()
    expect(screen.getByRole("button", { name: "loading" })).toBeDisabled()
  })

  it("opens a confirmation dialog before deleting a directory", async () => {
    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath="/home/me"
      />
    )

    await screen.findByText("project")
    const deleteButtons = screen.getAllByRole("button", {
      name: "deleteDirectory",
    })
    fireEvent.click(deleteButtons[0])

    expect(screen.getByText("deleteConfirmTitle")).toBeDefined()
    expect(screen.getByText("deleteConfirmDescription")).toBeDefined()
    expect(mockedDeleteFileTreeEntry).not.toHaveBeenCalled()
  })

  it("focuses cancel by default and does not delete when deletion is cancelled", async () => {
    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath="/home/me"
      />
    )

    await screen.findByText("project")
    const deleteButtons = screen.getAllByRole("button", {
      name: "deleteDirectory",
    })
    fireEvent.click(deleteButtons[0])

    const cancelButton = await screen.findByRole("button", {
      name: "cancelDelete",
    })
    await waitFor(() => expect(cancelButton).toHaveFocus())

    fireEvent.click(cancelButton)

    expect(mockedDeleteFileTreeEntry).not.toHaveBeenCalled()
  })

  it("deletes a directory through the file tree API and refreshes its parent", async () => {
    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath="/home/me"
      />
    )

    await screen.findByText("project")
    const deleteButtons = screen.getAllByRole("button", {
      name: "deleteDirectory",
    })
    fireEvent.click(deleteButtons[0])

    const confirmButton = screen.getByRole("button", { name: "confirmDelete" })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(mockedDeleteFileTreeEntry).toHaveBeenCalledWith(
        "/home/me",
        "project"
      )
    })
    expect(mockedListDirectoryEntries).toHaveBeenCalledWith("/home/me")
  })

  it("clears deleted Windows descendant selection after deleting a directory", async () => {
    const root = "C:\\repo"
    const src = "C:\\repo\\src"
    const child = "C:\\repo\\src\\child"

    mockedListDirectoryEntries.mockImplementation(async (path) => {
      if (path === root) {
        return [{ name: "src", path: src, hasChildren: true }]
      }
      if (path === src) {
        return [{ name: "child", path: child, hasChildren: false }]
      }
      return []
    })

    render(
      <DirectoryBrowserDialog
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        initialPath={root}
      />
    )

    await screen.findByText("src")
    const srcRow = screen.getByRole("button", { name: "src" })
    fireEvent.click(srcRow)
    fireEvent.click(srcRow.querySelector('[role="button"]') as Element)
    await screen.findByText("child")
    fireEvent.click(screen.getByRole("button", { name: "child" }))
    expect(screen.getByText(child)).toBeInTheDocument()

    fireEvent.click(
      screen.getAllByRole("button", { name: "deleteDirectory" })[0]
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "confirmDelete" })
    )

    await waitFor(() => {
      expect(mockedDeleteFileTreeEntry).toHaveBeenCalledWith(root, "src")
    })
    expect(screen.queryByText(child)).not.toBeInTheDocument()
  })
})
