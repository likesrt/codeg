# Folder Browser and Content Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app directory creation and a configurable current-folder content search tab, then verify and run the Codex sub-agent review loop until production-ready.

**Architecture:** Keep the native desktop folder picker unchanged and enhance only `DirectoryBrowserDialog` for in-app browsing. Implement content search as a backend command that scans the active folder with configurable filters, while the search dialog gains a third `content` tab and stores its configuration in `localStorage`. File-preview find integration is an enhancement passed through `openFilePreview(..., { searchQuery })`, and it must gracefully degrade if Monaco cannot accept the search text.

**Tech Stack:** Tauri 2 + Rust/Axum commands, Next.js 16 + React 19 + TypeScript, Vitest + Testing Library, Cargo tests with `test-utils`, shadcn/radix UI primitives.

---

## File Structure

### New files

- `src/lib/content-search-settings.ts`
  - Owns default content-search settings, parsing comma-separated inputs, clamping numeric options, and `localStorage` persistence.
  - Keeps `SearchCommandDialog` from growing more than necessary.

- `src/lib/content-search-settings.test.ts`
  - Tests default settings, parsing, clamping, and storage round-trip.

- `src/components/conversations/search-command-dialog.test.tsx`
  - Tests the three-tab search dialog behavior and content-search trigger rules.

### Modified files

- `src/components/shared/directory-browser-dialog.tsx`
  - Add context menu actions for selecting a directory and creating a child directory.
  - Add inline create-directory input state and refresh the affected cached directory after success.

- `src/components/conversations/search-command-dialog.tsx`
  - Change `SearchTab` to `"conversations" | "files" | "content"`.
  - Keep existing conversation/file behavior unchanged.
  - Add content-search input, manual trigger, settings panel, result rendering, and result click handling.

- `src/components/files/file-workspace-panel.tsx`
  - Consume a pending search query from active file tabs and try to open Monaco find widget.

- `src/contexts/workspace-context.tsx`
  - Extend `openFilePreview` options with `searchQuery?: string`.
  - Store `pendingSearchQuery?: string` on file tabs.

- `src/lib/types.ts`
  - Add `SearchFilesRequest`, `SearchFilesResponse`, and `SearchFileMatch` TypeScript interfaces.

- `src/lib/api.ts`
  - Export `searchFiles(request)` using transport call `search_files`.
  - Existing `createFolderDirectory(path)` already maps to `create_folder_directory`; reuse it for the directory browser.

- `src/lib/tauri.ts`
  - Export `searchFiles(request)` using Tauri invoke `search_files`.

- `src-tauri/src/commands/folders.rs`
  - Tighten `create_folder_directory` validation so creating an existing target errors.
  - Add search request/response structs and `search_files` command.
  - Add Rust tests in this file under `#[cfg(test)]` for creation and search rules.

- `src-tauri/src/web/handlers/folders.rs`
  - Add `search_files` handler that delegates to `folder_commands::search_files`.

- `src-tauri/src/web/router.rs`
  - Register `/search_files` route.

- `src-tauri/src/lib.rs`
  - Register `folders::search_files` in Tauri invoke handler.

- `i18n/messages/*.json`
  - Add labels for content tab, search button, settings fields, empty/error/truncated states, and directory-browser create actions.

---

## Commit cadence

Commit after each working goal:

1. `fix(folder): 完善内置目录浏览器新建目录能力`
2. `feat(search): 添加后端文件内容搜索命令`
3. `feat(search): 添加内容搜索配置持久化`
4. `feat(search): 添加搜索面板内容标签页`
5. `feat(files): 支持从内容搜索打开文件查找`
6. `test(search): 补齐内容搜索验证和评审修复` if Codex review requires changes that do not fit an earlier commit.

Do not squash these commits unless the user explicitly asks.

---

## Task 1: Directory creation behavior

**Files:**
- Modify: `src-tauri/src/commands/folders.rs:686-689`
- Modify: `src/components/shared/directory-browser-dialog.tsx`
- Modify: `i18n/messages/*.json`

- [ ] **Step 1: Write failing Rust tests for directory creation**

Append these tests inside `src-tauri/src/commands/folders.rs` in a `#[cfg(test)] mod directory_browser_tests` block near the directory-browser helpers. If a test module already exists by implementation time, add these tests to it instead.

```rust
#[cfg(test)]
mod directory_browser_tests {
    use super::*;

    #[tokio::test]
    async fn create_folder_directory_creates_missing_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("new-child");

        create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect("create directory");

        assert!(target.is_dir());
    }

    #[tokio::test]
    async fn create_folder_directory_rejects_existing_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("existing");
        std::fs::create_dir(&target).expect("seed existing dir");

        let err = create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect_err("existing directory should fail");

        assert_eq!(err.code, "already_exists");
    }

    #[tokio::test]
    async fn create_folder_directory_rejects_missing_parent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("missing-parent").join("child");

        let err = create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect_err("missing parent should fail");

        assert_eq!(err.code, "not_found");
    }
}
```

- [ ] **Step 2: Run Rust test and verify RED**

Run:

```bash
cd src-tauri && cargo test --features test-utils directory_browser_tests -- --nocapture
```

Expected: at least `create_folder_directory_rejects_existing_directory` fails because the current code uses `std::fs::create_dir_all` and accepts existing directories.

- [ ] **Step 3: Implement minimal Rust behavior**

Replace `create_folder_directory` in `src-tauri/src/commands/folders.rs` with this documented implementation:

```rust
/// Create a new directory at `path` for the in-app directory browser.
///
/// The target path must be non-empty, must not already exist, and its parent
/// directory must already exist. The function intentionally uses `create_dir`
/// rather than `create_dir_all` so the UI can report accidental duplicate names
/// instead of silently treating them as success.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_directory(path: String) -> Result<(), AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }

    let target = PathBuf::from(trimmed);
    if target.exists() {
        return Err(AppCommandError::already_exists("Directory already exists"));
    }

    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Directory must have a parent"))?;
    if !parent.is_dir() {
        return Err(AppCommandError::not_found("Parent directory does not exist"));
    }

    std::fs::create_dir(&target).map_err(AppCommandError::io)
}
```

