import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DirectoryBrowserDialog } from "./directory-browser-dialog"
import {
  createFolderDirectory,
  getHomeDirectory,
  listDirectoryEntries,
} from "@/lib/api"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/lib/api", () => ({
  createFolderDirectory: vi.fn(),
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

describe("DirectoryBrowserDialog", () => {
  beforeEach(() => {
    mockedGetHomeDirectory.mockReset()
    mockedGetHomeDirectory.mockResolvedValue("/home/me")
    mockedListDirectoryEntries.mockReset()
    mockedListDirectoryEntries.mockImplementation(async (path) => {
      if (path === "/home/me/project") return []
      return [{ name: "project", path: "/home/me/project", hasChildren: false }]
    })
    mockedCreateFolderDirectory.mockReset()
    mockedCreateFolderDirectory.mockResolvedValue(undefined)
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
    fireEvent.click(screen.getByRole("button", { name: "newChildFolder" }))
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
})
