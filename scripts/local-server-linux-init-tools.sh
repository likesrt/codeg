#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Codeg Server 工具链交互式安装脚本
# 功能：在 /opt/codeg/tools/ 下安装开发工具链
# 用法：codeg-init-tools 或 codeg init
# ============================================================

# ===== 版本号（可按需修改）=====
CODEG_PYTHON_VERSION=3.12.8
CODEG_NODE_VERSION=24.6.0
CODEG_PNPM_VERSION=10.18.0
CODEG_YARN_VERSION=1.22.22
CODEG_NVM_VERSION=v0.40.3
CODEG_GO_VERSION=1.25.12
CODEG_BUN_VERSION=1.3.14
CODEG_UV_VERSION=0.7.12
CODEG_JAVA_VERSION=17.0.13-tem
CODEG_PHP_VERSION=8.5.8
CODEG_COMPOSER_VERSION=2.8.5
CODEG_PLAYWRIGHT_VERSION=1.52.0

# ===== 路径常量 =====
TOOLS_ROOT=/opt/codeg/tools
ENV_FILE=/opt/codeg/.env
PROFILE_D_FILE=/etc/profile.d/codeg-tools.sh
READY_FILE="$TOOLS_ROOT/.toolchains.ready"

# ===== 运行时变量 =====
MIRROR="official"
SELECTED_TOOLS=""
INSTALLED_TOOLS=""

# ===== 辅助函数 =====

# 打印信息日志
# 参数：$1 - 日志内容
# 返回：无
log_info() {
  echo -e "\033[32m[INFO]\033[0m $1"
}

# 打印警告日志
# 参数：$1 - 警告内容
# 返回：无
log_warn() {
  echo -e "\033[33m[WARN]\033[0m $1"
}

# 打印错误日志并退出
# 参数：$1 - 错误内容
# 返回：无
log_error() {
  echo -e "\033[31m[ERROR]\033[0m $1" >&2
  exit 1
}

# 检测当前是否以 root 运行，非 root 则退出
# 参数：无
# 返回：无
check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "必须以 root 用户运行此脚本"
    exit 1
  fi
}

# 检测系统架构并输出工具链需要的架构标识
# 参数：无
# 返回：echo 输出 amd64 或 arm64
detect_arch() {
  case "$(uname -m)" in
    x86_64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      log_error "不支持的架构：$(uname -m)"
      exit 1
      ;;
  esac
}

# 统一下载函数，强制 HTTP/1.1 避免代理 HTTP/2 协议错误
# 参数：透传给 curl 的所有参数
# 返回：curl 的退出码
dl() {
  curl --http1.1 "$@"
}

# 询问全局镜像源偏好，设置 MIRROR 变量
# 参数：无
# 返回：无。副作用：设置 MIRROR 为 cn 或 official
ask_mirror_preference() {
  echo ""
  echo "请选择镜像源偏好："
  echo "  1) 国内镜像（推荐，下载速度快）"
  echo "  2) 官方源"
  read -r -p "请选择 [1-2]（默认 1）: " choice
  case "${choice:-1}" in
    2) MIRROR="official" ;;
    *) MIRROR="cn" ;;
  esac
  log_info "镜像源：$MIRROR"
}

