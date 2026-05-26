#!/usr/bin/env bash
set -euo pipefail

# 默认以 codeg 用户的持久化 home 运行服务和桌面会话。
export HOME=/home/codeg
export USER=codeg
export DISPLAY=${DISPLAY:-:1}
export VNC_GEOMETRY=${VNC_GEOMETRY:-1440x900}
export VNC_DEPTH=${VNC_DEPTH:-24}
export VNC_PASSWORD=${VNC_PASSWORD:-change-me}

# bind mount 目录可能来自宿主机，启动时先确保存在并尽量修正权限。
mkdir -p /data /workspace /home/codeg
chown -R codeg:codeg /data /workspace /home/codeg 2>/dev/null || true

run_as_codeg() {
  gosu codeg "$@"
}

# 修复已持久化 home 中旧镜像留下的 Node 路径，确保 npm/pnpm 可被默认 PATH 找到。
if [ -s /home/codeg/.nvm/nvm.sh ]; then
  run_as_codeg bash -lc 'source "$HOME/.nvm/nvm.sh" && nvm use --silent default >/dev/null && ln -sfn "$(npm prefix -g)" "$HOME/.nvm/current"'
fi
if [ -f /home/codeg/.bashrc ]; then
  sed -i 's|$NVM_DIR/versions/node/v24/bin|$NVM_DIR/current/bin|g' /home/codeg/.bashrc
  grep -qxF 'export NVM_SYMLINK_CURRENT=true' /home/codeg/.bashrc || sed -i '/export NVM_DIR="\$HOME\/\.nvm"/a export NVM_SYMLINK_CURRENT=true' /home/codeg/.bashrc
  chown codeg:codeg /home/codeg/.bashrc 2>/dev/null || true
fi

# 初始化 VNC 配置目录和密码文件，密码来自 docker-compose.yml 的 VNC_PASSWORD。
run_as_codeg bash -lc 'mkdir -p "$HOME/.vnc" "$HOME/.config" "$HOME/.cache"'
run_as_codeg bash -lc 'printf "%s\n" "$VNC_PASSWORD" | vncpasswd -f > "$HOME/.vnc/passwd" && chmod 600 "$HOME/.vnc/passwd"'

# XFCE 是 VNC 会话启动的桌面环境。
if [ ! -f /home/codeg/.vnc/xstartup ]; then
  cat >/home/codeg/.vnc/xstartup <<'EOF'
#!/usr/bin/env bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
  chown codeg:codeg /home/codeg/.vnc/xstartup
  chmod +x /home/codeg/.vnc/xstartup
fi

# VNC 只监听容器本机 localhost，外部访问统一走 HTTPS noVNC。
run_as_codeg bash -lc 'vncserver -kill "$DISPLAY" >/dev/null 2>&1 || true'
run_as_codeg bash -lc 'vncserver "$DISPLAY" -geometry "$VNC_GEOMETRY" -depth "$VNC_DEPTH" -localhost yes'

# noVNC 使用自签名证书提供 HTTPS；证书放在持久化 home 中，避免每次重启都变化。
if [ ! -f /home/codeg/.vnc/novnc.pem ]; then
  run_as_codeg openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout /home/codeg/.vnc/novnc.pem \
    -out /home/codeg/.vnc/novnc.pem \
    -subj "/CN=codeg-novnc" >/dev/null 2>&1
  run_as_codeg chmod 600 /home/codeg/.vnc/novnc.pem
fi

# noVNC 暴露容器内 6080，compose 将其映射到宿主机 49999。
run_as_codeg websockify --web=/usr/share/novnc/ --cert=/home/codeg/.vnc/novnc.pem 0.0.0.0:6080 localhost:5901 &

# 前台运行 Codeg 服务，让容器生命周期跟随 codeg-server。
exec gosu codeg codeg-server
