#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Codeg Server 管理菜单脚本
# 功能：提供服务启停、状态查看、日志、配置、工具链、更新等管理操作
# 安装路径：/usr/local/bin/codeg
# 用法：codeg [子命令] 或直接 codeg 进入交互菜单
# 更新时支持选择 GitHub 访问方式：直连 / GH 反向代理 / HTTP-SOCKS 转发代理
#   环境变量免交互：CODEG_PROXY_MODE / CODEG_PROXY / CODEG_FORWARD_PROXY
# ============================================================

# ===== 常量 =====
REPO="likesrt/codeg"
SERVICE_NAME="codeg-server"
ENV_FILE="/opt/codeg/.env"
INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/$REPO/main/scripts/local-server-linux-install.sh"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main/scripts"
# GitHub 反向代理列表（按优先级排列，全部失败则报错）
GH_PROXIES=(
  "https://ghdk.ansss.de/"
  "https://ghproxy.net/"
  "https://github.dpik.top/"
  "https://gh-proxy.com/"
  "https://cdn.gh-proxy.com/"
)
# 管理脚本列表
SCRIPTS=(
  "local-server-linux-ctl.sh:codeg"
  "local-server-linux-init-tools.sh:codeg-init-tools"
)

# 代理相关变量（select_proxy 会设置）
# CODEG_PROXY_MODE: direct（直连）/ gh（GH 反向代理前缀）/ forward（HTTP/SOCKS 转发代理）
# 留空表示未指定，select_proxy 会进入交互式菜单；用户显式 export 后则免交互
# PROXY_PREFIX: gh 模式下归一化后的代理前缀（保证末尾带 /）
# FORWARD_PROXY: forward 模式下的转发代理 URL
CODEG_PROXY_MODE=""
PROXY_PREFIX=""
FORWARD_PROXY=""

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

# 打印菜单标题
# 参数：无
# 返回：无
print_banner() {
  echo ""
  echo "  Codeg Server 管理"
  echo "  ─────────────────────────"
}

# 打印菜单选项
# 参数：无
# 返回：无
print_menu() {
  echo "  1) 启动服务"
  echo "  2) 停止服务"
  echo "  3) 重启服务"
  echo "  4) 查看状态"
  echo "  5) 实时日志"
  echo "  6) 查看配置"
  echo "  7) 初始化工具链"
  echo "  8) 设置开机自启"
  echo "  9) 关闭开机自启"
  echo "  0) 更新到最新版"
  echo "  s) 更新管理脚本"
  echo "  q) 退出"
  echo "  ─────────────────────────"
}

# 启动 codeg-server 服务
# 参数：无
# 返回：无
do_start() {
  systemctl start "$SERVICE_NAME"
  echo "已启动 $SERVICE_NAME"
}

# 停止 codeg-server 服务
# 参数：无
# 返回：无
do_stop() {
  systemctl stop "$SERVICE_NAME"
  echo "已停止 $SERVICE_NAME"
}

# 重启 codeg-server 服务
# 参数：无
# 返回：无
do_restart() {
  systemctl restart "$SERVICE_NAME"
  echo "已重启 $SERVICE_NAME"
}

# 查看 codeg-server 服务状态
# 参数：无
# 返回：无
do_status() {
  systemctl status "$SERVICE_NAME" || true
}

# 实时查看 codeg-server 日志
# 参数：无
# 返回：无
do_logs() {
  journalctl -u "$SERVICE_NAME" -f
}

# 查看 /opt/codeg/.env 配置文件
# 参数：无
# 返回：无
do_config() {
  if [ -f "$ENV_FILE" ]; then
    cat "$ENV_FILE"
  else
    echo "配置文件 $ENV_FILE 不存在"
    exit 1
  fi
}

# 调用工具链安装脚本
# 参数：无
# 返回：无
do_init() {
  if [ -x /usr/local/bin/codeg-init-tools ]; then
    /usr/local/bin/codeg-init-tools
  else
    echo "工具链安装脚本不存在：/usr/local/bin/codeg-init-tools"
    exit 1
  fi
}

# 设置 codeg-server 开机自启
# 参数：无
# 返回：无
do_enable() {
  systemctl enable "$SERVICE_NAME"
  echo "已设置开机自启"
}

# 关闭 codeg-server 开机自启
# 参数：无
# 返回：无
do_disable() {
  systemctl disable "$SERVICE_NAME"
  echo "已关闭开机自启"
}

# ===== 代理选择 =====

# 归一化 GH 反向代理前缀：保证末尾带 /，无协议时补 https://
# 参数：$1 - 用户输入的代理 URL
# 返回：echo 输出归一化后的前缀
normalize_proxy_prefix() {
  local p="$1"
  [ -z "$p" ] && return
  case "$p" in
    http://*|https://*) ;;
    *) p="https://$p" ;;
  esac
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
  case "$code" in
    2*) return 0 ;;
  esac
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