# 询问要安装哪些工具，设置 SELECTED_TOOLS 变量
# 参数：无
# 返回：无。副作用：设置 SELECTED_TOOLS 为工具标识空格分隔列表
ask_tool_selection() {
  echo ""
  echo "请选择要安装的工具链（多选，空格分隔）："
  echo "  1) Python $CODEG_PYTHON_VERSION（uv 管理，无需编译）"
  echo "  2) nvm + Node.js $CODEG_NODE_VERSION（含 pnpm/yarn）"
  echo "  3) Rust stable + cargo-xwin"
  echo "  4) Bun $CODEG_BUN_VERSION"
  echo "  5) Go $CODEG_GO_VERSION"
  echo "  6) uv $CODEG_UV_VERSION"
  echo "  7) Java OpenJDK 17（apt 安装）"
  echo "  8) PHP $CODEG_PHP_VERSION（含 composer）"
  echo "  9) 浏览器自动化（playwright + camoufox）"
  echo "  a) 全部安装（不含浏览器）"
  echo "  b) 全部安装（含浏览器）"
  echo "  0) 取消"
  read -r -p "请选择: " choices

  case "$choices" in
    0) log_info "已取消"; exit 0 ;;
    a) SELECTED_TOOLS="uv python node bun rust go java php" ;;
    b) SELECTED_TOOLS="uv python node bun rust go java php browsers" ;;
    *)
      SELECTED_TOOLS=""
      for c in $choices; do
        case "$c" in
          1) SELECTED_TOOLS="$SELECTED_TOOLS python" ;;
          2) SELECTED_TOOLS="$SELECTED_TOOLS node" ;;
          3) SELECTED_TOOLS="$SELECTED_TOOLS rust" ;;
          4) SELECTED_TOOLS="$SELECTED_TOOLS bun" ;;
          5) SELECTED_TOOLS="$SELECTED_TOOLS go" ;;
          6) SELECTED_TOOLS="$SELECTED_TOOLS uv" ;;
          7) SELECTED_TOOLS="$SELECTED_TOOLS java" ;;
          8) SELECTED_TOOLS="$SELECTED_TOOLS php" ;;
          9) SELECTED_TOOLS="$SELECTED_TOOLS browsers" ;;
          *) log_warn "忽略无效选择：$c" ;;
        esac
      done
      ;;
  esac

  if [ -z "$SELECTED_TOOLS" ]; then
    log_warn "未选择任何工具，退出"
    exit 0
  fi
  log_info "已选择：$SELECTED_TOOLS"
}

# ===== 安装函数 =====

# GitHub 代理列表（空字符串表示直连，按优先级排列）
GITHUB_PROXIES=(
  "https://cdn.gh-proxy.org/"
  "https://gh-proxy.com/"
  "https://mirror.ghproxy.com/"
  ""
)

# 尝试从 GitHub 下载文件，自动尝试多个代理直到成功
# 参数：$1 - GitHub 完整 URL，$2 - 输出文件路径
# 返回：成功返回 0，所有代理都失败返回 1
github_download() {
  local url="$1"
  local output="$2"

  for proxy in "${GITHUB_PROXIES[@]}"; do
    local full_url="${proxy}${url}"
    if dl -fsSL --connect-timeout 10 --max-time 120 "$full_url" -o "$output" 2>/dev/null; then
      log_info "下载成功"
      return 0
    fi
    log_warn "下载失败，尝试下一个源 ..."
  done
  return 1
}