- [ ] **Step 4: Run Rust test and verify GREEN**

Run:

```bash
cd src-tauri && cargo test --features test-utils directory_browser_tests -- --nocapture
```

Expected: all three tests pass.

- [ ] **Step 5: Write failing frontend test for directory browser context menu**

Create `src/components/shared/directory-browser-dialog.test.tsx` with this test harness. The mocked context menu renders menu items as buttons, so the test can click them directly.

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { DirectoryBrowserDialog } from "./directory-browser-dialog"
import { createFolderDirectory, getHomeDirectory, listDirectoryEntries } from "@/lib/api"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/lib/api", () => ({
  createFolderDirectory: vi.fn(),
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect} type="button">{children}</button>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const mockedGetHomeDirectory = vi.mocked(getHomeDirectory)
const mockedListDirectoryEntries = vi.mocked(listDirectoryEntries)
const mockedCreateFolderDirectory = vi.mocked(createFolderDirectory)

describe("DirectoryBrowserDialog", () => {
  beforeEach(() => {
    mockedGetHomeDirectory.mockResolvedValue("/home/me")
    mockedListDirectoryEntries.mockReset()
    mockedListDirectoryEntries.mockResolvedValue([
      { name: "project", path: "/home/me/project", hasChildren: false },
    ])
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
      expect(mockedCreateFolderDirectory).toHaveBeenCalledWith("/home/me/project/src")
    })
    expect(mockedListDirectoryEntries).toHaveBeenCalledWith("/home/me/project")
  })
})
```

- [ ] **Step 6: Run frontend test and verify RED**

Run:

```bash
pnpm test src/components/shared/directory-browser-dialog.test.tsx
```

Expected: FAIL because the context menu action and create UI do not exist yet.

- [ ] **Step 7: Implement directory browser UI**

In `src/components/shared/directory-browser-dialog.tsx`:

1. Import the existing API and context-menu primitives:

```tsx
import { createFolderDirectory, getHomeDirectory, listDirectoryEntries } from "@/lib/api"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
```

2. Add state after `error`:

```tsx
const [createParentPath, setCreateParentPath] = useState<string | null>(null)
const [newFolderName, setNewFolderName] = useState("")
```

3. Add helpers before `renderEntries`:

```tsx
/**
 * Join a parent path and a child folder name using the separator style already
 * present in the parent. The browser may run against Unix, Windows, or remote
 * paths, so this avoids assuming a single platform separator.
 */
