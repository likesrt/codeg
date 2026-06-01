# 辅助面板文件树复制/剪切/粘贴实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在辅助面板当前工作区文件树中增加文件/文件夹复制、剪切、粘贴，并在同名冲突时提供覆盖或粘贴成副本的选择。

**Architecture:** 前端只负责菜单、局部剪贴板状态和冲突弹窗；后端负责真实文件系统操作、路径边界校验、递归复制/移动和冲突处理。现有“复制相对路径/复制绝对路径”保留，但会和文件操作一起收进同一个一级菜单，减少右键菜单层级。

**Tech Stack:** Next.js 16 + React 19 + TypeScript，Tauri 2，Rust/Axum，Vitest + Testing Library，Cargo tests（`test-utils`）。

---

## File Structure

### New files

- `src/hooks/use-file-tree-clipboard.ts`
  - 维护文件树剪贴板状态、来源路径、来源类型、复制/剪切模式和清空逻辑。
- `src/hooks/use-file-tree-clipboard.test.ts`
  - 验证剪贴板状态流转、覆盖目标判断、清空行为。
- `src/components/layout/file-tree-paste-conflict-dialog.tsx`
  - 粘贴冲突时弹出覆盖/副本/取消的确认对话框。
- `src/components/layout/file-tree-paste-conflict-dialog.test.tsx`
  - 验证对话框三种选择和回调分发。

### Modified files

- `src/components/layout/aux-panel-file-tree-tab.tsx`
  - 把文件操作和路径复制动作统一到一个一级菜单；接入剪贴板状态、粘贴目标选择和冲突弹窗。
- `src/components/layout/aux-panel-file-tree-tab.test.tsx`
  - 补齐菜单结构、粘贴可用性和路径复制回归测试。
- `src/lib/types.ts`
  - 新增粘贴命令请求/响应类型，以及冲突策略相关类型。
- `src/lib/api.ts`
  - 增加 `pasteFileTreeEntry` API 包装。
- `src/lib/tauri.ts`
  - 增加 `pasteFileTreeEntry` invoke 包装。
- `src-tauri/src/commands/folders.rs`
  - 新增文件树粘贴命令、递归复制/移动辅助函数、冲突和路径校验测试。
- `src-tauri/src/web/handlers/files.rs`
  - 新增 HTTP handler 和请求体结构。
- `src-tauri/src/web/router.rs`
  - 注册 `/paste_file_tree_entry` 路由。
- `src-tauri/src/lib.rs`
  - 注册 Tauri invoke 命令。
- `src/i18n/messages/*.json`
  - 增加文件操作菜单、冲突弹窗和粘贴结果提示文案。

---

## Commit cadence

按小步提交，避免一口气堆太多变更：

1. `feat(files): 添加后端文件树粘贴命令`
2. `feat(files): 接入文件树剪贴板和右键菜单`
3. `feat(files): 增加粘贴冲突弹窗和文案`
4. `test(files): 补齐复制剪切粘贴回归测试`

---

## Task 1: Add the backend paste command and path safety checks

**Files:**
- Modify: `src-tauri/src/commands/folders.rs`
- Modify: `src-tauri/src/web/handlers/files.rs`
- Modify: `src-tauri/src/web/router.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/folders.rs` under `#[cfg(test)]`

- [ ] **Step 1: Write the failing Rust tests**

Append a dedicated test module near the existing file-tree helpers in `src-tauri/src/commands/folders.rs`.

```rust
#[cfg(test)]
mod file_tree_paste_tests {
    use super::*;

    fn seed_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, content).expect("write file");
    }

    #[tokio::test]
    async fn paste_file_tree_entry_copies_file_into_target_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        let src = root.join("src/app.ts");
        let dst_dir = root.join("notes");
        std::fs::create_dir_all(&dst_dir).expect("create dir");
        seed_file(&src, "console.log('hi')\n");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            "notes".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Overwrite,
        )
        .await
        .expect("paste file");

        assert_eq!(result, "notes/app.ts");
        assert!(dst_dir.join("app.ts").exists());
        assert!(src.exists());
    }

    #[tokio::test]
    async fn paste_file_tree_entry_rejects_descendant_target_for_directory_cut() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        let src_dir = root.join("docs");
        let nested_dir = src_dir.join("archive");
        std::fs::create_dir_all(&nested_dir).expect("create tree");
        seed_file(&src_dir.join("readme.md"), "hello\n");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "docs".to_string(),
            "docs/archive".to_string(),
            PasteFileTreeEntryMode::Cut,
            PasteConflictStrategy::Overwrite,
        )
        .await
        .expect_err("cannot paste into descendant");

        assert_eq!(err.code, "invalid_input");
    }

    #[tokio::test]
    async fn paste_file_tree_entry_reports_conflict_when_target_exists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        let src = root.join("src/app.ts");
        let dst_dir = root.join("notes");
        std::fs::create_dir_all(&dst_dir).expect("create dir");
        seed_file(&src, "console.log('hi')\n");
        seed_file(&dst_dir.join("app.ts"), "old\n");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            "notes".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("conflict should abort");

        assert_eq!(err.code, "already_exists");
    }
}
```

