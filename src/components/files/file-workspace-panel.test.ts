import { describe, expect, it, vi } from "vitest"
import { runEditorFindAction } from "@/components/files/file-workspace-panel"

describe("runEditorFindAction", () => {
  it("focuses the editor and runs the find action for a non-empty query", async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const editor = {
      focus: vi.fn(),
      getAction: vi.fn(() => ({ run })),
    }

    await runEditorFindAction(editor, "needle")

    expect(editor.focus).toHaveBeenCalledTimes(1)
    expect(editor.getAction).toHaveBeenCalledWith("actions.find")
    expect(run).toHaveBeenCalledTimes(1)
  })
})