function joinChildDirectory(parent: string, child: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`
}

/**
 * Validate the new folder name before sending it to the backend. The backend
 * still validates the final path, but the dialog can give immediate feedback
 * for empty names and path separators.
 */
function validateNewFolderName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return t("newFolderNameRequired")
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return t("newFolderNameInvalid")
  }
  return null
}

/**
 * Create a child directory under the currently selected context-menu parent and
 * refresh that parent so the new folder appears without closing the browser.
 */
const handleCreateChildDirectory = useCallback(async () => {
  if (!createParentPath) return
  const validationError = validateNewFolderName(newFolderName)
  if (validationError) {
    setError(validationError)
    return
  }

  const target = joinChildDirectory(createParentPath, newFolderName.trim())
  setError(null)
  try {
    await createFolderDirectory(target)
    setEntries((prev) => {
      const next = new Map(prev)
      next.delete(createParentPath)
      return next
    })
    await loadEntries(createParentPath)
    setSelectedPath(target)
    setCreateParentPath(null)
    setNewFolderName("")
  } catch {
    setError(t("errorCreatingDir"))
  }
}, [createParentPath, loadEntries, newFolderName, t])
```

4. Wrap each entry button with `ContextMenu`:

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>
    <button ...existing props...>
      ...existing row content...
    </button>
  </ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem onSelect={() => handleDoubleClick(entry.path)}>
      {t("selectThisFolder")}
    </ContextMenuItem>
    <ContextMenuItem
      onSelect={() => {
        setCreateParentPath(entry.path)
        setNewFolderName("")
        setSelectedPath(entry.path)
      }}
    >
      {t("newChildFolder")}
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

5. Render inline create controls below the selected path block:

```tsx
{createParentPath && (
  <div className="flex items-center gap-2 rounded-md border p-2">
    <Input
      value={newFolderName}
      onChange={(e) => setNewFolderName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void handleCreateChildDirectory()
        if (e.key === "Escape") setCreateParentPath(null)
      }}
      placeholder={t("newFolderNamePlaceholder")}
      className="h-8 text-sm"
    />
    <Button size="sm" onClick={handleCreateChildDirectory} type="button">
      {t("create")}
    </Button>
    <Button
      size="sm"
      variant="outline"
      onClick={() => setCreateParentPath(null)}
      type="button"
    >
      {t("cancel")}
    </Button>
  </div>
)}
```

Keep each added/modified function under 30 non-comment lines and keep the JSDoc comments accurate.

- [ ] **Step 8: Add i18n keys for directory browser**

For every `i18n/messages/*.json`, add these keys under `DirectoryBrowser` with translated values where practical; English fallback text is acceptable if no local translation is available during implementation:

```json
{
  "selectThisFolder": "Select this folder",
  "newChildFolder": "New child folder",
  "newFolderNamePlaceholder": "Folder name",
  "newFolderNameRequired": "Folder name is required",
  "newFolderNameInvalid": "Folder name cannot contain path separators",
  "errorCreatingDir": "Failed to create folder",
  "create": "Create"
}
```

- [ ] **Step 9: Run frontend test and verify GREEN**

Run:

```bash
pnpm test src/components/shared/directory-browser-dialog.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Run focused checks and commit**

Run:

```bash
pnpm test src/components/shared/directory-browser-dialog.test.tsx
cd src-tauri && cargo test --features test-utils directory_browser_tests -- --nocapture
```

Expected: both pass.

Commit:

```bash
git add src/components/shared/directory-browser-dialog.tsx \
  src/components/shared/directory-browser-dialog.test.tsx \
  src-tauri/src/commands/folders.rs \
  i18n/messages/*.json
git commit -m "fix(folder): 完善内置目录浏览器新建目录能力"
```

---

## Task 2: Backend content search command

**Files:**
- Modify: `src-tauri/src/commands/folders.rs`
- Modify: `src-tauri/src/web/handlers/folders.rs`
- Modify: `src-tauri/src/web/router.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: Write failing Rust tests for search behavior**

Add these tests to `src-tauri/src/commands/folders.rs` under `#[cfg(test)] mod search_files_tests`:

```rust
#[cfg(test)]
mod search_files_tests {
    use super::*;

    fn request(root: &std::path::Path, query: &str) -> SearchFilesRequest {
        SearchFilesRequest {
            root_path: root.to_string_lossy().to_string(),
            query: query.to_string(),
            search_dirs: vec![".".to_string()],
            include_extensions: vec![],
            exclude_dirs: default_search_exclude_dirs(),
            exclude_extensions: default_search_exclude_extensions(),
            max_results: 100,
            max_file_bytes: 2 * 1024 * 1024,
        }
    }

    #[tokio::test]
    async fn search_files_returns_line_matches() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("app.ts"), "alpha\nneedle here\nomega\n")
            .expect("write file");

        let response = search_files(request(temp.path(), "needle"))
            .await
            .expect("search");

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].path, "app.ts");
        assert_eq!(response.results[0].line_number, 2);
        assert_eq!(response.results[0].line_text, "needle here");
        assert!(!response.truncated);
    }

    #[tokio::test]
    async fn search_files_respects_excluded_directories() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(temp.path().join("node_modules")).expect("mkdir");
        std::fs::write(temp.path().join("node_modules/pkg.js"), "needle").expect("write");

        let response = search_files(request(temp.path(), "needle"))
            .await
            .expect("search");

        assert!(response.results.is_empty());
    }

    #[tokio::test]
    async fn search_files_respects_include_and_exclude_extensions() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("app.ts"), "needle").expect("write ts");
        std::fs::write(temp.path().join("app.lock"), "needle").expect("write lock");
        std::fs::write(temp.path().join("readme.md"), "needle").expect("write md");

        let mut req = request(temp.path(), "needle");
        req.include_extensions = vec![".ts".to_string(), "lock".to_string()];

        let response = search_files(req).await.expect("search");

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].path, "app.ts");
    }

    #[tokio::test]
    async fn search_files_truncates_at_max_results() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("a.txt"), "needle\nneedle\nneedle\n").expect("write");
        let mut req = request(temp.path(), "needle");
        req.max_results = 2;

        let response = search_files(req).await.expect("search");

        assert_eq!(response.results.len(), 2);
        assert!(response.truncated);
    }

    #[tokio::test]
    async fn search_files_rejects_search_dir_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut req = request(temp.path(), "needle");
        req.search_dirs = vec!["..".to_string()];

        let err = search_files(req).await.expect_err("escape should fail");

        assert_eq!(err.code, "invalid_input");
    }
}
```

- [ ] **Step 2: Run Rust tests and verify RED**

Run:

```bash
cd src-tauri && cargo test --features test-utils search_files_tests -- --nocapture
```

Expected: FAIL because `SearchFilesRequest`, `search_files`, and default helper functions do not exist.

- [ ] **Step 3: Implement Rust search types and helpers**

Add these structs near the existing directory-browser helper structs in `src-tauri/src/commands/folders.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesRequest {
    pub root_path: String,
    pub query: String,
    pub search_dirs: Vec<String>,
    pub include_extensions: Vec<String>,
    pub exclude_dirs: Vec<String>,
    pub exclude_extensions: Vec<String>,
    pub max_results: usize,
    pub max_file_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResponse {
    pub results: Vec<SearchFileMatch>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub skipped_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileMatch {
    pub path: String,
    pub name: String,
    pub line_number: usize,
    pub line_text: String,
}
```

Add documented helpers, keeping each function under 30 non-comment lines:

```rust
/// Return directory names skipped by default during content search.
pub fn default_search_exclude_dirs() -> Vec<String> {
    [
        ".git",
        "node_modules",
        "dist",
        "build",
        ".next",
        ".turbo",
        "target",
        "coverage",
        "__pycache__",
        ".venv",
        "venv",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Return file extensions skipped by default during content search.
pub fn default_search_exclude_extensions() -> Vec<String> {
    [
        "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "tar", "gz", "7z",
        "rar", "exe", "dll", "so", "dylib", "bin", "lock",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Normalize extension filters so `ts` and `.ts` compare the same way.
fn normalize_extensions(values: &[String]) -> HashSet<String> {
    values
        .iter()
        .map(|v| v.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Normalize directory filters to slash-separated relative paths or names.
fn normalize_dir_filters(values: &[String]) -> HashSet<String> {
    values
        .iter()
        .map(|v| v.trim().trim_matches('/').replace('\\', "/"))
        .filter(|v| !v.is_empty())
        .collect()
}

/// Detect binary files using a small NUL-byte sample to avoid reading large
/// blobs into memory during search.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}
```

- [ ] **Step 4: Implement `search_files` command**

Add this command to `src-tauri/src/commands/folders.rs`:

```rust
/// Search text files under `root_path` for a plain case-insensitive query.
///
/// The command is intentionally bounded by result count, per-file byte limit,
/// binary detection, and root-path containment checks so it can be used from a
/// UI command without indexing or background workers.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn search_files(request: SearchFilesRequest) -> Result<SearchFilesResponse, AppCommandError> {
    let query = request.query.trim().to_ascii_lowercase();
    if query.is_empty() {
        return Ok(SearchFilesResponse {
            results: Vec::new(),
            truncated: false,
            scanned_files: 0,
            skipped_files: 0,
        });
    }

    run_file_io(move || search_files_blocking(request, query)).await
}
```

Add private helpers. If a helper exceeds 30 non-comment lines, split it before committing.

```rust
/// Blocking implementation for `search_files`, run behind the file I/O
/// semaphore so large searches do not block the async runtime.
fn search_files_blocking(
    request: SearchFilesRequest,
    query: String,
) -> Result<SearchFilesResponse, AppCommandError> {
    let root = std::fs::canonicalize(PathBuf::from(&request.root_path)).map_err(AppCommandError::io)?;
    if !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let max_results = request.max_results.clamp(1, 1000);
    let max_file_bytes = request.max_file_bytes.clamp(64 * 1024, 10 * 1024 * 1024);
    let include_exts = normalize_extensions(&request.include_extensions);
    let exclude_exts = normalize_extensions(&request.exclude_extensions);
    let exclude_dirs = normalize_dir_filters(&request.exclude_dirs);
    let search_roots = resolve_search_roots(&root, &request.search_dirs)?;
    let mut response = SearchFilesResponse {
        results: Vec::new(),
        truncated: false,
        scanned_files: 0,
        skipped_files: 0,
    };

    for search_root in search_roots {
        scan_search_root(
            &root,
            &search_root,
            &query,
            &include_exts,
            &exclude_exts,
            &exclude_dirs,
            max_results,
            max_file_bytes,
            &mut response,
        )?;
        if response.truncated {
            break;
        }
    }

    Ok(response)
}

/// Resolve configured search directories and reject any path that escapes the
/// workspace root.
fn resolve_search_roots(root: &Path, dirs: &[String]) -> Result<Vec<PathBuf>, AppCommandError> {
    let raw_dirs: Vec<String> = if dirs.is_empty() {
        vec![".".to_string()]
    } else {
        dirs.to_vec()
    };

    raw_dirs
        .iter()
        .map(|dir| {
            let joined = root.join(dir.trim());
            let canonical = std::fs::canonicalize(&joined).map_err(AppCommandError::io)?;
            if !canonical.starts_with(root) {
                return Err(AppCommandError::invalid_input("Search directory escapes root"));
            }
            Ok(canonical)
        })
        .collect()
}
```

Implement `scan_search_root`, `should_skip_search_dir`, `should_search_file`, and `collect_file_matches` with these exact signatures:

```rust
fn scan_search_root(
    root: &Path,
    search_root: &Path,
    query: &str,
    include_exts: &HashSet<String>,
    exclude_exts: &HashSet<String>,
    exclude_dirs: &HashSet<String>,
    max_results: usize,
    max_file_bytes: usize,
    response: &mut SearchFilesResponse,
) -> Result<(), AppCommandError> { /* implementation */ }