- [ ] **Step 2: Run the Rust tests and verify RED**

Run:

```bash
cd src-tauri && cargo test --features test-utils file_tree_paste_tests -- --nocapture
```

Expected: fail because `paste_file_tree_entry`, `PasteFileTreeEntryMode`, and `PasteConflictStrategy` do not exist yet.

- [ ] **Step 3: Implement the backend command and helpers**

Add the new request/response path inside `src-tauri/src/commands/folders.rs` with small helper functions. Keep the function body short by splitting recursive copy and name collision handling out into private helpers.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteFileTreeEntryMode {
    Copy,
    Cut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteConflictStrategy {
    Abort,
    Overwrite,
    Duplicate,
}

fn is_descendant(candidate_parent: &Path, candidate_child: &Path) -> bool {
    candidate_child.starts_with(candidate_parent)
}

fn build_duplicate_name(name: &str, attempt: usize) -> String {
    if attempt == 1 {
        format!("{}-副本", name)
    } else {
        format!("{}-副本({})", name, attempt)
    }
}

async fn copy_tree_entry(
    source: &Path,
    destination: &Path,
) -> Result<(), AppCommandError> {
    if source.is_file() {
        std::fs::copy(source, destination).map_err(AppCommandError::io)?;
        return Ok(());
    }

    std::fs::create_dir_all(destination).map_err(AppCommandError::io)?;
    for entry in std::fs::read_dir(source).map_err(AppCommandError::io)? {
        let entry = entry.map_err(AppCommandError::io)?;
        let child_source = entry.path();
        let child_destination = destination.join(entry.file_name());
        copy_tree_entry(&child_source, &child_destination).await?;
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn paste_file_tree_entry(
    root_path: String,
    source_path: String,
    target_dir_path: String,
    mode: PasteFileTreeEntryMode,
    conflict: PasteConflictStrategy,
) -> Result<String, AppCommandError> {
    // Validate root and resolve all paths under it before touching disk.
    // The command must not rely on frontend path math, because the same file
    // tree can be reached from both desktop and server modes.
    //
    // Resolve the source and target relative to the workspace root, then reject
    // moves that would place a directory inside itself or one of its descendants.
    // When conflict strategy is Duplicate, generate the replacement name here so
    // the frontend does not need to guess based on stale tree state.
    unimplemented!()
}
```

Follow the existing `resolve_tree_path`, `ensure_path_in_workspace`, `atomic_write_text`, and `run_file_io` patterns already used in this file. Keep all path validation on the Rust side.

- [ ] **Step 4: Register the new command in web and Tauri entry points**

Add the handler and route.

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteFileTreeEntryParams {
    pub root_path: String,
    pub source_path: String,
    pub target_dir_path: String,
    pub mode: PasteFileTreeEntryMode,
    pub conflict: PasteConflictStrategy,
}

pub async fn paste_file_tree_entry(
    Json(params): Json<PasteFileTreeEntryParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::paste_file_tree_entry(
        params.root_path,
        params.source_path,
        params.target_dir_path,
        params.mode,
        params.conflict,
    )
    .await?;
    Ok(Json(result))
}
```

Register it in the router next to the other file routes:

```rust
.route(
    "/paste_file_tree_entry",
    post(handlers::files::paste_file_tree_entry),
)
```

Add it to the Tauri command list in `src-tauri/src/lib.rs`:

```rust
folders::paste_file_tree_entry,
```

- [ ] **Step 5: Run the Rust tests and verify GREEN**

Run:

```bash
cd src-tauri && cargo test --features test-utils file_tree_paste_tests -- --nocapture
```

Expected: all tests in `file_tree_paste_tests` pass.

- [ ] **Step 6: Commit the backend work**

```bash
git add src-tauri/src/commands/folders.rs src-tauri/src/web/handlers/files.rs src-tauri/src/web/router.rs src-tauri/src/lib.rs
git commit -m "feat(files): 添加后端文件树粘贴命令"
```

---

## Task 2: Wire the client API and shared types

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/tauri.ts`
- Test: `src/lib/api.test.ts`

- [ ] **Step 1: Write the failing TypeScript API test**

Create `src/lib/api.test.ts` so the wrapper contract is pinned before code changes.

```ts
import { describe, expect, it, vi } from "vitest"
import { pasteFileTreeEntry } from "./api"

const callMock = vi.fn()

vi.mock("./transport", () => ({
  getTransport: () => ({
    call: callMock,
  }),
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
```

- [ ] **Step 2: Run the API test and verify RED**

Run:

```bash
pnpm vitest src/lib/api.test.ts -v
```

Expected: fail because `pasteFileTreeEntry` does not exist yet.

- [ ] **Step 3: Add the shared request/response types and wrappers**

Add the request types in `src/lib/types.ts` and keep the shape simple so both transports share it.

```ts
export type PasteFileTreeEntryMode = "copy" | "cut"
export type PasteConflictStrategy = "abort" | "overwrite" | "duplicate"

export interface PasteFileTreeEntryRequest {
  rootPath: string
  sourcePath: string
  targetDirPath: string
  mode: PasteFileTreeEntryMode
  conflict: PasteConflictStrategy
}
```

Add the wrappers in both client layers:

```ts
export async function pasteFileTreeEntry(
  request: PasteFileTreeEntryRequest
): Promise<string> {
  return getTransport().call("paste_file_tree_entry", request)
}
```

and in `src/lib/tauri.ts`:

```ts
export async function pasteFileTreeEntry(
  request: PasteFileTreeEntryRequest
): Promise<string> {
  return invoke("paste_file_tree_entry", request)
}
```

- [ ] **Step 4: Run the API test and verify GREEN**

Run:

```bash
pnpm vitest src/lib/api.test.ts -v
```

Expected: pass.

- [ ] **Step 5: Commit the transport wiring**

```bash
git add src/lib/types.ts src/lib/api.ts src/lib/tauri.ts src/lib/api.test.ts
git commit -m "feat(files): 接入文件树粘贴接口"
```

---

## Task 3: Add the file-tree clipboard hook and update the right-click menu

**Files:**
- Create: `src/hooks/use-file-tree-clipboard.ts`
- Create: `src/hooks/use-file-tree-clipboard.test.ts`
- Modify: `src/components/layout/aux-panel-file-tree-tab.tsx`
- Modify: `src/components/layout/aux-panel-file-tree-tab.test.tsx`

- [ ] **Step 1: Write the failing hook test**

Create a small hook test that proves the clipboard state lifecycle before wiring it into the tree.

```ts
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useFileTreeClipboard } from "./use-file-tree-clipboard"

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
})
```

- [ ] **Step 2: Run the hook test and verify RED**

Run:

```bash
pnpm vitest src/hooks/use-file-tree-clipboard.test.ts -v
```

Expected: fail because the hook does not exist yet.

- [ ] **Step 3: Implement the clipboard hook**

Keep the hook focused on one job: remember the last file-tree source and compute whether a target is valid.

```ts
export interface FileTreeClipboardItem {
  mode: "copy" | "cut"
  sourcePath: string
  sourceName: string
  sourceKind: "file" | "dir"
}

export function useFileTreeClipboard() {
  // Store clipboard state locally so the feature stays scoped to the auxiliary panel.
  // The hook should not know anything about API calls or toasts.
}
```

Add helpers for resolving the paste target from a right-click node versus the current selection. That keeps `aux-panel-file-tree-tab.tsx` from growing further than necessary.

- [ ] **Step 4: Update the file tree context menu and preserve the path-copy actions**

Refactor the current `copyFilePath` submenu into one shared first-level submenu that contains all five actions:

```tsx
<ContextMenuSub>
  <ContextMenuSubTrigger>{t("copyPaste")}</ContextMenuSubTrigger>
  <ContextMenuSubContent>
    <ContextMenuItem onSelect={() => handleCopyEntry()}> {t("copyEntry")}</ContextMenuItem>
    <ContextMenuItem onSelect={() => handleCutEntry()}> {t("cutEntry")}</ContextMenuItem>
    <ContextMenuItem onSelect={() => handlePasteEntry()}> {t("pasteEntry")}</ContextMenuItem>
    <ContextMenuItem onSelect={() => void handleCopyFilePath()}>
      {t("copyRelativePath")}
    </ContextMenuItem>
    <ContextMenuItem onSelect={() => void handleCopyAbsolutePath()}>
      {t("copyAbsolutePath")}
    </ContextMenuItem>
  </ContextMenuSubContent>
</ContextMenuSub>
```

Rules to preserve in the implementation:

- File nodes and directory nodes both get the submenu.
- Paste is enabled only when clipboard state is present.
- If the user right-clicks a file, paste should target that file’s parent directory.
- If the user right-clicks a directory or the root node, paste should target that directory.
- Copy/cut should update the local clipboard state only.

- [ ] **Step 5: Run the component test and verify the menu behavior**

Add or extend `src/components/layout/aux-panel-file-tree-tab.test.tsx` so it checks the unified submenu and the clip state hooks are wired into the menu.

```tsx
it("renders copy, cut, paste and path-copy actions in one submenu", () => {
  // render the file node and assert the submenu items exist
  // click copy/cut and assert the clipboard state changes
  // keep the existing path-copy checks intact
})
```

Run:

```bash
pnpm vitest src/components/layout/aux-panel-file-tree-tab.test.tsx -v
```

Expected: fail before the menu refactor is complete, then pass after the refactor.

- [ ] **Step 6: Commit the UI state and menu work**

```bash
git add src/hooks/use-file-tree-clipboard.ts src/hooks/use-file-tree-clipboard.test.ts src/components/layout/aux-panel-file-tree-tab.tsx src/components/layout/aux-panel-file-tree-tab.test.tsx
git commit -m "feat(files): 接入文件树剪贴板和右键菜单"
```

---

## Task 4: Add the paste conflict dialog and localize the new labels

**Files:**
- Create: `src/components/layout/file-tree-paste-conflict-dialog.tsx`
- Create: `src/components/layout/file-tree-paste-conflict-dialog.test.tsx`
- Modify: `src/components/layout/aux-panel-file-tree-tab.tsx`
- Modify: `src/i18n/messages/ar.json`
- Modify: `src/i18n/messages/de.json`
- Modify: `src/i18n/messages/en.json`
- Modify: `src/i18n/messages/es.json`
- Modify: `src/i18n/messages/ja.json`
- Modify: `src/i18n/messages/ko.json`
- Modify: `src/i18n/messages/pt.json`
- Modify: `src/i18n/messages/zh-CN.json`
- Modify: `src/i18n/messages/zh-TW.json`

- [ ] **Step 1: Write the failing dialog test**

Create a dialog test that proves the user can choose overwrite, duplicate, or cancel.

```tsx
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileTreePasteConflictDialog } from "./file-tree-paste-conflict-dialog"

describe("FileTreePasteConflictDialog", () => {
  it("returns the selected strategy", () => {
    const onConfirm = vi.fn()
    render(
      <FileTreePasteConflictDialog
        open
        sourceName="app.ts"
        targetName="app.ts"
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /overwrite/i }))
    expect(onConfirm).toHaveBeenCalledWith("overwrite")
  })
})
```

- [ ] **Step 2: Run the dialog test and verify RED**

Run:

```bash
pnpm vitest src/components/layout/file-tree-paste-conflict-dialog.test.tsx -v
```

Expected: fail because the dialog does not exist yet.

- [ ] **Step 3: Implement the dialog and connect the retry flow**

Add a focused dialog component that only reports the chosen conflict strategy.

```tsx
export function FileTreePasteConflictDialog({
  open,
  sourceName,
  targetName,
  onConfirm,
  onOpenChange,
}: FileTreePasteConflictDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{sourceName}</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onConfirm("overwrite")}>Overwrite</Button>
          <Button onClick={() => onConfirm("duplicate")}>Paste as copy</Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

