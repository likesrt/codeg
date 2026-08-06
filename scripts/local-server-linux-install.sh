#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Codeg Server Linux 一键安装/更新脚本
# 功能：从上游 xintaofei/codeg 仓库的 GitHub Releases 下载 codeg-server 二进制和 web 资源，
#       配置 systemd 服务；管理脚本（codeg / codeg-init-tools）仍从本仓库（likesrt/codeg）下载
# 用法：curl -fsSL https://raw.githubusercontent.com/likesrt/codeg/main/scripts/local-server-linux-install.sh | bash
#       或：bash local-server-linux-install.sh [--force]
# 国内服务器如果无法下载本脚本，可使用代理（按优先级：ghdk.ansss.de > ghproxy.net > github.dpik.top > gh-proxy.com > cdn.gh-proxy.com）：
#       curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/likesrt/codeg/main/scripts/local-server-linux-install.sh | bash
# 代理方式可通过环境变量免交互指定：
#   CODEG_PROXY_MODE=direct                       直连 GitHub
#   CODEG_PROXY_MODE=gh                           使用内置 GH 反向代理列表（自动选第一个可用）
#   CODEG_PROXY=https://ghproxy.net/              使用指定 GH 反向代理前缀（自动适配末尾 /）
#   CODEG_FORWARD_PROXY=socks5h://127.0.0.1:1080  使用 HTTP/SOCKS 转发代理
# ============================================================

# ===== 常量 =====
# 管理脚本仓库（codeg / codeg-init-tools 从这里下载）
REPO="likesrt/codeg"
# 二进制仓库（codeg-server / codeg-mcp / web 从这里下载）
BIN_REPO="xintaofei/codeg"
# 版本检测使用上游仓库的 latest release
GITHUB_API="https://api.github.com/repos/$BIN_REPO/releases/latest"
BIN_BASE="https://github.com/$BIN_REPO"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main/scripts"
# GitHub 反向代理列表（按优先级排列，全部失败则报错）
GH_PROXIES=(
  "https://ghdk.ansss.de/"
  "https://ghproxy.net/"
  "https://github.dpik.top/"
  "https://gh-proxy.com/"
  "https://cdn.gh-proxy.com/"
)
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/opt/codeg/data"
WEB_DIR="/opt/codeg/web"
TOOLS_DIR="/opt/codeg/tools"
ENV_FILE="/opt/codeg/.env"
VERSION_FILE="/opt/codeg/.version"
SERVICE_FILE="/etc/systemd/system/codeg-server.service"

# 代理相关变量（select_proxy 会设置）
# CODEG_PROXY_MODE: direct（直连）/ gh（GH 反向代理前缀）/ forward（HTTP/SOCKS 转发代理）
# PROXY_PREFIX: gh 模式下归一化后的代理前缀（保证末尾带 /）
# FORWARD_PROXY: forward 模式下的转发代理 URL
CODEG_PROXY_MODE="direct"
PROXY_PREFIX=""
FORWARD_PROXY=""

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

# 归一化 GH 反向代理前缀：保证末尾带 /，无协议时补 https://
# 参数：$1 - 用户输入的代理 URL
# 返回：echo 输出归一化后的前缀
normalize_proxy_prefix() {
  local p="$1"
  [ -z "$p" ] && return
  # 无协议时补 https://
  case "$p" in
    http://*|https://*) ;;
    *) p="https://$p" ;;
  esac
  # 保证末尾带 /
  [ "${p: -1}" != "/" ] && p="$p/"
  echo "$p"
}

# 返回当前代理模式下 curl 应附加的参数
# direct: --noproxy '*' （绕开系统 ALL_PROXY，避免代理套代理）
# gh:     --noproxy '*' （GH 反向代理前缀直接拼接，不走系统转发代理）
# forward: --noproxy '*' -x <forward_proxy> （显式走用户指定的转发代理）
# 参数：无
# 返回：echo 输出 curl 代理参数
curl_proxy_args() {
  case "$CODEG_PROXY_MODE" in
    forward)
      echo "--noproxy '*' -x $FORWARD_PROXY"
      ;;
    *)
      echo "--noproxy '*'"
      ;;
  esac
}

# 统一下载函数：--noproxy '*' 避免系统 ALL_PROXY 与代理前缀叠加；
# 默认 HTTP/2，失败自动回退 --http1.1，兼容各类代理
# 失败时通过 stderr 输出 HTTP 状态码，便于诊断
# 参数：透传给 curl 的所有参数
# 返回：curl 的退出码
dl() {
  # shellcheck disable=SC2086
  local args code
  args="$(curl_proxy_args)"
  code=$(curl $args -fsSL -w '%{http_code}' "$@" 2>/dev/null -o /dev/null) || code="${code:-000}"
  # curl 成功且 http_code 以 2 开头视为成功
  case "$code" in
    2*) return 0 ;;
  esac
  # 回退到 HTTP/1.1（部分代理对 HTTP/2 支持不佳）
  code=$(curl $args --http1.1 -fsSL -w '%{http_code}' "$@" 2>/dev/null -o /dev/null) || code="${code:-000}"
  case "$code" in
    2*) return 0 ;;
  esac
  echo "    └ HTTP 状态：$code" >&2
  return 1
}

