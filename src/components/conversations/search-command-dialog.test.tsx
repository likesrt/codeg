import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import { searchFiles } from "@/lib/api"

const mockOpenTab = vi.fn()
const mockOpenFilePreview = vi.fn()
const mockRevealInFileTree = vi.fn()

class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

globalThis.ResizeObserver = MockResizeObserver

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({
    results: [],
    truncated: false,
    scannedFiles: 0,
    skippedFiles: 0,
  })),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 1, name: "Repo", path: "/repo" },
    activeFolderId: 1,
  }),
}))

vi.mock("@/contexts/app-workspace-context", () => ({
  useAppWorkspace: () => ({ conversations: [] }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabContext: () => ({ openTab: mockOpenTab }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceContext: () => ({ openFilePreview: mockOpenFilePreview }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: mockRevealInFileTree }),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({ allFiles: [], loading: false, reset: vi.fn() }),
}))

/**
 * Renders the search dialog with English messages and a configurable open state.
 * @param open Dialog visibility to pass into SearchCommandDialog.
 * @returns Testing Library render result for the mounted dialog.
 * @remarks The helper keeps provider setup identical across content-tab tests.
 */
function renderDialog(open = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog open={open} onOpenChange={vi.fn()} />
    </NextIntlClientProvider>
  )
}

/**
 * Creates a promise plus external settle functions for async ordering tests.
 * @returns Deferred promise controls for resolving or rejecting on demand.
 * @remarks Tests use this to prove stale content searches cannot overwrite newer ones.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("SearchCommandDialog content tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it("shows the content tab with the other search tabs", () => {
    renderDialog()

    expect(screen.getByRole("button", { name: "Conversations" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Files" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Content" })).toBeTruthy()
  })

  it("does not search content automatically while typing", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "needle"
    )

    expect(searchFiles).not.toHaveBeenCalled()
  })

  it("does not repeatedly reset while already closed", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(() => renderDialog(false)).not.toThrow()
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Maximum update depth exceeded")
    )
  })

  it("searches content on button click and shows file name with line text", async () => {
    vi.mocked(searchFiles).mockResolvedValueOnce({
      results: [
        {
          path: "src/app.ts",
          name: "app.ts",
          lineNumber: 7,
          lineText: "const value = 'needle'",
        },
      ],
      truncated: false,
      scannedFiles: 1,
      skippedFiles: 0,
    })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "needle"
    )
    await user.click(screen.getByRole("button", { name: "Search content" }))

    await screen.findByText("const value = 'needle'")
    expect(screen.getByText("app.ts")).toBeTruthy()
    expect(searchFiles).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo", query: "needle" })
    )
  })

  it("searches content when Enter is pressed on the content tab", async () => {
    vi.mocked(searchFiles).mockResolvedValueOnce({
      results: [
        {
          path: "src/app.ts",
          name: "app.ts",
          lineNumber: 2,
          lineText: "needle()",
        },
      ],
      truncated: false,
      scannedFiles: 1,
      skippedFiles: 0,
    })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "needle"
    )
    fireEvent.keyDown(screen.getByPlaceholderText("Search file contents..."), {
      key: "Enter",
    })

    await screen.findByText("needle()")
    expect(searchFiles).toHaveBeenCalledTimes(1)
  })

  it("keeps newer content results when an older search resolves later", async () => {
    const slowFoo = createDeferred<Awaited<ReturnType<typeof searchFiles>>>()
    const fastBar = createDeferred<Awaited<ReturnType<typeof searchFiles>>>()
    vi.mocked(searchFiles)
      .mockReturnValueOnce(slowFoo.promise)
      .mockReturnValueOnce(fastBar.promise)
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "foo"
    )
    await user.click(screen.getByRole("button", { name: "Search content" }))
    await user.clear(screen.getByPlaceholderText("Search file contents..."))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "bar"
    )
    await user.click(screen.getByRole("button", { name: "Search content" }))

    await act(async () => {
      fastBar.resolve({
        results: [
          {
            path: "src/bar.ts",
            name: "bar.ts",
            lineNumber: 2,
            lineText: "bar",
          },
        ],
        truncated: false,
        scannedFiles: 1,
        skippedFiles: 0,
      })
    })
    await screen.findByText("bar")
    await act(async () => {
      slowFoo.resolve({
        results: [
          {
            path: "src/foo.ts",
            name: "foo.ts",
            lineNumber: 1,
            lineText: "foo",
          },
        ],
        truncated: false,
        scannedFiles: 1,
        skippedFiles: 0,
      })
    })

    await waitFor(() => expect(screen.queryByText("foo")).toBeNull())
    expect(screen.getByText("bar")).toBeTruthy()
  })

  it("opens the selected content result with line and current search query", async () => {
    vi.mocked(searchFiles).mockResolvedValueOnce({
      results: [
        {
          path: "src/app.ts",
          name: "app.ts",
          lineNumber: 2,
          lineText: "const value = 'needle'",
        },
      ],
      truncated: false,
      scannedFiles: 1,
      skippedFiles: 0,
    })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.type(
      screen.getByPlaceholderText("Search file contents..."),
      "needle"
    )
    await user.click(screen.getByRole("button", { name: "Search content" }))
    await user.click(await screen.findByText("const value = 'needle'"))

    expect(mockRevealInFileTree).toHaveBeenCalledWith("src")
    expect(mockOpenFilePreview).toHaveBeenCalledWith("src/app.ts", {
      line: 2,
      searchQuery: "needle",
    })
  })

  it("does not search content when query is blank", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Content" }))
    await user.click(screen.getByRole("button", { name: "Search content" }))
    fireEvent.keyDown(screen.getByPlaceholderText("Search file contents..."), {
      key: "Enter",
    })

    await waitFor(() => expect(searchFiles).not.toHaveBeenCalled())
  })
})
