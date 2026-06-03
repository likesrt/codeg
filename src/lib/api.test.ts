import { describe, expect, it, vi } from "vitest"
import { pasteFileTreeEntry, previewPasteFileTreeEntry } from "./api"

const callMock = vi.fn()

vi.mock("./transport", () => ({
  getTransport: () => ({
    call: callMock,
  }),
  getShellTransport: () => ({
    call: vi.fn(),
  }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

vi.mock("./transport/web-auth", () => ({
  getCodegToken: () => "token",
  redirectToCodegLogin: vi.fn(),
}))

vi.mock("./i18n", () => ({
  getCurrentEffectiveAppLocale: () => "en",
}))

describe("pasteFileTreeEntry", () => {
  it("calls the transport with camelCase payload", async () => {
    callMock.mockResolvedValue("notes/app.ts")

    await pasteFileTreeEntry({
      rootPath: "/workspace",
      sourcePath: "src/app.ts",
      targetDirPath: "notes",
      mode: "copy",
      conflict: "overwrite",
    })

    expect(callMock).toHaveBeenCalledWith("paste_file_tree_entry", {
      rootPath: "/workspace",
      sourcePath: "src/app.ts",
      targetDirPath: "notes",
      mode: "copy",
      conflict: "overwrite",
    })
  })
})

describe("previewPasteFileTreeEntry", () => {
  it("calls the transport with camelCase payload", async () => {
    callMock.mockResolvedValue([
      {
        path: "src/app.ts",
        sourcePath: "src/app.ts",
        targetPath: "notes/app.ts",
        kind: "file",
      },
    ])

    await previewPasteFileTreeEntry({
      rootPath: "/workspace",
      sourcePath: "src/app.ts",
      targetDirPath: "notes",
    })

    expect(callMock).toHaveBeenCalledWith("preview_paste_file_tree_entry", {
      rootPath: "/workspace",
      sourcePath: "src/app.ts",
      targetDirPath: "notes",
    })
  })
})
