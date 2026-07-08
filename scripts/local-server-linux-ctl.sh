#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Codeg Server 管理菜单脚本
# 功能：提供服务启停、状态查看、日志、配置、工具链、更新等管理操作
# 安装路径：/usr/local/bin/codeg
# 用法：codeg [子命令] 或直接 codeg 进入交互菜单
# ============================================================

# ===== 常量 =====
SERVICE_NAME="codeg-server"
ENV_FILE="/opt/codeg/.env"
INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/likesrt/codeg/main/scripts/local-server-linux-install.sh"
# GitHub 代理前缀（国内服务器自动使用）
GH_PROXY="https://cdn.gh-proxy.org/"

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

# 更新 codeg-server 到最新版（自动检测代理，重新执行安装脚本）
# 参数：无
# 返回：无
do_update() {
  echo "正在更新 codeg-server ..."
  local url="$INSTALL_SCRIPT_URL"
  # 检测 GitHub 连通性，失败则使用代理（强制 HTTP/1.1 避免代理协议错误）
  if ! curl --http1.1 -fsSL --connect-timeout 5 --max-time 10 "$INSTALL_SCRIPT_URL" >/dev/null 2>&1; then
    url="${GH_PROXY}${INSTALL_SCRIPT_URL}"
    echo "GitHub 无法直连，使用代理"
  fi
  curl --http1.1 -fsSL "$url" | bash
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
  update    更新到最新版

不带子命令时进入交互式菜单。
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
    -h|--help|help) print_help ;;
    *)
      echo "未知子命令：$subcmd"
      print_help
      exit 1
      ;;
  esac
}

main "$@"