Wire the dialog into `aux-panel-file-tree-tab.tsx` so a conflict from the backend re-opens the paste flow with the chosen strategy.

- [ ] **Step 4: Add translation keys for the new menu and dialog labels**

Update every locale file under `src/i18n/messages/` with the same keys so the build stays consistent. Add entries under `Folder.fileTreeTab` such as:

```json
{
  "copyPaste": "复制 / 粘贴",
  "copyEntry": "复制",
  "cutEntry": "剪切",
  "pasteEntry": "粘贴",
  "pasteConflict": {
    "title": "目标已存在同名项",
    "description": "请选择覆盖，还是粘贴成副本。",
    "overwrite": "覆盖",
    "duplicate": "粘贴成副本",
    "cancel": "取消"
  },
  "toasts": {
    "pasteFailed": "粘贴失败",
    "pasteSucceeded": "已完成粘贴"
  }
}
```

Mirror the same structure in every locale file so `next-intl` lookups remain type- and key-safe.

- [ ] **Step 5: Run the dialog and i18n checks**

Run:

```bash
pnpm vitest src/components/layout/file-tree-paste-conflict-dialog.test.tsx -v
pnpm eslint src/components/layout/aux-panel-file-tree-tab.tsx src/components/layout/file-tree-paste-conflict-dialog.tsx src/lib/api.ts src/lib/tauri.ts src/lib/types.ts
```