# 检测单个 URL 是否可达
# 参数：$1 - URL
# 返回：可达返回 0，不可达返回 1
check_url() {
  # shellcheck disable=SC2086
  local args
  args="$(curl_proxy_args)"
  curl $args -fsSL --connect-timeout 5 --max-time 10 "$1" >/dev/null 2>&1 || \
    curl $args --http1.1 -fsSL --connect-timeout 5 --max-time 10 "$1" >/dev/null 2>&1
}

# 下载单个 GitHub URL，按当前代理模式取 URL 并下载，失败则按优先级回退
# 参数：$1 - GitHub 完整 URL，$2 - 输出文件路径
# 返回：成功返回 0，全部失败返回 1
download_with_fallback() {
  local url="$1"
  local output="$2"

  # forward 模式：直接用转发代理访问原始 URL
  if [ "$CODEG_PROXY_MODE" = "forward" ]; then
    if dl -fsSL --connect-timeout 10 --max-time 300 "$url" -o "$output"; then
      log_info "下载成功：${url#"https://"}（via $FORWARD_PROXY）" >&2
      return 0
    fi
    return 1
  fi

  # direct 模式：直接访问原始 URL
  if [ "$CODEG_PROXY_MODE" = "direct" ]; then
    if dl -fsSL --connect-timeout 10 --max-time 300 "$url" -o "$output"; then
      log_info "下载成功：${url#"https://"}（直连）" >&2
      return 0
    fi
    return 1
  fi

  # gh 模式：使用用户指定/自动选中的代理前缀，失败则逐一回退到内置列表
  local proxies=()
  [ -n "$PROXY_PREFIX" ] && proxies+=("$PROXY_PREFIX")
  local p
  for p in "${GH_PROXIES[@]}"; do
    [ "$p" = "$PROXY_PREFIX" ] && continue
    proxies+=("$p")
  done

  for proxy in "${proxies[@]}"; do
    [ -z "$proxy" ] && continue
    log_info "尝试：${proxy}${url#"https://"}" >&2
    if dl -fsSL --connect-timeout 10 --max-time 300 "${proxy}${url}" -o "$output"; then
      log_info "下载成功：${url#"https://"}（via ${proxy}）" >&2
      return 0
    fi
    log_warn "下载失败，尝试下一个源 ..." >&2
  done
  return 1
}

# 从 GH_PROXIES 中选第一个能连通的代理，赋值给 PROXY_PREFIX
# 参数：无
# 返回：无。副作用：设置 PROXY_PREFIX；全部不可达时回退到列表第一项
pick_first_proxy() {
  local p
  for p in "${GH_PROXIES[@]}"; do
    [ -z "$p" ] && continue
    if check_url "${p}https://raw.githubusercontent.com/$REPO/main/scripts/local-server-linux-install.sh"; then
      PROXY_PREFIX="$p"
      return
    fi
  done
  PROXY_PREFIX="${GH_PROXIES[0]}"
  log_warn "所有代理探测均失败，下载阶段将逐一回退尝试"
}

# ===== 代理选择 =====

