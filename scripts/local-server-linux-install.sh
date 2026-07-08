#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Codeg Server Linux 一键安装/更新脚本
# 功能：从 GitHub Releases 下载 codeg-server 二进制和 web 资源，配置 systemd 服务
# 用法：curl -fsSL https://raw.githubusercontent.com/likesrt/codeg/main/scripts/local-server-linux-install.sh | bash
#       或：bash local-server-linux-install.sh [--force]
# 国内服务器如果无法下载本脚本，可使用代理：
#       curl -fsSL https://cdn.gh-proxy.org/https://raw.githubusercontent.com/likesrt/codeg/main/scripts/local-server-linux-install.sh | bash
# 也可通过环境变量 CODEG_PROXY 指定代理前缀：
#       CODEG_PROXY=https://cdn.gh-proxy.org/ bash local-server-linux-install.sh
# ============================================================

# ===== 常量 =====
REPO="likesrt/codeg"
GITHUB_API="https://api.github.com/repos/$REPO/releases"
GITHUB_BASE="https://github.com/$REPO"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main/scripts"
DEFAULT_PROXY="https://cdn.gh-proxy.org/"
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/opt/codeg/data"
WEB_DIR="/opt/codeg/web"
TOOLS_DIR="/opt/codeg/tools"
ENV_FILE="/opt/codeg/.env"
VERSION_FILE="/opt/codeg/.version"
SERVICE_FILE="/etc/systemd/system/codeg-server.service"

# 代理相关变量（detect_proxy 会设置）
USE_PROXY=0
PROXY_PREFIX=""

# 系统依赖列表
SYSTEM_DEPS=(
  build-essential pkg-config libssl-dev jq ripgrep fd-find
  gh git-lfs unzip zip curl wget htop tmux ca-certificates
)

# ===== 辅助函数 =====

# 打印信息日志
# 参数：$1 - 日志内容
# 返回：无
log_info() {
  echo -e "\033[32m[INFO]\033[0m $1"
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
  fi
}

# 检测系统架构并输出对应的架构标识
# 参数：无
# 返回：echo 输出 amd64 或 arm64
detect_arch() {
  case "$(uname -m)" in
    x86_64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) log_error "不支持的架构：$(uname -m)" ;;
  esac
}

# 检测 GitHub 是否可直连，决定是否使用代理
# 优先级：CODEG_PROXY 环境变量 > 自动检测
# 参数：无
# 返回：无。副作用：设置 USE_PROXY 和 PROXY_PREFIX
detect_proxy() {
  # 用户通过环境变量显式指定代理
  if [ -n "${CODEG_PROXY:-}" ]; then
    if [ "$CODEG_PROXY" = "none" ]; then
      USE_PROXY=0
      log_info "CODEG_PROXY=none，强制不使用代理"
    else
      USE_PROXY=1
      PROXY_PREFIX="$CODEG_PROXY"
      log_info "使用指定代理：$PROXY_PREFIX"
    fi
    return
  fi

  # 自动检测：尝试直连 GitHub API
  log_info "检测 GitHub 连通性 ..."
  if curl -fsSL --connect-timeout 5 --max-time 10 "https://api.github.com/repos/$REPO" >/dev/null 2>&1; then
    USE_PROXY=0
    log_info "GitHub 可直连，不使用代理"
  else
    USE_PROXY=1
    PROXY_PREFIX="$DEFAULT_PROXY"
    log_info "GitHub 无法直连，启用代理：$PROXY_PREFIX"
  fi
}

# 给 URL 加上代理前缀（如果需要代理）
# 参数：$1 - 原始完整 URL
# 返回：echo 输出处理后的 URL
proxy_url() {
  local url="$1"
  if [ "$USE_PROXY" -eq 1 ]; then
    echo "${PROXY_PREFIX}${url}"
  else
    echo "$url"
  fi
}

# ===== 系统依赖安装 =====

# 检测并安装缺失的系统依赖
# 参数：无
# 返回：无。副作用：通过 apt 安装缺失的系统包，fd 创建软链接
install_system_deps() {
  log_info "检查系统依赖 ..."

  local missing=()
  for pkg in "${SYSTEM_DEPS[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    log_info "安装缺失的系统包：${missing[*]}"
    apt-get update -qq
    apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log_info "系统依赖已齐全"
  fi

  # fd-find 在 Ubuntu/Debian 下命令名是 fdfind，创建软链接让智能体能用 fd
  if [ -x /usr/bin/fdfind ] && [ ! -x /usr/local/bin/fd ]; then
    ln -s /usr/bin/fdfind /usr/local/bin/fd
    log_info "已创建 fd -> fdfind 软链接"
  fi
}

