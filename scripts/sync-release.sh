#!/usr/bin/env bash
#===========================================================================
# sync-release.sh — Codeg 同步发布脚本
#
# 流程：
#   1. git pull origin main         拉取远程最新
#   2. git fetch xintaofei main      拉取上游最新
#   3. 比较 HEAD，无变更则退出
#   4. git merge xintaofei/main      合并上游
#   5. pnpm test + cargo check      质量检查
#   6. git push origin main         推送到远程
#   7. 检测 package.json 大版本号变更，有变更则触发 CI
#
# 用法：./scripts/sync-release.sh
#===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- 配置 ----
UPSTREAM_REMOTE="xintaofei"
UPSTREAM_BRANCH="main"

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- 版本比较 ----
# 比较两个 semver 字符串的大版本号（MAJOR.MINOR）
# 返回 0 表示相同，1 表示不同
is_major_version_changed() {
    local old_ver="$1"
    local new_ver="$2"

    local old_major_minor
    old_major_minor=$(echo "$old_ver" | cut -d. -f1,2)

    local new_major_minor
    new_major_minor=$(echo "$new_ver" | cut -d. -f1,2)

    [[ "$old_major_minor" != "$new_major_minor" ]]
}

# ---- 主流程 ----
cd "$REPO_ROOT"

# 记录执行前的版本和 HEAD，用于后续比较
OLD_VERSION=$(node -e "console.log(require('./package.json').version)")
OLD_HEAD=$(git rev-parse HEAD)

log_info "当前版本: $OLD_VERSION"
log_info "当前 HEAD: ${OLD_HEAD:0:8}"

# Step 1: git pull
log_info "Step 1/7: git pull origin main..."
git pull origin main

# Step 2: fetch upstream
log_info "Step 2/7: git fetch $UPSTREAM_REMOTE $UPSTREAM_BRANCH..."
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

# Step 3: 检查是否有变更
NEW_HEAD=$(git rev-parse HEAD)
UPSTREAM_HEAD=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

if [[ "$NEW_HEAD" == "$UPSTREAM_HEAD" ]]; then
    log_info "本地已是最新，无需合并，退出。"
    exit 0
fi

log_info "检测到上游变更: ${UPSTREAM_HEAD:0:8}"

# Step 4: merge upstream
log_info "Step 4/7: git merge $UPSTREAM_REMOTE/$UPSTREAM_BRANCH..."
git merge "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --no-edit

# Step 5: 质量检查
log_info "Step 5/7: pnpm test..."
pnpm test

log_info "Step 5/7: cargo check..."
cd "$REPO_ROOT/src-tauri"
cargo check
cd "$REPO_ROOT"

# Step 6: push
log_info "Step 6/7: git push origin main..."
git push origin main

# Step 7: 版本检测 & CI 触发
NEW_VERSION=$(node -e "console.log(require('./package.json').version)")
log_info "Step 7/7: 版本检测 ($OLD_VERSION -> $NEW_VERSION)..."

if is_major_version_changed "$OLD_VERSION" "$NEW_VERSION"; then
    log_info "大版本号变更，触发 CI 流水线..."

    gh workflow run build-docker.yml --ref main
    log_info "  -> build-docker.yml 已触发"

    gh workflow run build-windows-x64.yml --ref main
    log_info "  -> build-windows-x64.yml 已触发"

    log_info "全部完成！版本 $OLD_VERSION -> $NEW_VERSION"
else
    log_info "大版本号未变更，跳过 CI 触发。"

    log_info "全部完成！"
fi
