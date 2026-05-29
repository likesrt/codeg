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
mkdir -p /data /home/codeg/workspace /home/codeg
chown -R codeg:codeg /data /home/codeg/workspace /home/codeg 2>/dev/null || true

run_as_codeg() {
  gosu codeg "$@"
}

# Ensures Bash login shells inherit ~/.bashrc-managed toolchain paths.
# Arguments: none. Returns success unless the profile cannot be written. Side effect: creates or updates /home/codeg/.bash_profile.
ensure_bash_login_profile() {
  local profile=/home/codeg/.bash_profile
  touch "$profile"
  grep -qxF '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"' "$profile" || printf '%s\n' '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"' >>"$profile"
  chown codeg:codeg "$profile" 2>/dev/null || true
}

# Starts the optional full toolchain initializer without blocking Codeg Web startup.
# Arguments: none. Returns immediately after launching the background job.
# Side effect: writes initialization logs under /home/codeg/.codeg and refreshes browser registration after install.
start_toolchain_init_if_enabled() {
  [ "${CODEG_INIT_TOOL_ON_START:-false}" = "true" ] || return 0

  mkdir -p /home/codeg/.codeg
  chown codeg:codeg /home/codeg/.codeg 2>/dev/null || true
  (run_as_codeg bash -lc 'codeg init tool >>/home/codeg/.codeg/toolchains-init.log 2>&1' && register_system_browsers) &
}

# Registers all installed browsers that should be visible to desktop apps and
# CLI tools. It can run before or after the optional background tool installer;
# missing browsers are skipped so first boot and later refreshes both work.
# Arguments: none. Returns success unless filesystem writes fail.
# Side effect: refreshes browser wrappers, desktop entries, compatibility paths,
# and update-alternatives entries for installed browsers.
register_system_browsers() {
  register_camoufox_system_browser
  register_chromium_system_browser
}

# Registers the Camoufox browser binary (installed via `codeg init tool`) as a
# system-level desktop application so it appears in the XFCE application menu
# and serves as the primary system web browser (priority 60).
# Arguments: none. Returns success unless filesystem writes fail.
# Side effect: creates /usr/local/bin/camoufox-browser,
# /usr/local/share/applications/camoufox.desktop, and update-alternatives entries.
register_camoufox_system_browser() {
  local browser_bin=/home/codeg/.cache/camoufox/camoufox
  local wrapper=/usr/local/bin/camoufox-browser
  local desktop_dir=/usr/local/share/applications
  local desktop_file=$desktop_dir/camoufox.desktop

  [ -x "$browser_bin" ] || return 0

  mkdir -p "$desktop_dir"

  cat >"$wrapper" <<'WRAPPER_EOF'
#!/usr/bin/env bash
exec /home/codeg/.cache/camoufox/camoufox "$@"
WRAPPER_EOF
  chmod 755 "$wrapper"

  cat >"$desktop_file" <<DESKTOP_EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Camoufox
Comment=Anti-detection Firefox-based browser
Exec=/usr/local/bin/camoufox-browser %u
Icon=web-browser
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
Terminal=false
StartupNotify=true
DESKTOP_EOF

  update-desktop-database "$desktop_dir" 2>/dev/null || true
  update-alternatives --install /usr/bin/x-www-browser x-www-browser "$wrapper" 60 2>/dev/null || true
  update-alternatives --install /usr/bin/www-browser www-browser "$wrapper" 60 2>/dev/null || true
}

# Registers Playwright-installed Chromium as a fallback system browser
# (priority 40, lower than Camoufox). Activates automatically when Chromium
# has been installed via `python -m playwright install chromium`.
# Arguments: none. Returns success unless filesystem writes fail.
# Side effect: creates /usr/local/bin/chromium-browser,
# /usr/local/bin/google-chrome, /usr/local/share/applications/chromium.desktop,
# /opt/google/chrome/chrome, and update-alternatives entries.
register_chromium_system_browser() {
  local playwright_cache=/home/codeg/.cache/ms-playwright
  local chromium_dir chromium_bin wrapper desktop_dir desktop_file chrome_compat

  [ -d "$playwright_cache" ] || return 0
  chromium_dir=$(find "$playwright_cache" -maxdepth 1 -type d -name 'chromium-*' 2>/dev/null | sort -V | tail -1)
  [ -n "$chromium_dir" ] || return 0
  chromium_bin=$chromium_dir/chrome-linux/chrome
  [ -x "$chromium_bin" ] || return 0

  wrapper=/usr/local/bin/chromium-browser
  desktop_dir=/usr/local/share/applications
  desktop_file=$desktop_dir/chromium.desktop
  chrome_compat=/opt/google/chrome/chrome
  mkdir -p "$desktop_dir" "$(dirname "$chrome_compat")"

  cat >"$wrapper" <<WRAPPER_EOF
#!/usr/bin/env bash
exec "$chromium_bin" "\$@"
WRAPPER_EOF
  chmod 755 "$wrapper"

  # Some tools hard-code Google Chrome's Debian path instead of using PATH.
  if [ ! -e "$chrome_compat" ] || [ -L "$chrome_compat" ]; then
    ln -sfnT "$wrapper" "$chrome_compat"
  fi
  if [ ! -e /usr/local/bin/google-chrome ] || [ -L /usr/local/bin/google-chrome ]; then
    ln -sfnT "$wrapper" /usr/local/bin/google-chrome
  fi

  cat >"$desktop_file" <<DESKTOP_EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Chromium
Comment=Playwright Chromium browser
Exec=/usr/local/bin/chromium-browser %u
Icon=web-browser
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
Terminal=false
StartupNotify=true
DESKTOP_EOF

  update-desktop-database "$desktop_dir" 2>/dev/null || true
  update-alternatives --install /usr/bin/x-www-browser x-www-browser "$wrapper" 40 2>/dev/null || true
  update-alternatives --install /usr/bin/www-browser www-browser "$wrapper" 40 2>/dev/null || true
}

ensure_bash_login_profile
start_toolchain_init_if_enabled
register_system_browsers

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
