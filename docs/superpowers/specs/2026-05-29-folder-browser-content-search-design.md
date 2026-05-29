# 文件夹浏览器增强与内容搜索设计

## 背景

当前工具栏的“打开文件夹”入口在本地桌面环境优先使用系统目录选择器，在 Web、Server 或远端工作区环境使用应用内置目录浏览器。系统目录选择器只能选择已有目录，应用内置目录浏览器也只能浏览和选择目录，不能在选择过程中创建子目录。

当前搜索面板只支持两类搜索：

- 会话搜索：只搜索当前激活文件夹下的会话。
- 文件搜索：只搜索当前激活文件夹下的文件名和文件夹名。

本设计新增两个能力：

1. 在应用内置目录浏览器中支持右键选择当前目录和新建子文件夹。
2. 在搜索面板中新增“内容”tab，支持对当前激活文件夹执行可配置的文件内容搜索。

## 目标

- 保持本地桌面系统目录选择器不变。
- 仅在应用内置目录浏览器中增加新建目录能力。
- 内容搜索范围与现有会话/文件搜索保持一致，只针对当前激活文件夹。
- 内容搜索必须由 Enter 或按钮手动触发，不随输入自动执行。
- 内容搜索支持在搜索面板内配置排除目录、排除文件类型、搜索目录、搜索文件类型、最大结果数和单文件最大读取大小。
- UI 遵循当前项目现有整体风格，不套用额外全局 UI 偏好。

## 非目标

- 不替换本地桌面系统目录选择器。
- 不做跨所有已打开文件夹的全局内容搜索。
- 不做流式搜索结果推送。
- 不做索引系统。
- 不做替换功能。
- 不做正则搜索、大小写开关或全词匹配。
- 不强制跳转到文件内指定行。

## 现有行为与入口

### 打开文件夹

- `src/components/layout/new-folder-dropdown.tsx` 中的打开文件夹入口：本地桌面且没有远端连接时走系统目录选择器，否则走 `DirectoryBrowserDialog`。
- `src/components/layout/folder-title-bar.tsx` 中的快捷键入口使用同样分流逻辑。
- `src/components/shared/directory-browser-dialog.tsx` 是应用内置目录浏览器。

### 搜索面板

- `src/components/conversations/search-command-dialog.tsx` 管理搜索弹窗。
- 当前会话搜索通过 `activeFolderId` 限定到当前激活文件夹。
- 当前文件搜索通过 `folder.path` 加载当前激活文件夹的文件树并按文件名/路径过滤。

## 功能一：应用内置目录浏览器增强

### 交互设计

应用内置目录浏览器中的目录项支持右键菜单：

```text
选择此文件夹
新建子文件夹
```

选择“选择此文件夹”时，行为等价于当前选中目录后点击确认。

选择“新建子文件夹”时：

1. 在当前弹窗内显示名称输入 UI。
2. 用户输入新目录名。
3. 前端校验名称不能为空，且不能包含 `/` 或 `\`。
4. 前端基于右键目录拼接完整路径。
5. 调用后端创建目录命令。
6. 成功后刷新该目录的子项，并选中新目录或保持当前目录选中。
7. 失败时在目录浏览器内展示错误。

### API

前端新增：

```ts
createDirectory(path: string): Promise<void>
```

后端新增 Tauri 命令和 Web handler：

```rust
create_directory(path: String) -> Result<(), AppCommandError>
```

### 错误处理

- 目录名为空：前端拦截。
- 目录名包含路径分隔符：前端拦截。
- 目标目录已存在：后端返回错误，前端展示。
- 父目录不存在：后端返回错误，前端展示。
- 权限不足：后端返回错误，前端展示。
- 创建成功但刷新失败：展示刷新失败提示，不回滚已创建目录。

## 功能二：搜索面板新增“内容”tab

### Tab 结构

搜索面板从两个 tab 调整为三个 tab：

```text
会话 | 文件 | 内容
```

- 会话 tab：保持现状，继续搜索当前激活文件夹下的会话。
- 文件 tab：保持现状，继续即时搜索当前激活文件夹下的文件名和文件夹名。
- 内容 tab：新增文件内容搜索，不影响前两个 tab 的即时搜索逻辑。

### 内容 tab 交互

内容 tab 包含：

```text
[搜索内容输入框] [搜索按钮]
[搜索设置 / 收起设置]
[结果列表]
```

行为：

- 输入变化不会自动触发搜索。
- 按 Enter 触发搜索。
- 点击“搜索”按钮触发搜索。
- query 为空时不调用后端，显示提示。
- 搜索中禁用按钮，避免重复触发。
- 搜索失败时显示错误，并保留用户配置。
- 达到最大结果数时显示截断提示。

### 内容搜索配置

配置只影响内容 tab，保存在 `localStorage`，不进入数据库，也不放入全局设置页。

字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 搜索目录 | `.` | 逗号分隔。相对当前激活文件夹，默认搜索整个文件夹。 |
| 搜索文件类型 | 空 | 逗号分隔。空表示全部；支持 `ts` 和 `.ts` 两种写法。 |
| 排除目录 | `.git,node_modules,dist,build,.next,.turbo,target,coverage,__pycache__,.venv,venv` | 逗号分隔。目录名或相对路径均可。 |
| 排除文件类型 | `png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,7z,rar,exe,dll,so,dylib,bin,lock` | 逗号分隔。默认排除 lock 类型。 |
| 最大结果数 | `100` | 可设置，后端进行范围限制。 |
| 单文件最大读取 | `2 MB` | 可设置，后端进行范围限制。 |

配置输入采用逗号分隔文本输入，减少 UI 和状态复杂度。

### 搜索结果展示

每个命中行展示为一条结果：

```text
[file icon] filename                    relative/path
          128: const value = "matched text"
