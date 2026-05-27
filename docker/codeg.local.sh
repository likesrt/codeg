#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codeg init tool

初始化本地 Docker 容器中的开发工具链到 /home/codeg。
如果 /home/codeg 由宿主机的 ./home/codeg 目录挂载，安装结果会持久保存在宿主机卷中。
EOF
}

# 只允许通过 `codeg init tool` 入口执行，避免误把该脚本当成通用 shell 启动器。
if [ "${1:-}" != "init" ] || [ "${2:-}" != "tool" ] || [ "${3:-}" != "" ]; then
  usage >&2
  exit 64
fi

# 统一所有工具链的安装根目录，确保 root 分支和 codeg 用户分支使用相同路径。
export HOME=/home/codeg
export USER=codeg
export PYENV_ROOT=${PYENV_ROOT:-$HOME/.pyenv}
export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
export NVM_SYMLINK_CURRENT=${NVM_SYMLINK_CURRENT:-true}
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
export BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}
export GOROOT=${GOROOT:-$HOME/.go}
export GOPATH=${GOPATH:-$HOME/go}
export UV_INSTALL_DIR=${UV_INSTALL_DIR:-$HOME/.local/bin}
export UV_CACHE_DIR=${UV_CACHE_DIR:-$HOME/.cache/uv}
export PIP_CACHE_DIR=${PIP_CACHE_DIR:-$HOME/.cache/pip}
export CODEG_PYTHON_VERSION=${CODEG_PYTHON_VERSION:-3.12.8}
export CODEG_NODE_VERSION=${CODEG_NODE_VERSION:-24}
export CODEG_NVM_VERSION=${CODEG_NVM_VERSION:-v0.40.3}
export CODEG_GO_VERSION=${CODEG_GO_VERSION:-1.25.4}
export PATH="$UV_INSTALL_DIR:$PYENV_ROOT/bin:$PYENV_ROOT/shims:$NVM_DIR/current/bin:$BUN_INSTALL/bin:$CARGO_HOME/bin:$GOROOT/bin:$GOPATH/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# 容器默认可能以 root 启动；先修正挂载目录归属，再降权到 codeg 用户继续安装。
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$HOME" /workspace /data
  chown -R codeg:codeg "$HOME" /workspace /data 2>/dev/null || true
  exec gosu codeg env \
    HOME="$HOME" \
    USER="$USER" \
    PYENV_ROOT="$PYENV_ROOT" \
    NVM_DIR="$NVM_DIR" \
    NVM_SYMLINK_CURRENT="$NVM_SYMLINK_CURRENT" \
    CARGO_HOME="$CARGO_HOME" \
    RUSTUP_HOME="$RUSTUP_HOME" \
    BUN_INSTALL="$BUN_INSTALL" \
    GOROOT="$GOROOT" \
    GOPATH="$GOPATH" \
    UV_INSTALL_DIR="$UV_INSTALL_DIR" \
    UV_CACHE_DIR="$UV_CACHE_DIR" \
    PIP_CACHE_DIR="$PIP_CACHE_DIR" \
    CODEG_PYTHON_VERSION="$CODEG_PYTHON_VERSION" \
    CODEG_NODE_VERSION="$CODEG_NODE_VERSION" \
    CODEG_NVM_VERSION="$CODEG_NVM_VERSION" \
    CODEG_GO_VERSION="$CODEG_GO_VERSION" \
    PATH="$PATH" \
    "$0" "$@"
fi

# 预创建所有会被安装器或缓存写入的目录，避免安装器用不同默认值生成零散路径。
mkdir -p "$HOME" "$HOME/.cache" "$HOME/.config" "$HOME/.local/bin" "$HOME/.codeg"