# 安装 uv（Python 包管理器）到 $TOOLS_ROOT/uv
# 参数：无
# 返回：无。副作用：安装 uv/uvx 并追加到 INSTALLED_TOOLS
install_uv() {
  if [ -x "$TOOLS_ROOT/uv/bin/uv" ]; then
    log_info "uv 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS uv"
    return
  fi
  log_info "安装 uv $CODEG_UV_VERSION ..."
  local uv_root="$TOOLS_ROOT/uv"
  mkdir -p "$uv_root/bin" "$uv_root/cache"

  local arch uv_arch
  arch=$(detect_arch)
  uv_arch="x86_64"
  [ "$arch" = "arm64" ] && uv_arch="aarch64"

  local github_url="https://github.com/astral-sh/uv/releases/download/$CODEG_UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz"
  local tmp_file
  tmp_file=$(mktemp)

  # 尝试多个代理下载
  if ! github_download "$github_url" "$tmp_file"; then
    rm -f "$tmp_file"
    log_warn "uv 下载失败，所有代理均不可用"
    return 1
  fi

  tar xzf "$tmp_file" -C "$uv_root"
  cp "$uv_root"/uv-$uv_arch-unknown-linux-gnu/* "$uv_root/bin/" 2>/dev/null || true
  rm -f "$tmp_file"

  "$uv_root/bin/uv" --version >/dev/null
  INSTALLED_TOOLS="$INSTALLED_TOOLS uv"
  log_info "uv 安装完成"
}

# 刷新 Python 的脚本软链接（playwright、camoufox 等）
refresh_python_symlinks() {
  local python_root="$TOOLS_ROOT/python"
  local python_path
  python_path=$(ls -d "$python_root"/cpython-*/install/bin/python3 2>/dev/null | head -1)
  [ -z "$python_path" ] && return 0

  local python_dir
  python_dir=$(dirname "$(dirname "$python_path")")
  local scripts_dir="$(dirname "$python_dir")/bin"

  mkdir -p "$python_root/bin"
  ln -sf "$python_path" "$python_root/bin/python" 2>/dev/null || true
  ln -sf "$python_path" "$python_root/bin/python3" 2>/dev/null || true
  ln -sf "$python_dir/bin/pip" "$python_root/bin/pip" 2>/dev/null || true
  ln -sf "$python_dir/bin/pip3" "$python_root/bin/pip3" 2>/dev/null || true

  if [ -d "$scripts_dir" ]; then
    for s in "$scripts_dir"/*; do
      [ -f "$s" ] && ln -sf "$s" "$python_root/bin/$(basename "$s")" 2>/dev/null || true
    done
  fi
}

# 用 uv 安装预编译 Python（无需编译）
# 参数：无
# 返回：无
install_pyenv_python() {
  if [ -x "$TOOLS_ROOT/python/bin/python" ]; then
    log_info "Python 已安装，跳过"
    refresh_python_symlinks
    INSTALLED_TOOLS="$INSTALLED_TOOLS python"
    return
  fi
  log_info "安装 Python $CODEG_PYTHON_VERSION（uv 预编译）..."

  # 确保 uv 可用，不可用时自动安装
  local uv_bin="$TOOLS_ROOT/uv/bin/uv"
  if [ ! -x "$uv_bin" ]; then
    log_info "uv 未安装，先安装 uv ..."
    install_uv
    uv_bin="$TOOLS_ROOT/uv/bin/uv"
  fi

  local python_root="$TOOLS_ROOT/python"
  mkdir -p "$python_root"

  # 用 uv 下载并安装预编译 Python
  UV_PYTHON_INSTALL_DIR="$python_root" "$uv_bin" python install "$CODEG_PYTHON_VERSION"

  # 查找安装后的 Python 路径（uv 的目录结构含架构信息）
  local python_path python_dir
  python_path=$(UV_PYTHON_INSTALL_DIR="$python_root" "$uv_bin" python find "$CODEG_PYTHON_VERSION" 2>/dev/null || true)
  if [ -z "$python_path" ] || [ ! -x "$python_path" ]; then
    python_dir=$(ls -d "$python_root"/cpython-"$CODEG_PYTHON_VERSION"-linux-*gnu/install 2>/dev/null | head -1)
    [ -z "$python_dir" ] && { log_warn "未找到 Python 安装目录"; return 1; }
    python_path="$python_dir/bin/python3"
  fi
  python_dir=$(dirname "$(dirname "$python_path")")

  refresh_python_symlinks

  # 安装基础包（国内镜像加速 pip）
  if [ "$MIRROR" = "cn" ]; then
    "$python_root/bin/pip" config set global.index-url https://mirrors.aliyun.com/pypi/simple/ 2>/dev/null || true
  fi
  "$python_root/bin/pip" install --upgrade pip setuptools wheel 2>/dev/null || true

  INSTALLED_TOOLS="$INSTALLED_TOOLS python"
  log_info "Python 安装完成"
}

# 安装 nvm 和指定版本 Node.js，附带 pnpm 和 yarn
# 参数：无
# 返回：无。副作用：安�� nvm 到 $TOOLS_ROOT/nvm
install_nvm_node() {
  if [ -x "$TOOLS_ROOT/nvm/current/bin/node" ] && [ -s "$TOOLS_ROOT/nvm/nvm.sh" ]; then
    log_info "nvm + Node.js 已安装，跳过"
    # 仍需 source nvm，后续工具（Bun）依赖 npm
    export NVM_DIR="$TOOLS_ROOT/nvm"
    . "$TOOLS_ROOT/nvm/nvm.sh"
    INSTALLED_TOOLS="$INSTALLED_TOOLS node"
    return
  fi
  log_info "安装 nvm + Node.js $CODEG_NODE_VERSION ..."
  local nvm_dir="$TOOLS_ROOT/nvm"

  # 清理旧安装残留
  if [ -d /root/.nvm ]; then
    rm -rf /root/.nvm
  fi

  # 必须先 export NVM_DIR，install.sh 才能识别
  export NVM_DIR="$nvm_dir"
  mkdir -p "$nvm_dir"

  # 国内让 nvm 从 npmmirror 下载 Node
  [ "$MIRROR" = "cn" ] && export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"

  # 安装 nvm 本身
  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    local nvm_github_url="https://raw.githubusercontent.com/nvm-sh/nvm/$CODEG_NVM_VERSION/install.sh"
    local tmp_nvm
    tmp_nvm=$(mktemp)

    if [ "$MIRROR" = "cn" ]; then
      # 国内用 github_download 多代理下载 install.sh
      github_download "$nvm_github_url" "$tmp_nvm" || {
        rm -f "$tmp_nvm"
        log_warn "nvm 下载失败，所有代理均不可用"; return 1
      }
    else
      # 官方源直接下载
      dl -fsSL "$nvm_github_url" -o "$tmp_nvm"
    fi

    PROFILE=/dev/null bash "$tmp_nvm"
    rm -f "$tmp_nvm"
  fi

  . "$nvm_dir/nvm.sh"
  nvm install "$CODEG_NODE_VERSION"
  nvm alias default "$CODEG_NODE_VERSION"
  nvm use --silent default

  # 创建 current 软链接指向当前 Node 版本目录
  ln -sfn "$NVM_DIR/versions/node/$(nvm current)" "$nvm_dir/current"

  # npm 包管理器
  if [ "$MIRROR" = "cn" ]; then
    npm config set registry https://registry.npmmirror.com
  fi
  npm install -g "pnpm@$CODEG_PNPM_VERSION" "yarn@$CODEG_YARN_VERSION"
  corepack enable || true

  INSTALLED_TOOLS="$INSTALLED_TOOLS node"
  log_info "nvm + Node.js 安装完成"
}

# 安装 Bun JS 运行时到 $TOOLS_ROOT/bun
# 参数：无
# 返回：无。副作用：安装 Bun 并追加到 INSTALLED_TOOLS
install_bun() {
  if [ -x "$TOOLS_ROOT/bun/bin/bun" ]; then
    log_info "Bun 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS bun"
    return
  fi
  log_info "安装 Bun $CODEG_BUN_VERSION ..."
  local bun_root="$TOOLS_ROOT/bun"
  mkdir -p "$bun_root/bin"

  if [ "$MIRROR" = "cn" ]; then
    # 国内用 npm 安装（npmmirror，Node 已安装）
    npm install -g "bun@$CODEG_BUN_VERSION"
    ln -sf "$NVM_DIR/current/bin/bun" "$bun_root/bin/bun"
  else
    # 官方源从 GitHub 下载二进制
    local bun_arch
    case "$(uname -m)" in
      x86_64) bun_arch="x64" ;;
      aarch64|arm64) bun_arch="aarch64" ;;
      *) log_error "不支持的 Bun 架构：$(uname -m)" ;;
    esac
    local github_url="https://github.com/oven-sh/bun/releases/download/bun-v$CODEG_BUN_VERSION/bun-linux-$bun_arch.zip"
    if ! github_download "$github_url" /tmp/bun.zip; then
      log_warn "Bun 下载失败，所有代理均不可用"; return 1
    fi
    unzip -o /tmp/bun.zip -d /tmp/bun-extract
    cp "/tmp/bun-extract/bun-linux-$bun_arch/bun" "$bun_root/bin/"
    chmod +x "$bun_root/bin/bun"
    rm -rf /tmp/bun.zip /tmp/bun-extract
  fi

  "$bun_root/bin/bun" --version >/dev/null
  INSTALLED_TOOLS="$INSTALLED_TOOLS bun"
  log_info "Bun 安装完成"
}

# 安装 Rust stable 和 cargo-xwin
# 参数：无
# 返回：无。副作用：安装 rustup/cargo 到 $TOOLS_ROOT/cargo 和 $TOOLS_ROOT/rustup
install_rust() {
  if [ -x "$TOOLS_ROOT/cargo/bin/rustc" ]; then
    log_info "Rust 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS rust"
    return
  fi
  log_info "安装 Rust stable + cargo-xwin ..."
  local cargo_home="$TOOLS_ROOT/cargo"
  local rustup_home="$TOOLS_ROOT/rustup"

  export CARGO_HOME="$cargo_home"
  export RUSTUP_HOME="$rustup_home"

  if [ "$MIRROR" = "cn" ]; then
    # 国内镜像通过 rsproxy 加速
    export RUSTUP_DIST_SERVER="https://rsproxy.cn"
    export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
  dl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y --profile default
  else
    dl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
  fi

  . "$cargo_home/env"
  rustup default stable

  # 安装 Windows 交叉编译工具
  rustup target add x86_64-pc-windows-msvc
  if ! command -v cargo-xwin >/dev/null 2>&1; then
    cargo install --locked cargo-xwin
  fi

  INSTALLED_TOOLS="$INSTALLED_TOOLS rust"
  log_info "Rust 安装完成"
}

# 安装 Go 到 $TOOLS_ROOT/go
# 参数：无
# 返回：无。副作用：下载并解压 Go tarball，设置 GOROOT/GOPATH
install_go() {
  if [ -x "$TOOLS_ROOT/go/bin/go" ]; then
    log_info "Go 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS go"
    return
  fi
  log_info "安装 Go $CODEG_GO_VERSION ..."
  local go_root="$TOOLS_ROOT/go"
  local go_arch
  go_arch=$(detect_arch)

  local base_url="https://go.dev/dl"
  [ "$MIRROR" = "cn" ] && base_url="https://golang.google.cn/dl"

  local archive="go$CODEG_GO_VERSION.linux-$go_arch.tar.gz"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  dl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"

  rm -rf "$go_root"
  mkdir -p "$TOOLS_ROOT" "$TOOLS_ROOT/gopath/bin"
  tar -C "$TOOLS_ROOT" -xzf "$tmp_dir/$archive"
  rm -rf "$tmp_dir"

  "$go_root/bin/go" version >/dev/null

  # 国内镜像设置 GOPROXY
  if [ "$MIRROR" = "cn" ]; then
    "$go_root/bin/go" env -w GOPROXY=https://goproxy.cn,direct
  fi

  INSTALLED_TOOLS="$INSTALLED_TOOLS go"
  log_info "Go 安装完成"
}

# 安装 Java OpenJDK 17 到 $TOOLS_ROOT/java
# 参数：无
# 返回：成功返回 0，失败返回 1
install_java() {
  if [ -x "$TOOLS_ROOT/java/bin/java" ]; then
    log_info "Java 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS java"
    return 0
  fi
  log_info "安装 Java OpenJDK 17 ..."

  # 方式 1：尝试直接 apt 安装 temurin-17-jdk
  if apt-cache show temurin-17-jdk >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends temurin-17-jdk && { setup_java_links; return 0; }
  fi

  # 方式 2：添加 Adoptium 仓库
  local gpg_key="/usr/share/keyrings/adoptium.gpg"
  if [ ! -f "$gpg_key" ]; then
    if dl -fsSL "https://packages.adoptium.net/artifactory/api/gpg/key/public" 2>/dev/null \
      | gpg --dearmor --yes -o "$gpg_key" 2>/dev/null; then
      # GPG 密钥下载成功，添加仓库
      printf 'Types: deb\nURIs: https://packages.adoptium.net/artifactory/deb\nSuites: %s\nComponents: main\nArchitectures: %s\nSigned-By: %s\n' \
        "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
        "$(dpkg --print-architecture)" \
        "$gpg_key" \
        > /etc/apt/sources.list.d/adoptium.sources
      apt-get update -qq
      apt-get install -y --no-install-recommends temurin-17-jdk && { setup_java_links; return 0; }
    fi
  fi

  # 方式 3：从 GitHub 下载 .tar.gz（多代理）
  log_info "从 GitHub 下载 JDK 17 ..."
  local java_arch
  case "$(uname -m)" in
    x86_64) java_arch="x64" ;;
    aarch64|arm64) java_arch="aarch64" ;;
    *) log_warn "不支持的架构"; return 1 ;;
  esac
  local jdk_file="OpenJDK17U-jdk_${java_arch}_linux_hotspot_17.0.13_8.tar.gz"
  local jdk_url="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13+8/$jdk_file"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  if github_download "$jdk_url" "$tmp_dir/$jdk_file"; then
    rm -rf "$TOOLS_ROOT/java"
    mkdir -p "$TOOLS_ROOT/java"
    tar -C "$TOOLS_ROOT/java" --strip-components=1 -xzf "$tmp_dir/$jdk_file"
    rm -rf "$tmp_dir"
    setup_java_links
    return 0
  fi
  rm -rf "$tmp_dir"

  # 方式 4：兜底 default-jdk（可能是 JDK 21）
  log_warn "JDK 17 下载失败，回退到系统默认 JDK"
  apt-get install -y --no-install-recommends default-jdk && { setup_java_links; return 0; }
  log_warn "Java 安装失败"
  return 1
}

# 设置 Java 软链接到统一路径
# 参数：无
# 返回：无
setup_java_links() {
  local java_home
  java_home=$(dirname "$(dirname "$(readlink -f "$(which java 2>/dev/null)")")" 2>/dev/null || true)
  if [ -z "$java_home" ] || [ ! -d "$java_home" ]; then
    java_home=$(ls -d /usr/lib/jvm/java-*-openjdk-* /usr/lib/jvm/temurin-17-* /usr/lib/jvm/default-java 2>/dev/null | head -1 || true)
    [ -z "$java_home" ] && { log_warn "未找到 Java 安装路径"; return 1; }
  fi
  mkdir -p "$TOOLS_ROOT/java/bin"
  ln -sf "$java_home/bin/java" "$TOOLS_ROOT/java/bin/java"
  ln -sf "$java_home/bin/javac" "$TOOLS_ROOT/java/bin/javac"

  "$TOOLS_ROOT/java/bin/java" -version 2>&1 | head -1
  INSTALLED_TOOLS="$INSTALLED_TOOLS java"
  log_info "Java 安装完成"
}

# 用 apt 安装 PHP 和常用扩展
# 参数：无
# 返回：成功返回 0，失败返回 1
install_php() {
  if [ -x "$TOOLS_ROOT/php/bin/php" ]; then
    log_info "PHP 已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS php"
    return
  fi
  log_info "安装 PHP（apt）..."

  # 直接用 apt 安装 PHP 及常用扩展，不再从源码编译
  # Debian 13 默认版本较低但可靠，如需 8.5 请手动编译
  apt-get install -y --no-install-recommends \
    php-cli php-curl php-mbstring php-xml php-zip php-sqlite3 php-mysql \
    php-gd php-intl php-soap php-bcmath php-opcache php-sockets \
    2>/dev/null || {
    log_warn "PHP apt 安装失败"
    return 1
  }

  # 链接到统一路径
  mkdir -p "$TOOLS_ROOT/php/bin"
  ln -sf "$(which php)" "$TOOLS_ROOT/php/bin/php"

  # 安装 composer
  local composer_url="https://getcomposer.org/download/$CODEG_COMPOSER_VERSION/composer.phar"
  dl -fsSL "$composer_url" -o "$TOOLS_ROOT/php/bin/composer" 2>/dev/null || true
  chmod +x "$TOOLS_ROOT/php/bin/composer" 2>/dev/null || true
  INSTALLED_TOOLS="$INSTALLED_TOOLS php"
  log_info "PHP 安装完成"
}

# 安装浏览器自动化工具（playwright chromium + camoufox）
# 依赖：需要先安装 Python
# 参数：无
# 返回：无。副作用：通过 pip 装 playwright/camoufox，通过 playwright CLI 装 chromium
install_browsers() {
  if "$TOOLS_ROOT/python/bin/python" -c "import playwright; import camoufox" 2>/dev/null; then
    log_info "浏览器自动化已安装，跳过"
    INSTALLED_TOOLS="$INSTALLED_TOOLS browsers"
    return
  fi
  log_info "安装浏览器自动化工具 ..."

  local python_bin="$TOOLS_ROOT/python/bin/python"
  if [ ! -x "$python_bin" ]; then
    log_warn "浏览器自动化需要先安装 Python（选项 1）"; return 1
  fi

  local browsers_dir="$TOOLS_ROOT/browsers"
  mkdir -p "$browsers_dir"

  # 设置统一浏览器缓存路径，Python 和 Node.js 的 Playwright 共享
  export PLAYWRIGHT_BROWSERS_PATH="$browsers_dir"
  export BROWSER_BIN="$browsers_dir"

  # uv pip 安装，加 --break-system-packages 绕过 uv 管理的 Python 限制
  "$python_bin" -m pip install --break-system-packages "playwright==$CODEG_PLAYWRIGHT_VERSION" camoufox
  "$python_bin" -m playwright install chromium
  "$python_bin" -m camoufox fetch --browser-dir "$browsers_dir"

  # 写入 PLAYWRIGHT_BROWSERS_PATH 到 .env 常量区（供后续 rebuild_env_paths 使用）
  BROWSER_PATH_SET=1

  INSTALLED_TOOLS="$INSTALLED_TOOLS browsers"
  log_info "浏览器自动化工具安装完成"
}

# ===== 环境变量更新函数 =====

# 检查某个工具是否已安装
# 参数：$1 - 工具标识
# 返回：已安装返回 0，未安装返回 1
has_tool() {
  echo "$INSTALLED_TOOLS" | grep -qw "$1"
}

# 获取已安装工具对应的 bin 目录列表，用于构建 PATH
# 参数：无
# 返回：echo 输出 PATH 增量部分（不含系统 PATH）
build_tool_path() {
  local paths=""
  has_tool uv && paths="$paths$TOOLS_ROOT/uv/bin:"
  has_tool python && paths="$paths$TOOLS_ROOT/python/bin:"
  has_tool node && paths="$paths$TOOLS_ROOT/nvm/current/bin:"
  has_tool bun && paths="$paths$TOOLS_ROOT/bun/bin:"
  has_tool rust && paths="$paths$TOOLS_ROOT/cargo/bin:"
  has_tool go && paths="$paths$TOOLS_ROOT/go/bin:$TOOLS_ROOT/gopath/bin:"
  has_tool java && paths="$paths$TOOLS_ROOT/java/bin:"
  has_tool php && paths="$paths$TOOLS_ROOT/php/bin:"
  echo "$paths"
}

# 重建 /opt/codeg/.env 中的工具链环境变量段
# 参数：无
# 返回：无。副作用：更新 ENV_FILE 的 PATH 和工具环境变量
rebuild_env_paths() {
  log_info "更新 $ENV_FILE ..."

  local tool_path
  tool_path=$(build_tool_path)
  local full_path="${tool_path}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  # 构建工具链环境变量段
  local tool_env=""
  tool_env="${tool_env}PATH=${full_path}"$'\n'
  has_tool uv && tool_env="${tool_env}UV_INSTALL_DIR=$TOOLS_ROOT/uv/bin"$'\n'"UV_CACHE_DIR=$TOOLS_ROOT/uv/cache"$'\n'
  has_tool python && tool_env="${tool_env}PYTHON_ROOT=$TOOLS_ROOT/python"$'\n'
  has_tool node && tool_env="${tool_env}NVM_DIR=$TOOLS_ROOT/nvm"$'\n'"NVM_SYMLINK_CURRENT=true"$'\n'
  has_tool bun && tool_env="${tool_env}BUN_INSTALL=$TOOLS_ROOT/bun"$'\n'
  has_tool rust && tool_env="${tool_env}CARGO_HOME=$TOOLS_ROOT/cargo"$'\n'"RUSTUP_HOME=$TOOLS_ROOT/rustup"$'\n'
  has_tool go && tool_env="${tool_env}GOROOT=$TOOLS_ROOT/go"$'\n'"GOPATH=$TOOLS_ROOT/gopath"$'\n'
  has_tool java && tool_env="${tool_env}JAVA_HOME=$TOOLS_ROOT/java"$'\n'
  has_tool php && tool_env="${tool_env}PHP_HOME=$TOOLS_ROOT/php"$'\n'
  has_tool browsers && tool_env="${tool_env}PLAYWRIGHT_BROWSERS_PATH=$TOOLS_ROOT/browsers"$'\n'

  # 如果 .env 不存在，创建空文件
  touch "$ENV_FILE"

  # 删除旧的工具链段（标记之间），追加新内容
  local before_marker
  if grep -q "# ===== 工具链环境变量" "$ENV_FILE"; then
    before_marker=$(sed '/# ===== 工具链环境变量/,$d' "$ENV_FILE" || true)
  else
    before_marker=$(cat "$ENV_FILE")
    [ -n "$before_marker" ] && before_marker="${before_marker}"$'\n'
  fi

  # 重建 .env：原有变量 + 工具链段
  printf '%s\n' "$before_marker" > "$ENV_FILE"
  echo "# ===== 工具链环境变量（由 codeg-init-tools 自动管理，请勿手动编辑）=====" >> "$ENV_FILE"
  printf '%s' "$tool_env" >> "$ENV_FILE"
  echo "# ===== 工具链环境变量结束 =====" >> "$ENV_FILE"
}

# 写 /etc/profile.d/codeg-tools.sh，让登录 shell 也能使用工具链
# 参数：无
# 返回：无。副作用：创建或覆盖 PROFILE_D_FILE
update_profile_d() {
  log_info "更新 $PROFILE_D_FILE ..."

  local tool_path
  tool_path=$(build_tool_path)
  local full_path="${tool_path}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  # 写入 PATH 和各工具环境变量
  {
    echo "# 由 codeg-init-tools 自动生成，请勿手动编辑"
    echo "export PATH=\"$full_path\""
    has_tool uv && echo "export UV_INSTALL_DIR=\"$TOOLS_ROOT/uv/bin\"" && echo "export UV_CACHE_DIR=\"$TOOLS_ROOT/uv/cache\""
    has_tool python && echo "export PYTHON_ROOT=\"$TOOLS_ROOT/python\""
    has_tool node && echo "export NVM_DIR=\"$TOOLS_ROOT/nvm\"" && echo "export NVM_SYMLINK_CURRENT=true"
    has_tool bun && echo "export BUN_INSTALL=\"$TOOLS_ROOT/bun\""
    has_tool rust && echo "export CARGO_HOME=\"$TOOLS_ROOT/cargo\"" && echo "export RUSTUP_HOME=\"$TOOLS_ROOT/rustup\""
    has_tool go && echo "export GOROOT=\"$TOOLS_ROOT/go\"" && echo "export GOPATH=\"$TOOLS_ROOT/gopath\""
    has_tool java && echo "export JAVA_HOME=\"$TOOLS_ROOT/java\""
    has_tool php && echo "export PHP_HOME=\"$TOOLS_ROOT/php\""
    has_tool browsers && echo "export PLAYWRIGHT_BROWSERS_PATH=\"$TOOLS_ROOT/browsers\""
  } > "$PROFILE_D_FILE"

  chmod +x "$PROFILE_D_FILE"
}

# 写工具链就绪标记文件，记录已安装工具和版本
# 参数：无
# 返回：无。副作用：创建 READY_FILE
write_ready_file() {
  cat > "$READY_FILE" << 'REEOF'
installed=INSTALLED_TOOLS_PLACEHOLDER
REEOF
  sed -i "s/INSTALLED_TOOLS_PLACEHOLDER/$INSTALLED_TOOLS/" "$READY_FILE"
  {
    echo "python=$CODEG_PYTHON_VERSION"
    echo "node=$CODEG_NODE_VERSION"
    echo "pnpm=$CODEG_PNPM_VERSION"
    echo "yarn=$CODEG_YARN_VERSION"
    echo "nvm=$CODEG_NVM_VERSION"
    echo "go=$CODEG_GO_VERSION"
    echo "bun=$CODEG_BUN_VERSION"
    echo "uv=$CODEG_UV_VERSION"
    echo "java=$CODEG_JAVA_VERSION"
    echo "php=$CODEG_PHP_VERSION"
    echo "composer=$CODEG_COMPOSER_VERSION"
    echo "playwright=$CODEG_PLAYWRIGHT_VERSION"
    echo "mirror=$MIRROR"
    echo "updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >> "$READY_FILE"
  log_info "工具链就绪标记写入 $READY_FILE"
}

# ===== 主函数 =====

# 脚本主入口：检测环境 -> 询问用户 -> 安装工具 -> 更新环境变量
# 参数：$@ - 透传参数（当前未使用）
# 返回：无
main() {
  check_root
  ask_mirror_preference
  ask_tool_selection

  mkdir -p "$TOOLS_ROOT"

  # 按选择安装工具（失败跳过，不影响后续工具）
  for tool in $SELECTED_TOOLS; do
    case "$tool" in
      uv) install_uv || log_warn "uv 安装失败，跳过" ;;
      python) install_pyenv_python || log_warn "Python 安装失败，跳过" ;;
      node) install_nvm_node || log_warn "nvm 安装失败，跳过" ;;
      bun) install_bun || log_warn "Bun 安装失败，跳过" ;;
      rust) install_rust || log_warn "Rust 安装失败，跳过" ;;
      go) install_go || log_warn "Go 安装失败，跳过" ;;
      java) install_java || log_warn "Java 安装失败，跳过" ;;
      php) install_php || log_warn "PHP 安装失败，跳过" ;;
      browsers) install_browsers || log_warn "浏览器安装失败，跳过" ;;
    esac
  done

  # 更新环境变量配置
  rebuild_env_paths
  update_profile_d
  write_ready_file

  echo ""
  log_info "工具链安装完成！"
  echo "  已安装：$INSTALLED_TOOLS"
  echo ""
  echo "  ──────────────────────────────────────"
  echo "  立即让当前 shell 使用工具链："
  echo "    source /etc/profile.d/codeg-tools.sh"
  echo ""
  echo "  让 codeg-server 继承新 PATH："
  echo "    codeg restart"
  echo ""
  echo "  验证安装："
  echo "    python --version"
  echo "    node --version"
  echo "    npm --version"
  echo "    go version"
  echo "    cargo --version"
  echo "    java -version"
  echo "    php -v"
  echo "  ──────────────────────────────────────"
}

main "$@"