# 规范化已经带 GH 反向代理前缀的 URL，避免重复拼接代理地址
# 参数：$1 - 待处理 URL
# 返回：echo 输出规范化后的 URL
normalize_download_url() {
  local url="$1"
  local proxy_host
  case "$url" in
    http://*|https://*) ;;
    *)
      # 某些旧版本/环境变量可能只保留代理主机名，先恢复协议
      for proxy in "${GH_PROXIES[@]}"; do
        proxy_host="${proxy#https://}"
        proxy_host="${proxy_host#http://}"
        case "$url" in
          "$proxy_host"*) url="https://$url"; break ;;
        esac
      done
      ;;
  esac
  for proxy in "${GH_PROXIES[@]}"; do
    case "$url" in
      "$proxy"*) echo "$url"; return ;;
    esac
  done
  echo "$url"
}

# 恢复被 GH 反向代理响应重写的脚本 URL。
# 部分 HubProxy 会把响应正文中的 raw/github URL 也改写成代理 URL，
# 如果直接保存并执行，会导致后续请求再次套代理前缀。
# 参数：$1 - 已下载的脚本文件
# 返回：无。副作用：原地恢复 canonical GitHub URL
restore_canonical_urls() {
  local file="$1"
  local proxy proxy_host
  for proxy in "${GH_PROXIES[@]}"; do
    proxy_host="${proxy%/}"
    sed -i \
      -e "s#${proxy_host}/https://raw\\.githubusercontent\\.com/#https://raw.githubusercontent.com/#g" \
      -e "s#${proxy_host}/raw\\.githubusercontent\\.com/#https://raw.githubusercontent.com/#g" \
      -e "s#${proxy_host}/https://api\\.github\\.com/#https://api.github.com/#g" \
      -e "s#${proxy_host}/api\\.github\\.com/#https://api.github.com/#g" \
      -e "s#${proxy_host}/https://github\\.com/#https://github.com/#g" \
      -e "s#${proxy_host}/github\\.com/#https://github.com/#g" \
      "$file"
  done
}

# 下载单个 GitHub URL，按当前代理模式取 URL 并下载，失败则按优先级回退
# 参数：$1 - GitHub 完整 URL，$2 - 输出文件路径（可选，省略则输出到 stdout）
# 返回：成功返回 0，全部失败返回 1
download_with_fallback() {
  local url="$1"
  local out_args=()
  [ -n "${2:-}" ] && out_args=("-o" "$2")

  # forward 模式：直接用转发代理访问原始 URL
  if [ "$CODEG_PROXY_MODE" = "forward" ]; then
    if dl -fsSL --connect-timeout 10 --max-time 120 "$url" "${out_args[@]}"; then
      [ -n "${2:-}" ] && log_info "下载成功：${url#"https://"}（via $FORWARD_PROXY）"
      return 0
    fi
    return 1
  fi

  # direct 模式：直接访问原始 URL
  if [ "$CODEG_PROXY_MODE" = "direct" ]; then
    if dl -fsSL --connect-timeout 10 --max-time 120 "$url" "${out_args[@]}"; then
      [ -n "${2:-}" ] && log_info "下载成功：${url#"https://"}（直连）"
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
    local target_url
    target_url="$(build_proxy_url "$proxy" "$url")"
    [ -n "${2:-}" ] && log_info "尝试：$target_url"
    if ! dl -fsSL --connect-timeout 10 --max-time 120 "$target_url" "${out_args[@]}"; then
      log_warn "下载失败，尝试下一个源 ..."
      continue
    fi
    # 下载响应可能被代理重写 URL；恢复后再安装/执行脚本
    if [ -n "${2:-}" ]; then
      restore_canonical_urls "$2"
      log_info "下载成功：${url#"https://"}（via ${proxy}）"
    fi
    return 0
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

# 交互式读取转发代理 URL（通过 /dev/tty）
# 参数：无
# 返回：echo 输出代理 URL
read_forward_proxy() {
  echo "支持的协议：http://、https://、socks5://、socks5h://（DNS 也走代理，推荐）" >&2
  echo "示例：socks5h://127.0.0.1:1080  http://user:pass@host:port" >&2
  read -r -p "请输入转发代理 URL: " input </dev/tty
  echo "$input"
}

# 选择 GitHub 代理方式（通过 /dev/tty 读取，支持 curl|bash 管道模式）
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
      FORWARD_PROXY="$(read_forward_proxy)"
      [ -z "$FORWARD_PROXY" ] && log_error "未输入转发代理 URL"
      log_info "使用转发代理：$FORWARD_PROXY"
      return
      ;;
    gh)
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