# ===== 版本管理 =====

# 读取本地已安装版本
# 参数：无
# 返回：echo 输出版本 tag，未安装时输出空字符串
get_local_version() {
  if [ -f "$VERSION_FILE" ]; then
    cat "$VERSION_FILE"
  else
    echo ""
  fi
}

# 查询远程最新 release tag
# 参数：无
# 返回：echo 输出最新 tag（local-server-linux-YYYYMMDD-HHMM）
get_remote_version() {
  local api_url
  api_url=$(proxy_url "$GITHUB_API")
  curl -fsSL "$api_url" 2>/dev/null \
    | jq -r '[.[] | select(.tag_name | startswith("local-server-linux-"))][0].tag_name // empty'
}

# ===== 下载安装 =====

# 下载指定 release 的 assets 并安装二进制和 web 资源
# 参数：$1 - release tag，$2 - 架构（amd64/arm64）
# 返回：无。副作用：覆盖安装 codeg-server/codeg-mcp 二进制，解压 web 资源
download_and_install() {
  local tag="$1"
  local arch="$2"
  local download_base
  download_base=$(proxy_url "https://github.com/$REPO/releases/download/$tag")

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT

  # 下载二进制
  log_info "下载 codeg-server-linux-$arch ..."
  curl -fsSL "$download_base/codeg-server-linux-$arch" -o "$tmp_dir/codeg-server"
  chmod +x "$tmp_dir/codeg-server"

  log_info "下载 codeg-mcp-linux-$arch ..."
  curl -fsSL "$download_base/codeg-mcp-linux-$arch" -o "$tmp_dir/codeg-mcp"
  chmod +x "$tmp_dir/codeg-mcp"

  # 下载 web 资源
  log_info "下载 codeg-web.tar.gz ..."
  curl -fsSL "$download_base/codeg-web.tar.gz" -o "$tmp_dir/codeg-web.tar.gz"

  # 安装二进制到 /usr/local/bin/
  mkdir -p "$INSTALL_DIR"
  # 如果服务正在运行，先停止
  if systemctl is-active --quiet codeg-server 2>/dev/null; then
    log_info "停止运行中的 codeg-server ..."
    systemctl stop codeg-server || true
  fi

  cp "$tmp_dir/codeg-server" "$INSTALL_DIR/codeg-server"
  cp "$tmp_dir/codeg-mcp" "$INSTALL_DIR/codeg-mcp"

  # 解压 web 资源
  mkdir -p "$WEB_DIR"
  rm -rf "$WEB_DIR"/*
  tar -C "$WEB_DIR" -xzf "$tmp_dir/codeg-web.tar.gz" --strip-components=1

  rm -rf "$tmp_dir"
  log_info "二进制和 web 资源安装完成"
}

# ===== 首次安装配置 =====

# 生成随机 token
# 参数：无
# 返回：echo 输出 64 位 hex token
generate_token() {
  openssl rand -hex 32
}

# 创建 /opt/codeg/.env 配置文件（已存在则跳过，保留用户修改和工具链配置）
# 参数：无
# 返回：echo 输出 token（新建时输出，已存在时从现有 .env 读取）
create_env_file() {
  # 如果 .env 已存在，不覆盖（可能用户已修改或工具链脚本已追加配置）
  if [ -f "$ENV_FILE" ]; then
    log_info "$ENV_FILE 已存在，保留现有配置"
    grep -E '^CODEG_TOKEN=' "$ENV_FILE" | cut -d= -f2
    return
  fi

  local token
  token=$(generate_token)

  cat > "$ENV_FILE" << EOF
# Codeg Server 环境变量
# 编辑后执行 codeg restart 生效

CODEG_STATIC_DIR=$WEB_DIR
CODEG_DATA_DIR=$DATA_DIR
CODEG_PORT=3080
CODEG_HOST=0.0.0.0
CODEG_TOKEN=$token
CODEG_MCP_BIN=$INSTALL_DIR/codeg-mcp
CODEG_RUNTIME=local-server
TZ=Asia/Shanghai
EOF

  # 安全权限：只有 root 可读（含 token）
  chmod 600 "$ENV_FILE"
  echo "$token"
}

# 创建 systemd unit 文件
# 参数：无
# 返回：无。副作用：写入 SERVICE_FILE 并执行 daemon-reload
create_systemd_unit() {
  cat > "$SERVICE_FILE" << 'EOF'
[Unit]
Description=Codeg Server
After=network.target

[Service]
Type=simple
EnvironmentFile=/opt/codeg/.env
ExecStart=/usr/local/bin/codeg-server
Restart=unless-stopped
RestartSec=3
WorkingDirectory=/opt/codeg

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  log_info "systemd unit 已创建"
}

# 下载并安装管理脚本（codeg 和 codeg-init-tools）
# 参数：无
# 返回：无。副作用：下载 ctl 和 init-tools 脚本到 /usr/local/bin/
install_scripts() {
  log_info "安装管理脚本 ..."

  local raw_base
  raw_base=$(proxy_url "$RAW_BASE")

  curl -fsSL "$raw_base/local-server-linux-ctl.sh" -o "$INSTALL_DIR/codeg"
  chmod +x "$INSTALL_DIR/codeg"

  curl -fsSL "$raw_base/local-server-linux-init-tools.sh" -o "$INSTALL_DIR/codeg-init-tools"
  chmod +x "$INSTALL_DIR/codeg-init-tools"

  log_info "管理脚本安装完成"
}

# 执行首次安装的完整流程：创建目录、配置、安装脚本、启动服务
# 参数：$1 - release tag
# 返回：无
first_time_setup() {
  local tag="$1"

  log_info "首次安装，执行初始化配置 ..."

  # 创建目录结构
  mkdir -p "$DATA_DIR" "$WEB_DIR" "$TOOLS_DIR"

  # 创建配置文件
  local token
  token=$(create_env_file)

  # 创建 systemd unit
  create_systemd_unit

  # 安装管理脚本
  install_scripts

  # 启用并启动服务
  systemctl enable codeg-server
  systemctl start codeg-server

  # 记录版本
  echo "$tag" > "$VERSION_FILE"

  # 打印完成提示
  echo ""
  echo "  ════════════════════════════════════════"
  echo "  Codeg Server 安装完成！"
  echo "  ════════════════════════════════════════"
  echo ""
  echo "  访问地址：http://<服务器IP>:3080"
  echo "  Token：$token"
  echo ""
  echo "  管理命令："
  echo "    codeg          # 交互式菜单"
  echo "    codeg status   # 查看状态"
  echo "    codeg config   # 查看配置"
  echo "    codeg init     # 安装工具链"
  echo ""
  echo "  ⚠ 请妥善保管 Token，也可在 $ENV_FILE 中修改"
  echo ""
}

# 执行更新流程：重启服务，更新版本记录
# 参数：$1 - release tag
# 返回：无
do_update() {
  local tag="$1"

  log_info "更新到 $tag ..."

  # 重启服务（download_and_install 已停止旧服务）
  systemctl start codeg-server

  # 更新版本记录
  echo "$tag" > "$VERSION_FILE"

  log_info "已更新到 $tag"
}

# ===== 主函数 =====

# 脚本主入口：检测环境 -> 安装依赖 -> 检查版本 -> 下载安装 -> 配置
# 参数：$@ - 命令行参数（支持 --force 跳过版本检查）
# 返回：无
main() {
  check_root

  # 解析参数
  local force=0
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      *) log_error "未知参数：$arg" ;;
    esac
  done

  # 检测架构
  local arch
  arch=$(detect_arch)
  log_info "检测到架构：$arch"

  # 检测 GitHub 代理需求
  detect_proxy

  # 安装系统依赖
  install_system_deps

  # 获取版本
  local local_version remote_version
  local_version=$(get_local_version)
  remote_version=$(get_remote_version)

  if [ -z "$remote_version" ]; then
    log_error "未找到 local-server-linux release，请先在 GitHub Actions 中触发构建"
  fi

  log_info "本地版本：${local_version:-未安装}"
  log_info "远程版本：$remote_version"

  # 版本比较
  if [ "$force" -eq 0 ] && [ "$local_version" = "$remote_version" ]; then
    log_info "已是最新版，无需更新（使用 --force 可强制重新安装）"
    exit 0
  fi

  # 下载并安装
  download_and_install "$remote_version" "$arch"

  # 首次安装或更新
  if [ -z "$local_version" ]; then
    first_time_setup "$remote_version"
  else
    do_update "$remote_version"
  fi

  # 验证
  if "$INSTALL_DIR/codeg-server" --version >/dev/null 2>&1; then
    log_info "验证通过：codeg-server 可执行"
  else
    log_error "验证失败：codeg-server 无法执行"
  fi
}

main "$@"
