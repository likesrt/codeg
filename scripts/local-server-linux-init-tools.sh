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
CODEG_GO_VERSION=1.25.4
CODEG_BUN_VERSION=1.2.21
CODEG_UV_VERSION=0.7.12
CODEG_JAVA_VERSION=17.0.13-tem
CODEG_PHP_VERSION=8.5.0
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
  echo "  1) pyenv + Python $CODEG_PYTHON_VERSION"
  echo "  2) nvm + Node.js $CODEG_NODE_VERSION（含 pnpm/yarn）"
  echo "  3) Rust stable + cargo-xwin"
  echo "  4) Bun $CODEG_BUN_VERSION"
  echo "  5) Go $CODEG_GO_VERSION"
  echo "  6) uv $CODEG_UV_VERSION"
  echo "  7) Java OpenJDK 17.0.13（Temurin）"
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

# 安装 uv（Python 包管理器）到 $TOOLS_ROOT/uv
# 参数：无
# 返回：无。副作用：安装 uv/uvx 并追加到 INSTALLED_TOOLS
install_uv() {
  log_info "安装 uv $CODEG_UV_VERSION ..."
  local uv_root="$TOOLS_ROOT/uv"
  mkdir -p "$uv_root/bin" "$uv_root/cache"

  if [ "$MIRROR" = "cn" ]; then
    # 国内通过 ghproxy 加速 GitHub 下载
    local arch uv_arch
    arch=$(detect_arch)
    uv_arch="x86_64"
    [ "$arch" = "arm64" ] && uv_arch="aarch64"
    curl -LsSf "https://ghproxy.com/https://github.com/astral-sh/uv/releases/download/$CODEG_UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz" \
      | tar xz -C "$uv_root"
    cp "$uv_root"/uv-$uv_arch-unknown-linux-gnu/* "$uv_root/bin/" 2>/dev/null || true
  else
    # 官方安装器，通过 UV_INSTALL_DIR 指定安装路径
    export UV_INSTALL_DIR="$uv_root/bin"
    curl -LsSf "https://astral.sh/uv/install.sh" | sh -s -- -v "$CODEG_UV_VERSION"
  fi

  "$uv_root/bin/uv" --version >/dev/null
  INSTALLED_TOOLS="$INSTALLED_TOOLS uv"
  log_info "uv 安装完成"
}

# 安装 pyenv 和指定版本 Python
# 参数：无
# 返回：无。副作用：克隆 pyenv 到 $TOOLS_ROOT/pyenv，安装 Python 并装 pip/setuptools/wheel
install_pyenv_python() {
  log_info "安装 pyenv + Python $CODEG_PYTHON_VERSION ..."
  local pyenv_root="$TOOLS_ROOT/pyenv"
  local git_url="https://github.com/pyenv/pyenv.git"
  [ "$MIRROR" = "cn" ] && git_url="https://gitee.com/mirrors/pyenv.git"

  if [ ! -x "$pyenv_root/bin/pyenv" ]; then
    git clone --depth=1 "$git_url" "$pyenv_root"
  fi

  export PYENV_ROOT="$pyenv_root"
  export PATH="$pyenv_root/bin:$pyenv_root/shims:$PATH"
  eval "$(pyenv init -)"

  pyenv install -s "$CODEG_PYTHON_VERSION"
  pyenv global "$CODEG_PYTHON_VERSION"
  python -m pip install --upgrade pip setuptools wheel

  INSTALLED_TOOLS="$INSTALLED_TOOLS python"
  log_info "pyenv + Python 安装完成"
}

# 安装 nvm 和指定版本 Node.js，附带 pnpm 和 yarn
# 参数：无
# 返回：无。副作用：安装 nvm 到 $TOOLS_ROOT/nvm，Node 到 nvm 管理目录，创建 current 软链接
install_nvm_node() {
  log_info "安装 nvm + Node.js $CODEG_NODE_VERSION ..."
  local nvm_dir="$TOOLS_ROOT/nvm"
  mkdir -p "$nvm_dir"

  local nvm_url="https://raw.githubusercontent.com/nvm-sh/nvm/$CODEG_NVM_VERSION/install.sh"
  if [ "$MIRROR" = "cn" ]; then
    nvm_url="https://gitee.com/mirrors/nvm/raw/$CODEG_NVM_VERSION/install.sh"
    export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"
  fi

  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    curl -fsSL "$nvm_url" | bash
  fi

  export NVM_DIR="$nvm_dir"
  . "$nvm_dir/nvm.sh"
  nvm install "$CODEG_NODE_VERSION"
  nvm alias default "$CODEG_NODE_VERSION"
  nvm use --silent default

  # 创建 current 软链接，方便非交互式 shell 使用
  ln -sfn "$(npm prefix -g)" "$nvm_dir/current"

  # 安装包管理器
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
  log_info "安装 Bun $CODEG_BUN_VERSION ..."
  local bun_root="$TOOLS_ROOT/bun"

  if [ "$MIRROR" = "cn" ]; then
    # 国内从 GitHub releases 通过 ghproxy 下载二进制
    local arch
    arch=$(detect_arch)
    mkdir -p "$bun_root/bin"
    curl -L "https://ghproxy.com/https://github.com/oven-sh/bun/releases/download/bun-v$CODEG_BUN_VERSION/bun-linux-$arch.zip" -o /tmp/bun.zip
    unzip -o /tmp/bun.zip -d /tmp/bun-extract
    cp "/tmp/bun-extract/bun-linux-$arch/bun" "$bun_root/bin/"
    chmod +x "$bun_root/bin/bun"
    rm -rf /tmp/bun.zip /tmp/bun-extract
  else
    # 官方安装器，通过 BUN_INSTALL 指定安装路径
    export BUN_INSTALL="$bun_root"
    curl -fsSL https://bun.sh/install | sh -s "bun-v$CODEG_BUN_VERSION"
  fi

  "$bun_root/bin/bun" --version >/dev/null
  INSTALLED_TOOLS="$INSTALLED_TOOLS bun"
  log_info "Bun 安装完成"
}

# 安装 Rust stable 和 cargo-xwin
# 参数：无
# 返回：无。副作用：安装 rustup/cargo 到 $TOOLS_ROOT/cargo 和 $TOOLS_ROOT/rustup
install_rust() {
  log_info "安装 Rust stable + cargo-xwin ..."
  local cargo_home="$TOOLS_ROOT/cargo"
  local rustup_home="$TOOLS_ROOT/rustup"

  export CARGO_HOME="$cargo_home"
  export RUSTUP_HOME="$rustup_home"

  if [ "$MIRROR" = "cn" ]; then
    # 国内镜像通过 rsproxy 加速
    export RUSTUP_DIST_SERVER="https://rsproxy.cn"
    export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y --profile default
  else
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
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
  log_info "安装 Go $CODEG_GO_VERSION ..."
  local go_root="$TOOLS_ROOT/go"
  local go_arch
  go_arch=$(detect_arch)

  local base_url="https://go.dev/dl"
  [ "$MIRROR" = "cn" ] && base_url="https://golang.google.cn/dl"

  local archive="go$CODEG_GO_VERSION.linux-$go_arch.tar.gz"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  curl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"

  rm -rf "$go_root"
  mkdir -p "$TOOLS_ROOT" "$TOOLS_ROOT/gopath/bin"
  tar -C "$TOOLS_ROOT" -xzf "$tmp_dir/$archive"
  mv "$TOOLS_ROOT/go" "$go_root"
  rm -rf "$tmp_dir"

  "$go_root/bin/go" version >/dev/null

  # 国内镜像设置 GOPROXY
  if [ "$MIRROR" = "cn" ]; then
    "$go_root/bin/go" env -w GOPROXY=https://goproxy.cn,direct
  fi

  INSTALLED_TOOLS="$INSTALLED_TOOLS go"
  log_info "Go 安装完成"
}

# 安装 Java OpenJDK (Temurin) 到 $TOOLS_ROOT/java
# 参数：无
# 返回：无。副作用：下载并解压 JDK tarball
install_java() {
  log_info "安装 Java OpenJDK 17.0.13 (Temurin) ..."
  local java_root="$TOOLS_ROOT/java"
  local arch java_arch
  arch=$(detect_arch)
  java_arch="x64"
  [ "$arch" = "arm64" ] && java_arch="aarch64"

  # Temurin JDK 17.0.13 的下载文件名
  local filename="OpenJDK17U-jdk_${java_arch}_linux_hotspot_17.0.13_8.tar.gz"

  local url
  if [ "$MIRROR" = "cn" ]; then
    # 清华镜像
    url="https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/${java_arch}/linux/$filename"
  else
    # 官方 GitHub
    url="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B8/$filename"
  fi

  local tmp_dir
  tmp_dir=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp_dir/$filename"
  rm -rf "$java_root"
  mkdir -p "$java_root"
  tar -C "$java_root" --strip-components=1 -xzf "$tmp_dir/$filename"
  rm -rf "$tmp_dir"

  "$java_root/bin/java" -version 2>&1 | head -1
  INSTALLED_TOOLS="$INSTALLED_TOOLS java"
  log_info "Java 安装完成"
}

# 安装 PHP 编译依赖
# 参数：无
# 返回：无。副作用：通过 apt 安装 PHP 编译所需的系统包
install_php_deps() {
  log_info "安装 PHP 编译依赖 ..."
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    libxml2-dev libcurl4-openssl-dev libssl-dev libzip-dev \
    libsqlite3-dev libonig-dev libpng-dev autoconf re2c bison
}

# 编译安装 PHP 和 composer
# 参数：无
# 返回：无。副作用：下载 PHP 源码编译到 $TOOLS_ROOT/php，安装 composer
install_php() {
  log_info "安装 PHP $CODEG_PHP_VERSION（编译需要约 10-20 分钟）..."
  install_php_deps

  local php_root="$TOOLS_ROOT/php"
  local base_url="https://www.php.net/distributions"
  [ "$MIRROR" = "cn" ] && base_url="https://cn2.php.net/distributions"

  local archive="php-$CODEG_PHP_VERSION.tar.gz"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  curl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"
  tar -C "$tmp_dir" -xzf "$tmp_dir/$archive"

  # 编译配置：启用常用扩展
  cd "$tmp_dir/php-$CODEG_PHP_VERSION"
  ./configure \
    --prefix="$php_root" \
    --with-config-file-path="$php_root/etc" \
    --enable-mbstring \
    --with-curl \
    --with-openssl \
    --enable-xml \
    --with-zip \
    --with-sqlite3 \
    --enable-pdo \
    --with-pdo-sqlite \
    --enable-gd \
    --enable-ftp \
    --enable-bcmath \
    --enable-opcache \
    --disable-cgi
  make -j"$(nproc)"
  make install

  # 安装 composer
  local composer_url="https://getcomposer.org/download/$CODEG_COMPOSER_VERSION/composer.phar"
  [ "$MIRROR" = "cn" ] && composer_url="https://mirrors.aliyun.com/composer/$CODEG_COMPOSER_VERSION/composer.phar"
  curl -fsSL "$composer_url" -o "$php_root/bin/composer"
  chmod +x "$php_root/bin/composer"

  cd -
  rm -rf "$tmp_dir"

  "$php_root/bin/php" -v | head -1
  INSTALLED_TOOLS="$INSTALLED_TOOLS php"
  log_info "PHP 安装完成"
}

# 安装浏览器自动化工具（playwright chromium + camoufox）
# 依赖：需要先安装 Python
# 参数：无
# 返回：无。副作用：通过 pip 装 playwright/camoufox，通过 playwright CLI 装 chromium
install_browsers() {
  log_info "安装浏览器自动化工具 ..."

  # 确保 Python 可用
  local pyenv_root="$TOOLS_ROOT/pyenv"
  if [ ! -x "$pyenv_root/bin/pyenv" ]; then
    log_error "浏览器自动化需要先安装 Python（选项 1）"
    return 1
  fi
  export PYENV_ROOT="$pyenv_root"
  export PATH="$pyenv_root/bin:$pyenv_root/shims:$PATH"
  eval "$(pyenv init -)"

  # 安装 playwright 和 camoufox
  pip install "playwright==$CODEG_PLAYWRIGHT_VERSION" camoufox
  python -m playwright install chromium
  camoufox fetch

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
  has_tool python && paths="$paths$TOOLS_ROOT/pyenv/shims:$TOOLS_ROOT/pyenv/bin:"
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
  has_tool python && tool_env="${tool_env}PYENV_ROOT=$TOOLS_ROOT/pyenv"$'\n'
  has_tool node && tool_env="${tool_env}NVM_DIR=$TOOLS_ROOT/nvm"$'\n'"NVM_SYMLINK_CURRENT=true"$'\n'
  has_tool rust && tool_env="${tool_env}CARGO_HOME=$TOOLS_ROOT/cargo"$'\n'"RUSTUP_HOME=$TOOLS_ROOT/rustup"$'\n'
  has_tool go && tool_env="${tool_env}GOROOT=$TOOLS_ROOT/go"$'\n'"GOPATH=$TOOLS_ROOT/gopath"$'\n'
  has_tool java && tool_env="${tool_env}JAVA_HOME=$TOOLS_ROOT/java"$'\n'
  has_tool php && tool_env="${tool_env}PHP_HOME=$TOOLS_ROOT/php"$'\n'

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
    has_tool python && echo "export PYENV_ROOT=\"$TOOLS_ROOT/pyenv\""
    has_tool node && echo "export NVM_DIR=\"$TOOLS_ROOT/nvm\"" && echo "export NVM_SYMLINK_CURRENT=true"
    has_tool rust && echo "export CARGO_HOME=\"$TOOLS_ROOT/cargo\"" && echo "export RUSTUP_HOME=\"$TOOLS_ROOT/rustup\""
    has_tool go && echo "export GOROOT=\"$TOOLS_ROOT/go\"" && echo "export GOPATH=\"$TOOLS_ROOT/gopath\""
    has_tool java && echo "export JAVA_HOME=\"$TOOLS_ROOT/java\""
    has_tool php && echo "export PHP_HOME=\"$TOOLS_ROOT/php\""
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

  # 按选择安装工具
  for tool in $SELECTED_TOOLS; do
    case "$tool" in
      uv) install_uv ;;
      python) install_pyenv_python ;;
      node) install_nvm_node ;;
      bun) install_bun ;;
      rust) install_rust ;;
      go) install_go ;;
      java) install_java ;;
      php) install_php ;;
      browsers) install_browsers ;;
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
  echo "  让 codeg-server 继承新 PATH："
  echo "    codeg restart"
  echo ""
  echo "  登录 shell 使用工具链："
  echo "    source /etc/profile.d/codeg-tools.sh"
  echo "    （或重新登录）"
}

main "$@"