# 交互式选择 GitHub 代理方式（通过 /dev/tty 读取，支持 curl|bash 管道模式）
# 优先级：环境变量 > 交互式选择
# 参数：无
# 返回：无。副作用：设置 CODEG_PROXY_MODE / PROXY_PREFIX / FORWARD_PROXY
select_proxy() {
  # 1) CODEG_FORWARD_PROXY 显式指定转发代理 → forward 模式
  if [ -n "${CODEG_FORWARD_PROXY:-}" ]; then
    CODEG_PROXY_MODE="forward"
    FORWARD_PROXY="$CODEG_FORWARD_PROXY"
    log_info "使用转发代理（CODEG_FORWARD_PROXY）：$FORWARD_PROXY"
    return
  fi

  # 2) CODEG_PROXY 显式指定 GH 反向代理前缀 → gh 模式
  if [ -n "${CODEG_PROXY:-}" ]; then
    if [ "$CODEG_PROXY" = "none" ] || [ "$CODEG_PROXY" = "direct" ]; then
      CODEG_PROXY_MODE="direct"
      log_info "CODEG_PROXY=$CODEG_PROXY，直连 GitHub"
    else
      CODEG_PROXY_MODE="gh"
      PROXY_PREFIX="$(normalize_proxy_prefix "$CODEG_PROXY")"
      log_info "使用 GH 反向代理（CODEG_PROXY）：$PROXY_PREFIX"
    fi
    return
  fi

  # 3) CODEG_PROXY_MODE 显式指定模式
  case "${CODEG_PROXY_MODE:-}" in
    direct)
      log_info "直连 GitHub（CODEG_PROXY_MODE=direct）"
      return
      ;;
    forward)
      # 交互式输入转发代理
      FORWARD_PROXY="$(read_forward_proxy)"
      [ -z "$FORWARD_PROXY" ] && log_error "未输入转发代理 URL"
      log_info "使用转发代理：$FORWARD_PROXY"
      return
      ;;
    gh)
      # gh 模式自动选第一个可用代理
      pick_first_proxy
      log_info "使用 GH 反向代理：$PROXY_PREFIX"
      return
      ;;
  esac

  # 4) 交互式菜单（/dev/tty 不可用时默认直连）
  if [ ! -e /dev/tty ]; then
    CODEG_PROXY_MODE="direct"
    log_info "非交互环境，默认直连 GitHub"
    return
  fi

  echo "" >&2
  echo "请选择 GitHub 访问方式：" >&2
  echo "  1) 直连 GitHub（默认）" >&2
  echo "  2) 使用 GH 反向代理（内置列表，自动选可用）" >&2
  echo "  3) 使用自定义 GH 反向代理（手动输入 URL）" >&2
  echo "  4) 使用 HTTP/SOCKS 转发代理（手动输入）" >&2
  read -r -p "请选择 [1-4]（默认 1）: " choice </dev/tty
  choice="${choice:-1}"

  case "$choice" in
    1)
      CODEG_PROXY_MODE="direct"
      log_info "已选择直连 GitHub"
      ;;
    2)
      CODEG_PROXY_MODE="gh"
      pick_first_proxy
      log_info "已选择 GH 反向代理：$PROXY_PREFIX"
      ;;
    3)
      CODEG_PROXY_MODE="gh"
      echo "内置列表（可直接回车使用第一个）：" >&2
      local idx=1
      for p in "${GH_PROXIES[@]}"; do
        echo "  $idx) $p" >&2
        idx=$((idx + 1))
      done
      read -r -p "输入序号或自定义代理 URL（默认 1）: " input </dev/tty
      input="${input:-1}"
      if [[ "$input" =~ ^[0-9]+$ ]] && [ "$input" -ge 1 ] && [ "$input" -le "${#GH_PROXIES[@]}" ]; then
        PROXY_PREFIX="${GH_PROXIES[$((input - 1))]}"
      else
        PROXY_PREFIX="$(normalize_proxy_prefix "$input")"
      fi
      log_info "已选择 GH 反向代理：$PROXY_PREFIX"
      ;;
    4)
      CODEG_PROXY_MODE="forward"
      FORWARD_PROXY="$(read_forward_proxy)"
      [ -z "$FORWARD_PROXY" ] && log_error "未输入转发代理 URL"
      log_info "已选择转发代理：$FORWARD_PROXY"
      ;;
    *)
      CODEG_PROXY_MODE="direct"
      log_info "无效选项，默认直连 GitHub"
      ;;
  esac
}