# 将当前代理选择导出为环境变量，供子进程（install.sh）继承，避免重复询问
# 参数：无
# 返回：无。副作用：export CODEG_PROXY_MODE / CODEG_PROXY / CODEG_FORWARD_PROXY
export_proxy_for_child() {
  case "$CODEG_PROXY_MODE" in
    direct)
      export CODEG_PROXY_MODE="direct"
      unset CODEG_PROXY 2>/dev/null || true
      unset CODEG_FORWARD_PROXY 2>/dev/null || true
      ;;
    gh)
      export CODEG_PROXY="$PROXY_PREFIX"
      unset CODEG_PROXY_MODE 2>/dev/null || true
      unset CODEG_FORWARD_PROXY 2>/dev/null || true
      ;;
    forward)
      export CODEG_FORWARD_PROXY="$FORWARD_PROXY"
      unset CODEG_PROXY 2>/dev/null || true
      unset CODEG_PROXY_MODE 2>/dev/null || true
      ;;
  esac
}

# ===== 更新操作 =====

# 更新 codeg-server 到最新版（选择代理 -> 下载安装脚本 -> 透传代理选择 -> 执行）
# 参数：无
# 返回：无
do_update() {
  echo "正在更新 codeg-server ..."
  select_proxy
  local tmp
  tmp=$(mktemp)
  if ! download_with_fallback "$INSTALL_SCRIPT_URL" "$tmp"; then
    rm -f "$tmp"
    log_error "所有代理均下载失败：$INSTALL_SCRIPT_URL"
  fi
  export_proxy_for_child
  bash "$tmp"
  rm -f "$tmp"
}

# 仅更新管理脚本（codeg 和 codeg-init-tools），不更新二进制
# 下载到临时文件再 mv 原子替换，避免覆盖正在运行的脚本导致 bash 读取错乱
# 参数：无
# 返回：无
do_update_scripts() {
  echo "正在更新管理脚本 ..."
  select_proxy
  for entry in "${SCRIPTS[@]}"; do
    local remote_file="${entry%%:*}"
    local local_name="${entry##*:}"
    local target="/usr/local/bin/$local_name"
    local tmp
    tmp=$(mktemp)
    echo "  下载 $remote_file -> $target"
    if ! download_with_fallback "$RAW_BASE/$remote_file" "$tmp"; then
      rm -f "$tmp"
      log_error "所有代理均下载失败：$RAW_BASE/$remote_file"
    fi
    chmod +x "$tmp"
    # mv 换 inode，bash 仍读旧文件，不会读到半截内容
    mv -f "$tmp" "$target"
  done
  echo "管理脚本更新完成"
}

# 执行菜单选择对应的操作
# 参数：$1 - 菜单选项
# 返回：无
handle_choice() {
  local choice="$1"
  case "$choice" in
    1) do_start ;;
    2) do_stop ;;
    3) do_restart ;;
    4) do_status ;;
    5) do_logs ;;
    6) do_config ;;
    7) do_init ;;
    8) do_enable ;;
    9) do_disable ;;
    0) do_update ;;
    s|S) do_update_scripts ;;
    q|Q) echo "再见"; exit 0 ;;
    *) echo "无效选项：$choice" ;;
  esac
}

# 显示交互式菜单并循环处理用户输入
# 参数：无
# 返回：无
interactive_menu() {
  while true; do
    print_banner
    print_menu
    read -r -p "  请选择: " choice
    handle_choice "$choice"
    echo ""
    read -r -p "  按回车继续..." _
  done
}

# 打印帮助信息
# 参数：无
# 返回：无
print_help() {
  cat << 'EOF'
用法：codeg [子命令]

子命令：
  start     启动服务
  stop      停止服务
  restart   重启服务
  status    查看状态
  logs      实时日志
  config    查看配置
  init      初始化工具链
  enable    设置开机自启
  disable   关闭开机自启
  update          更新到最新版（全部，会询问代理方式）
  update-scripts  仅更新管理脚本（会询问代理方式）

不带子命令时进入交互式菜单。

代理方式可通过环境变量免交互指定：
  CODEG_PROXY_MODE=direct                  直连 GitHub
  CODEG_PROXY_MODE=gh                      使用内置 GH 反向代理列表
  CODEG_PROXY=https://ghproxy.net/          使用指定 GH 反向代理前缀
  CODEG_FORWARD_PROXY=socks5h://host:port   使用 HTTP/SOCKS 转发代理
EOF
}

# 主入口：解析子命令或进入交互菜单
# 参数：$@ - 子命令和参数
# 返回：无
main() {
  # root 检测
  if [ "$(id -u)" -ne 0 ]; then
    echo "建议以 root 用户运行" >&2
  fi

  local subcmd="${1:-}"
  if [ -z "$subcmd" ]; then
    interactive_menu
    return
  fi

  case "$subcmd" in
    start) do_start ;;
    stop) do_stop ;;
    restart) do_restart ;;
    status) do_status ;;
    logs) do_logs ;;
    config) do_config ;;
    init) do_init ;;
    enable) do_enable ;;
    disable) do_disable ;;
    update) do_update ;;
    update-scripts) do_update_scripts ;;
    -h|--help|help) print_help ;;
    *)
      echo "未知子命令：$subcmd"
      print_help
      exit 1
      ;;
  esac
}

main "$@"
