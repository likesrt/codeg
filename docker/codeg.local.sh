#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codeg init tool

Install the local container toolchains into /home/codeg. When /home/codeg is
bind-mounted from ./home/codeg, the installed files stay on the host volume.
EOF
}

if [ "${1:-}" != "init" ] || [ "${2:-}" != "tool" ] || [ "${3:-}" != "" ]; then
  usage >&2
  exit 64
fi

export HOME=/home/codeg
export USER=codeg
export PYENV_ROOT=${PYENV_ROOT:-$HOME/.pyenv}
export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
export NVM_SYMLINK_CURRENT=${NVM_SYMLINK_CURRENT:-true}
export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
export BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}
export UV_CACHE_DIR=${UV_CACHE_DIR:-$HOME/.cache/uv}
export PIP_CACHE_DIR=${PIP_CACHE_DIR:-$HOME/.cache/pip}
export CODEG_PYTHON_VERSION=${CODEG_PYTHON_VERSION:-3.12.8}
export CODEG_NODE_VERSION=${CODEG_NODE_VERSION:-24}
export CODEG_NVM_VERSION=${CODEG_NVM_VERSION:-v0.40.3}
export PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$NVM_DIR/current/bin:$BUN_INSTALL/bin:$CARGO_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

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
    UV_CACHE_DIR="$UV_CACHE_DIR" \
    PIP_CACHE_DIR="$PIP_CACHE_DIR" \
    CODEG_PYTHON_VERSION="$CODEG_PYTHON_VERSION" \
    CODEG_NODE_VERSION="$CODEG_NODE_VERSION" \
    CODEG_NVM_VERSION="$CODEG_NVM_VERSION" \
    PATH="$PATH" \
    "$0" "$@"
fi

mkdir -p "$HOME" "$HOME/.cache" "$HOME/.config" "$HOME/.local/bin" "$HOME/.codeg"

home_has_toolchain_state() {
  [ -e "$PYENV_ROOT" ] || [ -e "$NVM_DIR" ] || [ -e "$CARGO_HOME" ] || [ -e "$RUSTUP_HOME" ] || [ -e "$BUN_INSTALL" ] || [ -f "$HOME/.codeg/toolchains.ready" ]
}

home_has_user_content() {
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
  local file=$1
  local line=$2
  touch "$file"
  grep -qxF "$line" "$file" || printf '%s\n' "$line" >>"$file"
}

write_shell_init() {
  append_if_missing "$HOME/.bashrc" 'export PYENV_ROOT="$HOME/.pyenv"'
  append_if_missing "$HOME/.bashrc" 'export NVM_DIR="$HOME/.nvm"'
  append_if_missing "$HOME/.bashrc" 'export NVM_SYMLINK_CURRENT=true'
  append_if_missing "$HOME/.bashrc" 'export CARGO_HOME="$HOME/.cargo"'
  append_if_missing "$HOME/.bashrc" 'export RUSTUP_HOME="$HOME/.rustup"'
  append_if_missing "$HOME/.bashrc" 'export BUN_INSTALL="$HOME/.bun"'
  append_if_missing "$HOME/.bashrc" 'export PATH="$PYENV_ROOT/bin:$PYENV_ROOT/shims:$NVM_DIR/current/bin:$BUN_INSTALL/bin:$CARGO_HOME/bin:$PATH"'
  append_if_missing "$HOME/.bashrc" '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
  append_if_missing "$HOME/.bashrc" 'command -v pyenv >/dev/null 2>&1 && eval "$(pyenv init -)"'
}

install_pyenv_python() {
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
  mkdir -p "$NVM_DIR"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${CODEG_NVM_VERSION}/install.sh" | bash
  fi

  . "$NVM_DIR/nvm.sh"
  nvm install "$CODEG_NODE_VERSION"
  nvm alias default "$CODEG_NODE_VERSION"
  nvm use --silent default
  ln -sfn "$(npm prefix -g)" "$NVM_DIR/current"
  npm install -g corepack pnpm yarn @anthropic-ai/claude-code @openai/codex opencode-ai
  corepack enable || true
}

install_bun() {
  if [ ! -x "$BUN_INSTALL/bin/bun" ]; then
    curl -fsSL https://bun.sh/install | bash
  fi
}

install_rust() {
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
  fi

  . "$CARGO_HOME/env"
  rustup default stable
}

if home_has_toolchain_state; then
  echo "Existing toolchain state found in $HOME; installing any missing pieces."
elif home_has_user_content; then
  echo "Home is not empty; installing toolchains without deleting existing files."
else
  echo "Home is empty; installing local toolchains into $HOME."
fi

write_shell_init
install_pyenv_python
install_nvm_node
install_bun
install_rust

cat >"$HOME/.codeg/toolchains.ready" <<EOF
python=$CODEG_PYTHON_VERSION
node=$CODEG_NODE_VERSION
nvm=$CODEG_NVM_VERSION
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

printf '\nToolchains are ready in %s. Open a new shell or run: source ~/.bashrc\n' "$HOME"