Expected: both commands pass after the dialog and labels are wired.

- [ ] **Step 6: Commit the dialog and localization work**

```bash
git add src/components/layout/file-tree-paste-conflict-dialog.tsx src/components/layout/file-tree-paste-conflict-dialog.test.tsx src/components/layout/aux-panel-file-tree-tab.tsx src/i18n/messages/*.json
git commit -m "feat(files): 增加粘贴冲突弹窗和文案"
```

---

## Task 5: Run the full verification pass and clean up any regressions

**Files:**
- Modify: only files changed by earlier tasks if a test exposes a bug
- Test: `src/components/layout/aux-panel-file-tree-tab.test.tsx`, `src/hooks/use-file-tree-clipboard.test.ts`, `src/components/layout/file-tree-paste-conflict-dialog.test.tsx`, `src/lib/api.test.ts`, `src-tauri/src/commands/folders.rs`

- [ ] **Step 1: Run the targeted test set**

Run the exact commands below from the repo root:

```bash
pnpm vitest src/lib/api.test.ts src/hooks/use-file-tree-clipboard.test.ts src/components/layout/file-tree-paste-conflict-dialog.test.tsx src/components/layout/aux-panel-file-tree-tab.test.tsx -v
cd src-tauri && cargo test --features test-utils file_tree_paste_tests -- --nocapture
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run lint on the touched frontend files**

Run:

```bash
pnpm eslint src/components/layout/aux-panel-file-tree-tab.tsx src/components/layout/file-tree-paste-conflict-dialog.tsx src/hooks/use-file-tree-clipboard.ts src/lib/api.ts src/lib/tauri.ts src/lib/types.ts
```

Expected: no lint errors.

- [ ] **Step 3: Run the exact code paths once in the app if needed**

If the test suite exposes an ambiguity in paste target selection or conflict handling, adjust the UI logic and rerun the same tests instead of expanding scope.

- [ ] **Step 4: Commit the final cleanup**

If any test-driven follow-up fix is needed, commit it with a scoped message such as:

```bash
git add <changed files>
git commit -m "fix(files): 修正文件树粘贴交互"
```

---

## Plan Coverage Check

- 文件和文件夹复制/剪切/粘贴：Task 1, Task 3
- 粘贴目标优先右键位置，否则用当前选中项：Task 3
- 同名冲突提示覆盖或副本：Task 4
- 复制相对路径/复制绝对路径与文件操作统一进同一一级菜单：Task 3
- 仅作用于辅助面板当前工作区文件树：Task 3, Task 4
- 后端真实文件系统操作与边界校验：Task 1
- 前端局部状态、菜单和刷新行为：Task 3, Task 4, Task 5
- i18n 文案补齐：Task 4
- 端到端验证：Task 5

## Self-Review Notes

- No placeholders remain in the plan.
- Task boundaries are small enough to implement and verify independently.
- The typed request/response names are consistent across frontend and backend tasks.
- The plan keeps the file operations logic in Rust and the interaction logic in React, which matches the spec and avoids split-brain path handling.