# 交互式读取转发代理 URL（通过 /dev/tty）
# 参数：无
# 返回：echo 输出代理 URL
read_forward_proxy() {
  echo "支持的协议：http://、https://、socks5://、socks5h://（DNS 也走代理，推荐）" >&2
  echo "示例：socks5h://127.0.0.1:1080  http://user:pass@host:port" >&2
  read -r -p "请输入转发代理 URL: " input </dev/tty
  echo "$input"
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

# 查询上游（xintaofei/codeg）最新 release tag
# 参数：无
# 返回：echo 输出最新 tag（vX.Y.Z）
get_remote_version() {
  local tmp
  tmp=$(mktemp)
  # 按代理优先级列表回退；全部失败则报错
  if ! download_with_fallback "$GITHUB_API" "$tmp"; then
    rm -f "$tmp"
    log_error "所有代理均下载失败：$GITHUB_API"
  fi
  jq -r '.tag_name // empty' "$tmp"
  rm -f "$tmp"
}

# ===== 下载安装 =====

# 全局临时目录变量，用于 trap 清理（local 变量在 trap 中不可用）
_CLEANUP_TMP=""

# 下载指定 release 的合并 tarball 并安装二进制和 web 资源
# 上游 xintaofei/codeg 的 codeg-server-linux-{x64,arm64}.tar.gz 同时包含 codeg-server、codeg-mcp 和 web
# 参数：$1 - release tag，$2 - 架构（amd64/arm64）
# 返回：无。副作用：覆盖安装 codeg-server/codeg-mcp 二进制，解压 web 资源
download_and_install() {
  local tag="$1"
  local arch="$2"

  # 上游 asset 命名使用 x64/arm64，amd64 需映射为 x64
  local bin_arch="$arch"
  [ "$arch" = "amd64" ] && bin_arch="x64"

  _CLEANUP_TMP=$(mktemp -d)
  trap 'rm -rf "$_CLEANUP_TMP"' EXIT

  local dl_file="codeg-server-linux-$bin_arch.tar.gz"
  log_info "下载 $dl_file ..."
  # 按优先级尝试各代理，全部失败则报错
  if ! download_with_fallback "$BIN_BASE/releases/download/$tag/$dl_file" "$_CLEANUP_TMP/$dl_file"; then
    log_error "所有代理均下载失败：$dl_file"
  fi

  # 下载 sha256 校验文件并验证，防止下载损坏或被篡改
  if download_with_fallback "$BIN_BASE/releases/download/$tag/$dl_file.sha256" "$_CLEANUP_TMP/$dl_file.sha256"; then
    local expected actual
    expected=$(awk '{print $1}' "$_CLEANUP_TMP/$dl_file.sha256")
    actual=$(sha256sum "$_CLEANUP_TMP/$dl_file" | awk '{print $1}')
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
      log_error "sha256 校验失败：$dl_file（期望 $expected，实际 $actual）"
    fi
    log_info "sha256 校验通过"
  else
    log_warn "sha256 文件下载失败，跳过校验"
  fi

  # 解压 tarball，内部结构为 codeg-server-linux-$bin_arch/{codeg-server,codeg-mcp,web}
  tar -C "$_CLEANUP_TMP" -xzf "$_CLEANUP_TMP/$dl_file"
  local extract_dir="$_CLEANUP_TMP/codeg-server-linux-$bin_arch"
  chmod +x "$extract_dir/codeg-server" "$extract_dir/codeg-mcp"

  # 安装二进制到 /usr/local/bin/
  mkdir -p "$INSTALL_DIR"
  # 如果服务正在运行，先停止
  if systemctl is-active --quiet codeg-server 2>/dev/null; then
    log_info "停止运行中的 codeg-server ..."
    systemctl stop codeg-server || true
  fi

  cp "$extract_dir/codeg-server" "$INSTALL_DIR/codeg-server"
  cp "$extract_dir/codeg-mcp" "$INSTALL_DIR/codeg-mcp"

  # 安装 web 资源
  rm -rf "$WEB_DIR"
  mkdir -p "$WEB_DIR"
  cp -a "$extract_dir/web/." "$WEB_DIR/"

  rm -rf "$_CLEANUP_TMP"
  _CLEANUP_TMP=""
  trap - EXIT
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
# 5 分钟内重启超过 10 次则停止，防止 crash loop 无限刷日志
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
EnvironmentFile=/opt/codeg/.env
ExecStart=/usr/local/bin/codeg-server
# always: 无论异常退出还是 OOM-kill 都重启；管理员 systemctl stop 仍会被尊重（不会在主动停止后自启）
Restart=always
RestartSec=3
WorkingDirectory=/opt/codeg
# 内存兜底：硬限 6G 防止进程把整机拖到 OOM；软限 5G 触发内核回收；
# OOMPolicy=continue 让 cgroup OOM 只杀肇事进程而非整个 unit，配合 Restart=always 自动重启
MemoryMax=6G
MemoryHigh=5G
OOMPolicy=continue

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

  if ! download_with_fallback "$RAW_BASE/local-server-linux-ctl.sh" "$INSTALL_DIR/codeg"; then
    log_error "所有代理均下载失败：$RAW_BASE/local-server-linux-ctl.sh"
  fi
  chmod +x "$INSTALL_DIR/codeg"

  if ! download_with_fallback "$RAW_BASE/local-server-linux-init-tools.sh" "$INSTALL_DIR/codeg-init-tools"; then
    log_error "所有代理均下载失败：$RAW_BASE/local-server-linux-init-tools.sh"
  fi
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

# 执行更新流程：更新管理脚本、重启服务、更新版本记录
# 参数：$1 - release tag
# 返回：无
do_update() {
  local tag="$1"

  log_info "更新到 $tag ..."

  # 更新管理脚本（codeg 和 codeg-init-tools）
  install_scripts

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

  # 选择 GitHub 代理方式
  select_proxy

  # 安装系统依赖
  install_system_deps

  # 获取版本
  local local_version remote_version
  local_version=$(get_local_version)
  remote_version=$(get_remote_version)

  if [ -z "$remote_version" ]; then
    log_error "未找到上游 release，请确认 xintaofei/codeg 已有已发布的版本"
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