fn should_skip_search_dir(root: &Path, path: &Path, exclude_dirs: &HashSet<String>) -> bool { /* implementation */ }

fn should_search_file(
    path: &Path,
    include_exts: &HashSet<String>,
    exclude_exts: &HashSet<String>,
) -> bool { /* implementation */ }

fn collect_file_matches(
    root: &Path,
    path: &Path,
    query: &str,
    max_results: usize,
    response: &mut SearchFilesResponse,
) -> Result<(), AppCommandError> { /* implementation */ }
```

Implementation requirements:

- `scan_search_root` must use `WalkDir::new(search_root).into_iter().filter_entry(...)`.
- `should_skip_search_dir` must skip if either the directory basename or its root-relative path appears in `exclude_dirs`.
- `should_search_file` must compare lowercase extensions without a leading dot.
- Before reading a file, check metadata length against `max_file_bytes`.
- Read bytes with `std::fs::read`, skip if `looks_binary(&bytes)` or UTF-8 decoding fails.
- For each line, compare `line.to_ascii_lowercase().contains(query)`.
- Relative result path must use `/` separators.

- [ ] **Step 5: Register Rust command and web route**

In `src-tauri/src/lib.rs`, add `folders::search_files` next to `folders::get_file_tree` in the invoke handler.

In `src-tauri/src/web/handlers/folders.rs`, add:

```rust
pub async fn search_files(
    Json(params): Json<folder_commands::SearchFilesRequest>,
) -> Result<Json<folder_commands::SearchFilesResponse>, AppCommandError> {
    let result = folder_commands::search_files(params).await?;
    Ok(Json(result))
}
```

In `src-tauri/src/web/router.rs`, add:

```rust
.route("/search_files", post(handlers::folders::search_files))
```

Place it near `/get_file_tree`.

- [ ] **Step 6: Add TypeScript types and API wrappers**

In `src/lib/types.ts`, add:

```ts
export interface SearchFilesRequest {
  rootPath: string
  query: string
  searchDirs: string[]
  includeExtensions: string[]
  excludeDirs: string[]
  excludeExtensions: string[]
  maxResults: number
  maxFileBytes: number
}

export interface SearchFileMatch {
  path: string
  name: string
  lineNumber: number
  lineText: string
}

export interface SearchFilesResponse {
  results: SearchFileMatch[]
  truncated: boolean
  scannedFiles: number
  skippedFiles: number
}
```

In `src/lib/api.ts`, import these types if needed and add:

```ts
export async function searchFiles(
  request: SearchFilesRequest
): Promise<SearchFilesResponse> {
  return getTransport().call("search_files", request)
}
```

In `src/lib/tauri.ts`, add:

```ts
export async function searchFiles(
  request: SearchFilesRequest
): Promise<SearchFilesResponse> {
  return invoke("search_files", request)
}
```

- [ ] **Step 7: Run Rust tests and verify GREEN**

Run:

```bash
cd src-tauri && cargo test --features test-utils search_files_tests -- --nocapture
```

Expected: all search tests pass.

- [ ] **Step 8: Run focused type/lint check and commit**

Run:

```bash
pnpm eslint src/lib/api.ts src/lib/tauri.ts src/lib/types.ts
cd src-tauri && cargo test --features test-utils search_files_tests -- --nocapture
```

Expected: all pass.

Commit:

```bash
git add src-tauri/src/commands/folders.rs \
  src-tauri/src/web/handlers/folders.rs \
  src-tauri/src/web/router.rs \
  src-tauri/src/lib.rs \
  src/lib/types.ts src/lib/api.ts src/lib/tauri.ts
