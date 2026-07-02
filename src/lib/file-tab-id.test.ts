import { describe, expect, it } from "vitest"
import {
  buildFileTabId,
  parseFileTabId,
  type FileTabIdParts,
} from "@/lib/file-tab-id"

describe("file-tab-id build↔parse round-trip", () => {
  const cases: FileTabIdParts[] = [
    { kind: "file", folderId: 1, path: "src/app.ts" },
    // Path containing the separator, spaces, and non-ASCII.
    { kind: "file", folderId: 12, path: "weird:dir/文件 名.md" },
    { kind: "diff-working-all", folderId: 3 },
    { kind: "diff-working", folderId: 3, path: "a/b.rs" },
    { kind: "diff-working-unified", folderId: 3, path: "a:colon.rs" },
    { kind: "diff-working-overview", folderId: 3, path: "." },
    { kind: "diff-branch", folderId: 7, branch: "feat/x:y", path: "src/a.ts" },
    { kind: "diff-branch", folderId: 7, branch: "main", path: null },
    {
      kind: "diff-branch-overview",
      folderId: 7,
      branch: "release/1.0",
      path: null,
    },
    { kind: "diff-commit", folderId: 2, commit: "abc1234def", path: null },
    { kind: "diff-commit", folderId: 2, commit: "abc1234def", path: "x/y.go" },
    {
      kind: "diff-session",
      folderId: 9,
      groupLabel: "Turn 3: fix & retry",
      path: "src/main.py",
    },
    { kind: "diff-external-conflict", folderId: 4, path: "notes/读我.txt" },
  ]

  it.each(cases.map((parts) => [parts.kind, parts] as const))(
    "round-trips %s",
    (_kind, parts) => {
      const id = buildFileTabId(parts)
      expect(parseFileTabId(id)).toEqual(parts)
    }
  )

  it("keeps two folders' ids for the same relative path distinct", () => {
    const a = buildFileTabId({ kind: "file", folderId: 1, path: "src/app.ts" })
    const b = buildFileTabId({ kind: "file", folderId: 2, path: "src/app.ts" })
    expect(a).not.toBe(b)
    expect(parseFileTabId(a)).toMatchObject({ folderId: 1 })
    expect(parseFileTabId(b)).toMatchObject({ folderId: 2 })
  })

  it("does not confuse a path named 'all' with the null-path sentinel", () => {
    const withPath = buildFileTabId({
      kind: "diff-commit",
      folderId: 1,
      commit: "abc",
      path: "all",
    })
    const withoutPath = buildFileTabId({
      kind: "diff-commit",
      folderId: 1,
      commit: "abc",
      path: null,
    })
    expect(withPath).not.toBe(withoutPath)
    expect(parseFileTabId(withPath)).toMatchObject({ path: "all" })
    expect(parseFileTabId(withoutPath)).toMatchObject({ path: null })
  })

  it("rejects malformed and legacy (un-namespaced) ids", () => {
    expect(parseFileTabId("file:a.ts")).toBeNull()
    expect(parseFileTabId("file:1x:a.ts")).toBeNull()
    expect(parseFileTabId("file:-1:a.ts")).toBeNull()
    expect(parseFileTabId("file:1")).toBeNull()
    expect(parseFileTabId("diff:working:all")).toBeNull()
    expect(parseFileTabId("diff:unknown:1:x")).toBeNull()
    expect(parseFileTabId("diff:branch:1:main")).toBeNull()
    expect(parseFileTabId("")).toBeNull()
    expect(parseFileTabId("random")).toBeNull()
  })

  it("emits ids whose variable segments never contain a bare separator", () => {
    const id = buildFileTabId({
      kind: "diff-session",
      folderId: 5,
      groupLabel: "a:b:c",
      path: "d:e/f.ts",
    })
    // 2 fixed prefix segments + folderId + 2 encoded tokens = 5 segments.
    expect(id.split(":")).toHaveLength(5)
  })
})
