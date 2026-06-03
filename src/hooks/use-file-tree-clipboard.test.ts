import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  resolveFileTreePasteTarget,
  useFileTreeClipboard,
} from "./use-file-tree-clipboard"

describe("useFileTreeClipboard", () => {
  it("stores copy source and clears on demand", () => {
    const { result } = renderHook(() => useFileTreeClipboard())

    act(() => {
      result.current.copy({
        kind: "file",
        name: "app.ts",
        path: "src/app.ts",
      })
    })

    expect(result.current.clipboard?.mode).toBe("copy")
    expect(result.current.clipboard?.sourcePath).toBe("src/app.ts")

    act(() => {
      result.current.clear()
    })

    expect(result.current.clipboard).toBeNull()
  })

  it("stores cut source", () => {
    const { result } = renderHook(() => useFileTreeClipboard())

    act(() => {
      result.current.cut({
        kind: "dir",
        name: "components",
        path: "src/components",
      })
    })

    expect(result.current.clipboard).toEqual({
      mode: "cut",
      sourceKind: "dir",
      sourceName: "components",
      sourcePath: "src/components",
    })
  })
})

describe("resolveFileTreePasteTarget", () => {
  it("uses directories as paste targets", () => {
    expect(
      resolveFileTreePasteTarget({
        kind: "dir",
        name: "components",
        path: "src/components",
      })
    ).toBe("src/components")
  })

  it("uses a file parent directory as paste target", () => {
    expect(
      resolveFileTreePasteTarget({
        kind: "file",
        name: "app.ts",
        path: "src/app.ts",
      })
    ).toBe("src")
  })
})
