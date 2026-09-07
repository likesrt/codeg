# 个人项目说明

本文件只记录个人本地工作流，不重复团队级 `../CLAUDE.md` 的项目架构、测试命令和通用规范。

## 交叉编译 Windows x86_64-pc-windows-msvc 安装包

目标产物是 NSIS 安装包：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/codeg_<version>_x64-setup.exe
```

### 依赖分层

本地工作容器里有两类依赖：

1. 系统包，应该预装在 `Dockerfile.local` / `Dockerfile.local.ci` 的 runtime workstation 阶段：
   - `lld`：提供 `lld-link`，给 MSVC target 链接用。
   - `clang`：编译 `ring` 等 C 依赖；本环境没有 `clang-cl` 时可用 `CC_x86_64_pc_windows_msvc=clang`。
   - `nsis`：生成 Windows `*-setup.exe`。
   - `libayatana-appindicator3-dev`：避免 Tauri bundler 在 Linux 宿主机报 `Can't detect any appindicator library`。
   - `librsvg2-dev`：Tauri bundling 常用的图标/资源处理依赖。
   - `patchelf`：Tauri Linux bundling 常用工具，和打包阶段依赖一起预装。
2. Rust 用户工具链，应该由 `codeg init tool` 安装到持久化 `/home/codeg`：
   - `rustup target add x86_64-pc-windows-msvc`
   - `cargo install cargo-xwin`

`gcc-mingw-w64-x86-64` 和 `x86_64-pc-windows-gnu` 只用于 GNU 路线探索；MSVC 安装包路线不依赖它们，默认不必预装。

### 构建步骤

所有命令都从仓库根目录执行。

先构建 Windows MSVC sidecar：

```bash
cd src-tauri
CC_x86_64_pc_windows_msvc=clang \
  cargo xwin build \
  --release \
  --bin codeg-mcp \
  --no-default-features \
  --target x86_64-pc-windows-msvc
cd - >/dev/null
```

把 sidecar 放到 Tauri externalBin 需要的位置：

```bash
mkdir -p src-tauri/binaries
cp src-tauri/target/x86_64-pc-windows-msvc/release/codeg-mcp.exe \
  src-tauri/binaries/codeg-mcp-x86_64-pc-windows-msvc.exe
```

再构建 Windows 安装包：

```bash
CODEG_SKIP_SIDECAR=1 \
  pnpm tauri build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc
```

`CODEG_SKIP_SIDECAR=1` 是必要的：项目的 `tauri:prepare-sidecars` 默认用普通 `cargo` 构建 sidecar，跨编译 MSVC 时需要先手动用 `cargo xwin` 构建。

### 签名说明

如果没有设置 `TAURI_SIGNING_PRIVATE_KEY`，Tauri 可能在安装包已经生成后以 exit code 1 结束，并提示：

```text
A public key has been found, but no private key.
Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

这种情况下先检查安装包文件是否存在；存在则可以用于本地测试，但 updater 签名产物不完整。