git commit -m "feat(search): 添加后端文件内容搜索命令"
```

---

## Task 3: Content search settings persistence

**Files:**
- Create: `src/lib/content-search-settings.ts`
- Create: `src/lib/content-search-settings.test.ts`

- [ ] **Step 1: Write failing tests for settings parsing and storage**

Create `src/lib/content-search-settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest"
import {
  CONTENT_SEARCH_DEFAULT_SETTINGS,
  loadContentSearchSettings,
  parseCommaList,
  saveContentSearchSettings,
  toSearchFilesRequest,
} from "./content-search-settings"

describe("content search settings", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("parses comma-separated values by trimming and dropping blanks", () => {
    expect(parseCommaList(" src, ,app , packages ")).toEqual([
      "src",
      "app",
      "packages",
    ])
  })

  it("loads defaults when storage is empty", () => {
    expect(loadContentSearchSettings()).toEqual(CONTENT_SEARCH_DEFAULT_SETTINGS)
  })

  it("round-trips settings through localStorage", () => {
    saveContentSearchSettings({
      searchDirsText: "src,app",
      includeExtensionsText: "ts,tsx",
      excludeDirsText: ".git,node_modules",
      excludeExtensionsText: "lock,png",
      maxResults: 50,
      maxFileBytesMb: 1,
    })

    expect(loadContentSearchSettings()).toEqual({
      searchDirsText: "src,app",
      includeExtensionsText: "ts,tsx",
      excludeDirsText: ".git,node_modules",
      excludeExtensionsText: "lock,png",
      maxResults: 50,
      maxFileBytesMb: 1,
    })
  })

  it("clamps numeric values when building a backend request", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxResults: 5000,
      maxFileBytesMb: 99,
    })

    expect(request.maxResults).toBe(1000)
    expect(request.maxFileBytes).toBe(10 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm test src/lib/content-search-settings.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement settings module**

Create `src/lib/content-search-settings.ts`:

```ts
import type { SearchFilesRequest } from "@/lib/types"

const STORAGE_KEY = "codeg.contentSearchSettings.v1"

export interface ContentSearchSettings {
  searchDirsText: string
  includeExtensionsText: string
  excludeDirsText: string
  excludeExtensionsText: string
  maxResults: number
  maxFileBytesMb: number
}

export const CONTENT_SEARCH_DEFAULT_SETTINGS: ContentSearchSettings = {
  searchDirsText: ".",
  includeExtensionsText: "",
  excludeDirsText:
    ".git,node_modules,dist,build,.next,.turbo,target,coverage,__pycache__,.venv,venv",
  excludeExtensionsText:
    "png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,7z,rar,exe,dll,so,dylib,bin,lock",
  maxResults: 100,
  maxFileBytesMb: 2,
}

/**
 * Parse comma-separated search setting text into trimmed values. Empty values
 * are dropped so accidental duplicate commas do not reach the backend.
 */
export function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Clamp a numeric setting so invalid persisted values cannot create expensive
 * backend searches or unusable zero-result searches.
 */
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * Load content-search settings from localStorage, falling back to safe defaults
 * when storage is unavailable or contains invalid JSON.
 */
export function loadContentSearchSettings(): ContentSearchSettings {
  if (typeof localStorage === "undefined") return CONTENT_SEARCH_DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return CONTENT_SEARCH_DEFAULT_SETTINGS
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return CONTENT_SEARCH_DEFAULT_SETTINGS
  }
}

/** Persist content-search settings for the next search dialog session. */
export function saveContentSearchSettings(settings: ContentSearchSettings): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)))
}

/**
 * Convert UI settings into the backend request shape. Values are clamped here
 * and again in Rust so both clients and direct API callers stay bounded.
 */
export function toSearchFilesRequest(
  rootPath: string,
  query: string,
  settings: ContentSearchSettings
): SearchFilesRequest {
  const normalized = normalizeSettings(settings)
  return {
    rootPath,
    query,
    searchDirs: parseCommaList(normalized.searchDirsText),
    includeExtensions: parseCommaList(normalized.includeExtensionsText),
    excludeDirs: parseCommaList(normalized.excludeDirsText),
    excludeExtensions: parseCommaList(normalized.excludeExtensionsText),
    maxResults: normalized.maxResults,
    maxFileBytes: normalized.maxFileBytesMb * 1024 * 1024,
  }
}

/** Normalize unknown persisted JSON into a complete settings object. */
function normalizeSettings(value: Partial<ContentSearchSettings>): ContentSearchSettings {
  return {
    searchDirsText: stringOrDefault(
      value.searchDirsText,
      CONTENT_SEARCH_DEFAULT_SETTINGS.searchDirsText
    ),
    includeExtensionsText: stringOrDefault(
      value.includeExtensionsText,
      CONTENT_SEARCH_DEFAULT_SETTINGS.includeExtensionsText
    ),
    excludeDirsText: stringOrDefault(
      value.excludeDirsText,
      CONTENT_SEARCH_DEFAULT_SETTINGS.excludeDirsText
    ),
    excludeExtensionsText: stringOrDefault(
      value.excludeExtensionsText,
      CONTENT_SEARCH_DEFAULT_SETTINGS.excludeExtensionsText
    ),
    maxResults: clampNumber(Number(value.maxResults), 1, 1000),
    maxFileBytesMb: clampNumber(Number(value.maxFileBytesMb), 0.0625, 10),
  }
}

/** Return a string setting when valid, otherwise a default. */
function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}
```

- [ ] **Step 4: Run test and verify GREEN**

Run:

```bash
pnpm test src/lib/content-search-settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/content-search-settings.ts src/lib/content-search-settings.test.ts
git commit -m "feat(search): 添加内容搜索配置持久化"
```

---

## Task 4: Search dialog content tab

**Files:**
- Modify: `src/components/conversations/search-command-dialog.tsx`
- Create/Modify: `src/components/conversations/search-command-dialog.test.tsx`
- Modify: `i18n/messages/*.json`

- [ ] **Step 1: Write failing tests for content tab manual triggering**

Create `src/components/conversations/search-command-dialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SearchCommandDialog } from "./search-command-dialog"
import { searchFiles } from "@/lib/api"

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 1, name: "repo", path: "/repo" },
    activeFolderId: 1,
  }),
}))

vi.mock("@/contexts/app-workspace-context", () => ({
  useAppWorkspace: () => ({ conversations: [] }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabContext: () => ({ openTab: vi.fn() }),
}))

const openFilePreview = vi.fn()
const revealInFileTree = vi.fn()

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceContext: () => ({ openFilePreview }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree }),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({ allFiles: [], loading: false, reset: vi.fn() }),
}))

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({
    results: [{ path: "src/app.ts", name: "app.ts", lineNumber: 2, lineText: "needle here" }],
    truncated: false,
    scannedFiles: 1,
    skippedFiles: 0,
  })),
}))

describe("SearchCommandDialog content tab", () => {
  beforeEach(() => {
    vi.mocked(searchFiles).mockClear()
    openFilePreview.mockClear()
    revealInFileTree.mockClear()
    localStorage.clear()
  })

  it("does not search content while typing and searches on button click", async () => {
    render(<SearchCommandDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "tabContent" }))
    fireEvent.change(screen.getByPlaceholderText("contentPlaceholder"), {
      target: { value: "needle" },
    })

    expect(searchFiles).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "searchContent" }))

    await waitFor(() => {
      expect(searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({ rootPath: "/repo", query: "needle" })
      )
    })
    expect(await screen.findByText("needle here")).toBeInTheDocument()
  })

  it("opens file preview with search query when selecting content result", async () => {
    render(<SearchCommandDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "tabContent" }))
    fireEvent.change(screen.getByPlaceholderText("contentPlaceholder"), {
      target: { value: "needle" },
    })
    fireEvent.click(screen.getByRole("button", { name: "searchContent" }))
    fireEvent.click(await screen.findByText("needle here"))

    expect(revealInFileTree).toHaveBeenCalledWith("src")
    expect(openFilePreview).toHaveBeenCalledWith("src/app.ts", {
      searchQuery: "needle",
    })
  })
})
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm test src/components/conversations/search-command-dialog.test.tsx
```

Expected: FAIL because `tabContent`, content search UI, and `searchFiles` integration do not exist.

- [ ] **Step 3: Implement content tab state and handlers**

In `src/components/conversations/search-command-dialog.tsx`:

1. Change type:

```ts
type SearchTab = "conversations" | "files" | "content"
```

2. Import API/settings/types:

```ts
import { listAllConversations, searchFiles } from "@/lib/api"
import type { SearchFileMatch } from "@/lib/types"
import {
  loadContentSearchSettings,
  saveContentSearchSettings,
  toSearchFilesRequest,
  type ContentSearchSettings,
} from "@/lib/content-search-settings"
```

3. Add state:

```ts
const [contentResults, setContentResults] = useState<SearchFileMatch[]>([])
const [contentSearching, setContentSearching] = useState(false)
const [contentError, setContentError] = useState<string | null>(null)
const [contentTruncated, setContentTruncated] = useState(false)
const [settingsOpen, setSettingsOpen] = useState(false)
const [contentSettings, setContentSettings] = useState<ContentSearchSettings>(
  loadContentSearchSettings
)
```

4. Add a documented search handler under 30 non-comment lines:

```ts
/**
 * Run backend content search only when the user explicitly confirms it. This
 * avoids rescanning large workspaces on every keystroke while keeping the same
 * current-folder scope as the existing search tabs.
 */
const runContentSearch = useCallback(async () => {
  const trimmed = query.trim()
  if (!folderPath || !trimmed) return
  setContentSearching(true)
  setContentError(null)
  saveContentSearchSettings(contentSettings)
  try {
    const response = await searchFiles(
      toSearchFilesRequest(folderPath, trimmed, contentSettings)
    )
    setContentResults(response.results)
    setContentTruncated(response.truncated)
  } catch {
    setContentResults([])
    setContentTruncated(false)
    setContentError(t("contentSearchError"))
  } finally {
    setContentSearching(false)
  }
}, [contentSettings, folderPath, query, t])
```

5. Add result select handler:

```ts
/** Open a content-search match in the file preview and reveal its parent. */
const handleSelectContentMatch = useCallback(
  (match: SearchFileMatch) => {
    const lastSlash = match.path.lastIndexOf("/")
    if (lastSlash > 0) revealInFileTree(match.path.slice(0, lastSlash))
    openFilePreview(match.path, { searchQuery: query.trim() })
    onOpenChange(false)
  },
  [openFilePreview, onOpenChange, query, revealInFileTree]
)
```

- [ ] **Step 4: Render content tab and settings UI**

In the tabs area, add a third button with label `t("tabContent")` and active underline logic matching the existing tab buttons.

For content tab, render:

```tsx
{activeTab === "content" && (
  <div className="flex items-center gap-2 border-b px-3 py-2">
    <Button
      size="sm"
      onClick={runContentSearch}
      disabled={contentSearching || !query.trim() || !folderPath}
    >
      {contentSearching ? t("searching") : t("searchContent")}
    </Button>
    <Button
      size="sm"
      variant="outline"
      onClick={() => setSettingsOpen((value) => !value)}
    >
      {settingsOpen ? t("hideContentSettings") : t("showContentSettings")}
    </Button>
  </div>
)}
```

Set placeholder:

```ts
const placeholder =
  activeTab === "conversations"
    ? t("placeholder")
    : activeTab === "files"
      ? t("filePlaceholder")
      : t("contentPlaceholder")
```

Add `onKeyDown` to `CommandInput` if the component supports it. If it does not forward keyboard props, wrap a keydown handler at the dialog content level and only call `runContentSearch` when `activeTab === "content" && e.key === "Enter"`.

Render settings inputs when `activeTab === "content" && settingsOpen`. Use existing `Input` and compact `label` text. Each field updates `contentSettings` by spreading the previous object.

- [ ] **Step 5: Render content results**

Inside `CommandList`, add a content section:

```tsx
{activeTab === "content" && (
  <>
    <CommandEmpty>
      {contentSearching
        ? t("searching")
        : !query.trim()
          ? t("typeToSearchContent")
          : contentError ?? t("noResults")}
    </CommandEmpty>
    {contentTruncated && (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {t("contentResultsTruncated")}
      </div>
    )}
    {contentResults.length > 0 && (
      <CommandGroup>
        {contentResults.map((match) => (
          <CommandItem
            key={`${match.path}:${match.lineNumber}:${match.lineText}`}
            value={`${match.path}:${match.lineNumber}`}
            onSelect={() => handleSelectContentMatch(match)}
          >
            <File className="w-4 h-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate">{match.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {match.path}
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {match.lineNumber}: {match.lineText}
              </div>
            </div>
          </CommandItem>
        ))}
      </CommandGroup>
    )}
  </>
)}
```

Ensure existing conversation and file sections are still guarded by their tabs.

- [ ] **Step 6: Reset content state on close without losing settings**

Update the existing close reset effect so it clears `contentResults`, `contentError`, and `contentTruncated`, but does not reset `contentSettings`.

- [ ] **Step 7: Add i18n keys for content search**

For every `i18n/messages/*.json`, add keys under `Folder.search`:

```json
{
  "tabContent": "Content",
  "contentPlaceholder": "Search file contents",
  "searchContent": "Search content",
  "showContentSettings": "Search settings",
  "hideContentSettings": "Hide settings",
  "typeToSearchContent": "Type a query, then press Enter or Search content",
  "contentSearchError": "Failed to search file contents",
  "contentResultsTruncated": "Showing the first configured results only",
  "searchDirs": "Search directories",
  "includeExtensions": "Search file types",
  "excludeDirs": "Exclude directories",
  "excludeExtensions": "Exclude file types",
  "maxResults": "Max results",
  "maxFileBytesMb": "Max file size (MB)"
}
```

- [ ] **Step 8: Run search dialog test and verify GREEN**

Run:

```bash
pnpm test src/components/conversations/search-command-dialog.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Run focused checks and commit**

Run:

```bash
pnpm test src/components/conversations/search-command-dialog.test.tsx src/lib/content-search-settings.test.ts
pnpm eslint src/components/conversations/search-command-dialog.tsx src/components/conversations/search-command-dialog.test.tsx src/lib/content-search-settings.ts
```

Expected: all pass.

Commit:

```bash
git add src/components/conversations/search-command-dialog.tsx \
  src/components/conversations/search-command-dialog.test.tsx \
  i18n/messages/*.json
git commit -m "feat(search): 添加搜索面板内容标签页"
```

---

## Task 5: File preview find handoff

**Files:**
- Modify: `src/contexts/workspace-context.tsx`
- Modify: `src/contexts/workspace-context.test.tsx`
- Modify: `src/components/files/file-workspace-panel.tsx`

- [ ] **Step 1: Write failing workspace-context test for storing search query**

In `src/contexts/workspace-context.test.tsx`, add a test near the existing `openFilePreview cache semantics` tests:

```tsx
it("stores a pending search query when opening a file preview", async () => {
  mockedApi.readFileForEdit.mockResolvedValueOnce({
    path: "a.ts",
    content: "needle here",
    readonly: false,
    mtimeMs: 1,
    etag: "etag-a",
    lineEnding: "lf",
  })
  mockedApi.gitIsTracked.mockResolvedValue(false)

  function Probe() {
    const { openFilePreview, activeFileTab } = useWorkspaceContext()
    return (
      <div>
        <output data-testid="pending-search">
          {activeFileTab?.pendingSearchQuery ?? "none"}
        </output>
        <button
          onClick={() => void openFilePreview("a.ts", { searchQuery: "needle" })}
        >
          open-search
        </button>
      </div>
    )
  }

  renderWithWorkspace(<Probe />)

  await act(async () => {
    screen.getByText("open-search").click()
  })

  expect(screen.getByTestId("pending-search")).toHaveTextContent("needle")
})
```

If helper names differ in the test file, adapt only to existing helpers; keep the assertion unchanged.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm test src/contexts/workspace-context.test.tsx -t "stores a pending search query"
```

Expected: FAIL because `pendingSearchQuery` and `searchQuery` option do not exist.

- [ ] **Step 3: Extend workspace context types and tab creation**

In `src/contexts/workspace-context.tsx`:

1. Add to `FileWorkspaceTab`:

```ts
pendingSearchQuery?: string | null
```

2. Change `openFilePreview` option type to:

```ts
options?: { line?: number; reload?: boolean; searchQuery?: string }
```

3. Wherever a file tab is created or updated in `openFilePreview`, set:

```ts
pendingSearchQuery: options?.searchQuery?.trim() || null,
```

4. When activating an already open tab from `openFilePreview`, update that existing tab with the new `pendingSearchQuery` instead of ignoring it.

Add comments where logic is non-obvious. Do not let modified functions exceed 30 non-comment lines; extract a helper if needed.

- [ ] **Step 4: Run workspace test and verify GREEN**

Run:

```bash
pnpm test src/contexts/workspace-context.test.tsx -t "stores a pending search query"
```

Expected: PASS.

- [ ] **Step 5: Write failing test or targeted harness for file panel find action**

If `FileWorkspacePanel` already has no test harness for Monaco, add a small exported helper instead of directly testing Monaco internals. In `src/components/files/file-workspace-panel.tsx`, plan to export:

```ts
export function runEditorFindAction(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  query: string
): void
```

First write a test file `src/components/files/file-workspace-panel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { runEditorFindAction } from "./file-workspace-panel"

describe("runEditorFindAction", () => {
  it("opens Monaco find action for a non-empty query", () => {
    const run = vi.fn()
    const editor = {
      focus: vi.fn(),
      getAction: vi.fn(() => ({ run })),
    }

    runEditorFindAction(editor as never, "needle")

    expect(editor.focus).toHaveBeenCalled()
    expect(editor.getAction).toHaveBeenCalledWith("actions.find")
    expect(run).toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run test and verify RED**

Run:

```bash
pnpm test src/components/files/file-workspace-panel.test.ts
```

Expected: FAIL because `runEditorFindAction` is not exported.

- [ ] **Step 7: Implement file panel find handoff**

In `src/components/files/file-workspace-panel.tsx`, add:

```ts
/**
 * Open Monaco's built-in find widget for a content-search handoff. Monaco does
 * not expose a stable typed API for setting the find input across versions, so
 * this helper treats opening the widget as best-effort and never blocks file
 * opening when the action is unavailable.
 */
export function runEditorFindAction(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  query: string
): void {
  if (!query.trim()) return
  editor.focus()
  void editor.getAction("actions.find")?.run()
}
```

Add an effect in `FileWorkspacePanel`:

```tsx
useEffect(() => {
  if (!activeFileTab?.pendingSearchQuery) return
  if (!editorRef.current) return
  runEditorFindAction(editorRef.current, activeFileTab.pendingSearchQuery)
}, [activeFileTab?.id, activeFileTab?.pendingSearchQuery, editorMountVersion])
```

Do not mark the query consumed unless implementation adds a dedicated context method; repeated opening of the same tab should be avoided by dependency array and mount version.

- [ ] **Step 8: Run file panel test and verify GREEN**

Run:

```bash
pnpm test src/components/files/file-workspace-panel.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run focused checks and commit**

Run:

```bash
pnpm test src/contexts/workspace-context.test.tsx -t "stores a pending search query"
pnpm test src/components/files/file-workspace-panel.test.ts
pnpm eslint src/contexts/workspace-context.tsx src/components/files/file-workspace-panel.tsx
```

Expected: all pass.

Commit:

```bash
git add src/contexts/workspace-context.tsx \
  src/contexts/workspace-context.test.tsx \
  src/components/files/file-workspace-panel.tsx \
  src/components/files/file-workspace-panel.test.ts
git commit -m "feat(files): 支持从内容搜索打开文件查找"
```

---

## Task 6: Full verification and Codex review loop

**Files:**
- Modify: any file needed to address verification failures or Codex feedback.

- [ ] **Step 1: Run full frontend checks**

Run:

```bash
pnpm eslint .
pnpm test
```

Expected: both pass. If either fails, fix using TDD: write or adjust a failing test for the behavior, watch it fail for the expected reason, implement the minimal fix, and rerun.

- [ ] **Step 2: Run full Rust checks**

Run:

```bash
cd src-tauri && cargo test --features test-utils
cd src-tauri && cargo check
cd src-tauri && cargo check --no-default-features --bin codeg-server
```

Expected: all pass. If a check is too slow or environment-blocked, capture the exact output and reason.

- [ ] **Step 3: Dispatch Codex review through Codeg MCP**

Use the Codeg MCP `delegate_to_agent` tool, not an ordinary subagent. The prompt must include the user request, changed range, and verification output.

Tool payload:

```json
{
  "agent_type": "codex",
  "working_dir": "/home/codeg/workspace/codeg",
  "task": "Review these completed changes as Codex.\n\nQuality bar: production-ready. Do not approve while in-scope correctness, security, reliability, data, API, UX, performance, test, or maintainability issues remain.\n\nUser request:\nImplement docs/superpowers/specs/2026-05-29-folder-browser-content-search-design.md. Keep native desktop folder picker unchanged; enhance only the in-app directory browser; add a current-active-folder Content search tab with configurable filters, manual Enter/button triggering, default lock exclusion, bounded backend search, and best-effort file-preview find handoff. Commit after each completed goal.\n\nChanges to review:\nUse git diff BASE_SHA..HEAD_SHA where BASE_SHA is the spec commit 18f9c7d and HEAD_SHA is current HEAD.\n\nVerification already run:\n<paste exact commands and pass/fail outputs from Task 6 steps 1-2>.\n\nReturn:\n- Verdict: APPROVED or CHANGES_REQUESTED\n- Critical / Important / Minor issues\n- Required verification"
}
```

- [ ] **Step 4: Process Codex feedback with receiving-code-review**

Before fixing review feedback, invoke `receiving-code-review`. For every Codex issue:

- Verify the claim against code or tests.
- Fix valid in-scope issues with TDD.
- Push back only with concrete evidence for invalid or out-of-scope issues.
- Run relevant checks again.
- Commit valid fixes with a Conventional Commit Chinese message.

- [ ] **Step 5: Re-review until approved**

After fixes, call Codeg MCP `delegate_to_agent` again with:

```markdown
Re-review the latest state after fixes against the same production-ready quality bar. Do not approve unless the current version is ready to ship.

Previous feedback:
<paste prior feedback>

Fixes made:
<paste commits or diff summary>

Verification after fixes:
<paste commands and outputs>
```

Repeat Task 6 steps 4-5 until Codex returns `Verdict: APPROVED` with no unresolved valid in-scope issues.

- [ ] **Step 6: Final status**

Only after Codex approves and relevant checks pass, report:

- Commits created.
- Checks run and results.
- Codex approval status.
- Any limitations, especially whether Monaco find query filling degraded to only opening the find widget.

---

## Self-review notes

- Spec coverage: directory creation, current-folder-only content search, three tabs, manual trigger, configurable defaults, lock exclusion, bounded backend scan, binary skip, result truncation, file open handoff, tests, commits, and Codex review loop are each mapped to tasks above.
- Placeholder scan: no implementation step relies on “TBD” or “add appropriate handling”; where helper bodies are named in Task 2, exact behavior requirements are listed and signatures are fixed.
- Type consistency: frontend uses `SearchFilesRequest`, `SearchFilesResponse`, and `SearchFileMatch`; backend serde uses camelCase so transport payload keys match TypeScript.