```

结果字段：

- 文件名。
- 相对路径。
- 命中行号。
- 命中行片段。

点击结果时：

1. 打开对应文件预览。
2. 定位文件树父目录。
3. 尝试把内容搜索 query 带入文件预览的查找框。
4. 如果 Monaco 查找框 API 不稳定，则优雅降级为只打开文件，不阻断点击结果。

## 内容搜索 API

前端新增：

```ts
searchFiles(request: SearchFilesRequest): Promise<SearchFilesResponse>
```

请求结构：

```ts
interface SearchFilesRequest {
  rootPath: string
  query: string
  searchDirs: string[]
  includeExtensions: string[]
  excludeDirs: string[]
  excludeExtensions: string[]
  maxResults: number
  maxFileBytes: number
}
```

响应结构：

```ts
interface SearchFilesResponse {
  results: SearchFileMatch[]
  truncated: boolean
  scannedFiles: number
  skippedFiles: number
}

interface SearchFileMatch {
  path: string
  name: string
  lineNumber: number
  lineText: string
}
```

## 后端搜索规则

后端负责完整搜索逻辑，前端不逐个读取文件内容。

规则：

- `query.trim()` 为空时直接返回空结果。
- 只在 `rootPath` 内搜索。
- `searchDirs` 默认为 `.`。
- `searchDirs` 中的路径必须解析后仍位于 `rootPath` 内，防止 `../` 逃逸。
- 遇到排除目录时跳过整棵子树。
- 遇到排除文件类型时跳过文件。
- 设置了搜索文件类型时，只搜索匹配扩展名的文件。
- 超过 `maxFileBytes` 的文件跳过。
- 明显二进制文件跳过。
- 匹配方式为普通大小写不敏感包含匹配。
- 达到 `maxResults` 后停止继续扫描，并返回 `truncated: true`。

建议后端限制：

- `maxResults` 限制到 `1..=1000`。
- `maxFileBytes` 限制到 `64 KB..=10 MB`。

## 文件预览查找框联动

为支持点击内容搜索结果后自动打开文件内查找，扩展文件打开接口：

```ts
openFilePreview(path, { searchQuery?: string })
```

设计原则：

- `searchQuery` 是增强体验，不影响文件打开成功与否。
- 文件 tab 加载完成且 Monaco editor mount 后，尝试打开 Monaco find widget 并填入 `searchQuery`。
- 如果无法可靠填入，则只打开文件并记录降级，不向用户展示阻断错误。

## 主要改动文件

预计涉及：

- `src/components/shared/directory-browser-dialog.tsx`
- `src/components/conversations/search-command-dialog.tsx`
- `src/components/files/file-workspace-panel.tsx`
- `src/contexts/workspace-context.tsx`
- `src/lib/api.ts`
- `src/lib/tauri.ts`
- `src/lib/types.ts`
- `src-tauri/src/commands/folders.rs`
- `src-tauri/src/web/handlers/folders.rs`
- `src-tauri/src/web/router.rs`
- `src-tauri/src/lib.rs`
- `i18n/messages/*.json`

## 测试计划

### 前端

- 搜索面板显示三个 tab：会话、文件、内容。
- 会话 tab 保持当前行为。
- 文件 tab 保持当前文件名/文件夹名搜索行为。
- 内容 tab 输入时不自动搜索。
- 内容 tab 按 Enter 或点击按钮才调用搜索接口。
- query 为空不调用搜索接口。
- 内容搜索配置能从 `localStorage` 读写。
- 点击内容搜索结果会打开文件并定位文件树父目录。
- 传入 `searchQuery` 时，文件预览尝试打开查找框。

### 后端

- `create_directory` 可以创建新目录。
- `create_directory` 对已存在目标返回错误。
- `create_directory` 对不存在父目录返回错误。
- `search_files` 对空 query 返回空结果。
- `search_files` 默认排除目录生效。
- `search_files` 排除扩展名生效。
- `search_files` include 扩展名生效。
- `search_files` 达到 `maxResults` 时截断。
- `search_files` 跳过超大文件。
- `search_files` 跳过明显二进制文件。
- `search_files` 不允许搜索目录逃出 `rootPath`。

### 验证命令

```bash
pnpm eslint .
pnpm test
cd src-tauri && cargo test --features test-utils
```

## 实施顺序建议

1. 增加后端 `create_directory` 命令与前端 API。
2. 增强 `DirectoryBrowserDialog` 右键菜单和新建目录交互。
3. 增加后端 `search_files` 命令与测试。
4. 增加前端 searchFiles API 类型与 transport 调用。
5. 将 `SearchCommandDialog` 调整为三 tab，并实现内容 tab。
6. 增加内容搜索配置的 `localStorage` 读写。
7. 增加文件预览查找框联动增强。
8. 补齐 i18n 文案。
9. 运行前后端验证。