home_has_toolchain_state() {
  # 只检查由本脚本管理的工具链目录和 ready 标记，用于决定提示语，不会删除用户文件。
  [ -e "$PYENV_ROOT" ] || \
    [ -e "$NVM_DIR" ] || \
    [ -e "$CARGO_HOME" ] || \
    [ -e "$RUSTUP_HOME" ] || \
    [ -e "$BUN_INSTALL" ] || \
    [ -e "$GOROOT" ] || \
    [ -d "$GOPATH" ] || \
    [ -x "$UV_INSTALL_DIR/uv" ] || \
    [ -x "$UV_INSTALL_DIR/uvx" ] || \
    [ -f "$HOME/.codeg/toolchains.ready" ]
}

home_has_user_content() {
  # 忽略本脚本会自动创建的缓存、配置和运行时文件，只把真实用户内容视为非空 HOME。
  shopt -s nullglob dotglob
  local path base
  for path in "$HOME"/*; do
    base=$(basename "$path")
    case "$base" in
      .|..|.cache|.config|.local|.codeg|.dbus|.vnc|.Xauthority|.ICEauthority)
        continue
        ;;
    esac
    return 0
  done
  return 1
}

append_if_missing() {
  # 写入 shell 初始化配置时保持幂等，重复执行不会追加重复行。
  local file=$1
  local line=$2
  touch "$file"
  grep -qxF "$line" "$file" || printf '%s\n' "$line" >>"$file"
}

# Ensures Bash login shells load the interactive shell initialization file.
# Arguments: none. Returns success unless writing the profile fails. Side effect: creates or updates ~/.bash_profile.
write_bash_login_profile() {
  append_if_missing "$HOME/.bash_profile" '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"'
}

write_shell_init() {
  # 把本脚本安装的工具链加入交互式 shell，用户重新进入容器后可以直接使用。
  append_if_missing "$HOME/.bashrc" 'export PYENV_ROOT="$HOME/.pyenv"'
  append_if_missing "$HOME/.bashrc" 'export NVM_DIR="$HOME/.nvm"'
  append_if_missing "$HOME/.bashrc" 'export NVM_SYMLINK_CURRENT=true'
  append_if_missing "$HOME/.bashrc" 'export CARGO_HOME="$HOME/.cargo"'
  append_if_missing "$HOME/.bashrc" 'export RUSTUP_HOME="$HOME/.rustup"'
  append_if_missing "$HOME/.bashrc" 'export BUN_INSTALL="$HOME/.bun"'
  append_if_missing "$HOME/.bashrc" 'export GOROOT="$HOME/.go"'
  append_if_missing "$HOME/.bashrc" 'export GOPATH="$HOME/go"'
  append_if_missing "$HOME/.bashrc" 'export UV_INSTALL_DIR="$HOME/.local/bin"'
  append_if_missing "$HOME/.bashrc" 'export UV_CACHE_DIR="$HOME/.cache/uv"'
  append_if_missing "$HOME/.bashrc" 'export PATH="$UV_INSTALL_DIR:$PYENV_ROOT/bin:$PYENV_ROOT/shims:$NVM_DIR/current/bin:$BUN_INSTALL/bin:$CARGO_HOME/bin:$GOROOT/bin:$GOPATH/bin:$PATH"'
  append_if_missing "$HOME/.bashrc" '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
  append_if_missing "$HOME/.bashrc" 'command -v pyenv >/dev/null 2>&1 && eval "$(pyenv init -)"'
  write_bash_login_profile
}

install_uv() {
  # 使用 uv 官方安装器安装独立的 uv/uvx，避免依赖某个 pyenv Python 环境是否已初始化。
  mkdir -p "$UV_INSTALL_DIR" "$UV_CACHE_DIR"
  if [ ! -x "$UV_INSTALL_DIR/uv" ] || [ ! -x "$UV_INSTALL_DIR/uvx" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi

  "$UV_INSTALL_DIR/uv" --version >/dev/null
  "$UV_INSTALL_DIR/uvx" --version >/dev/null
}

install_pyenv_python() {
  # pyenv 负责提供稳定的默认 Python 版本，Python 工具会安装到该版本环境中。
  if [ ! -x "$PYENV_ROOT/bin/pyenv" ]; then
    git clone --depth=1 https://github.com/pyenv/pyenv.git "$PYENV_ROOT"
  fi

  export PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$PATH"
  eval "$(pyenv init -)"
  pyenv install -s "$CODEG_PYTHON_VERSION"
  pyenv global "$CODEG_PYTHON_VERSION"
  python -m pip install --upgrade pip setuptools wheel uv camoufox
  camoufox fetch
}

install_nvm_node() {
  # nvm 安装 Node，并把当前全局 npm 前缀软链接到 $NVM_DIR/current 供非交互式 PATH 使用。
  mkdir -p "$NVM_DIR"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${CODEG_NVM_VERSION}/install.sh" | bash
  fi

  . "$NVM_DIR/nvm.sh"
  nvm install "$CODEG_NODE_VERSION"
  nvm alias default "$CODEG_NODE_VERSION"
  nvm use --silent default
  ln -sfn "$(npm prefix -g)" "$NVM_DIR/current"
  npm install -g corepack pnpm yarn
  corepack enable || true
}

install_bun() {
  # Bun 官方安装器默认写入 $BUN_INSTALL/bin；已有安装时跳过以保持重复执行速度。
  if [ ! -x "$BUN_INSTALL/bin/bun" ]; then
    curl -fsSL https://bun.sh/install | bash
  fi
}

install_rust() {
  # rustup 安装稳定版 Rust，并把 cargo/rustup 状态保存在挂载的 HOME 中。
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
  fi

  . "$CARGO_HOME/env"
  rustup default stable
}

# Installs the requested Go release into the persistent home directory.
# Arguments: none. Returns success after `go version` works. Side effect: replaces $GOROOT when the requested version is missing.
install_go() {
  local machine go_arch archive url tmp_dir
  machine=$(uname -m)
  case "$machine" in
    x86_64) go_arch=amd64 ;;
    aarch64|arm64) go_arch=arm64 ;;
    *)
      echo "Unsupported Go architecture: $machine" >&2
      exit 1
      ;;
  esac

  if [ -x "$GOROOT/bin/go" ] && "$GOROOT/bin/go" version | grep -q "go$CODEG_GO_VERSION "; then
    "$GOROOT/bin/go" version >/dev/null
    return 0
  fi

  archive="go$CODEG_GO_VERSION.linux-$go_arch.tar.gz"
  url="https://go.dev/dl/$archive"
  tmp_dir=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp_dir/$archive"
  rm -rf "$GOROOT"
  mkdir -p "$(dirname "$GOROOT")" "$GOPATH/bin"
  tar -C "$(dirname "$GOROOT")" -xzf "$tmp_dir/$archive"
  mv "$(dirname "$GOROOT")/go" "$GOROOT"
  rm -rf "$tmp_dir"
  "$GOROOT/bin/go" version >/dev/null
}

# 根据 HOME 的现状输出不同提示；安装逻辑始终是幂等补齐缺失工具。
if home_has_toolchain_state; then
  echo "Existing toolchain state found in $HOME; installing any missing pieces."
elif home_has_user_content; then
  echo "Home is not empty; installing toolchains without deleting existing files."
else
  echo "Home is empty; installing local toolchains into $HOME."
fi

write_shell_init
install_uv
install_pyenv_python
install_nvm_node
install_bun
install_rust
install_go

# ready 文件记录最后一次初始化结果，便于用户或后续脚本快速确认工具链版本。
cat >"$HOME/.codeg/toolchains.ready" <<EOF
python=$CODEG_PYTHON_VERSION
node=$CODEG_NODE_VERSION
nvm=$CODEG_NVM_VERSION
go=$(go version 2>/dev/null || true)
uv=$("$UV_INSTALL_DIR/uv" --version 2>/dev/null || true)
uvx=$("$UV_INSTALL_DIR/uvx" --version 2>/dev/null || true)
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

printf '\nToolchains are ready in %s. Open a new shell or run: source ~/.bashrc\n' "$HOME"
