import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
  WorkspaceProvider,
  useWorkspaceContext,
} from "@/contexts/workspace-context"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 1, path: "/repo", name: "repo" },
    activeFolderId: 1,
  }),
}))

function WorkspaceProbe() {
  const {
    mode,
    activePane,
    fileTabs,
    activeFileTabId,
    filesMaximized,
    openSessionFileDiff,
    closeFileTab,
    closeAllFileTabs,
    toggleFilesMaximized,
  } = useWorkspaceContext()

  return (
    <div>
      <output data-testid="mode">{mode}</output>
      <output data-testid="file-tab-count">{fileTabs.length}</output>
      <output data-testid="active-pane">{activePane}</output>
      <output data-testid="files-maximized">{String(filesMaximized)}</output>
      <output data-testid="active-file-tab">{activeFileTabId ?? "none"}</output>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/app.ts", "diff --git", "Turn 1")
        }
      >
        Open diff
      </button>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/other.ts", "diff --git", "Turn 1")
        }
      >
        Open diff 2
      </button>
      <button
        type="button"
        onClick={() => activeFileTabId && closeFileTab(activeFileTabId)}
      >
        Close active
      </button>
      <button type="button" onClick={closeAllFileTabs}>
        Close all
      </button>
      <button type="button" onClick={toggleFilesMaximized}>
        Toggle maximize
      </button>
    </div>
  )
}

function renderWorkspace() {
  return render(
    <WorkspaceProvider>
      <WorkspaceProbe />
    </WorkspaceProvider>
  )
}

describe("WorkspaceProvider mode", () => {
  it("derives conversation mode from an empty file workspace", () => {
    localStorage.setItem("workspace:mode", JSON.stringify({ mode: "files" }))

    renderWorkspace()

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("derives fusion mode while file tabs are open and returns to conversation when they close", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })
})

describe("WorkspaceProvider files-maximized", () => {
  it("toggles filesMaximized only while files are open", () => {
    renderWorkspace()

    // No files yet — toggling should not enable maximize (derived value gated
    // on fusion mode).
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Open a file, then toggle: maximize flips on, then off.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("does not mutate active pane on maximize toggle, preserving revert semantics", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    // Opening a file routes activePane to "files".
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    // Maximize must not silently rewrite the user's last-active pane.
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when all file tabs close, and does not leak into newly reopened files", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Reopening a file must start from the normal split, not a stale maximized
    // layout.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when the last tab is closed individually", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close active" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("does not touch file tab data when toggling maximize", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
      screen.getByRole("button", { name: "Open diff 2" }).click()
    })
    const tabCountBefore =
      screen.getByTestId("file-tab-count").textContent ?? ""
    const activeBefore = screen.getByTestId("active-file-tab").textContent ?? ""

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )
  })
})
