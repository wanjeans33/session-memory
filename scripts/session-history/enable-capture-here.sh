#!/usr/bin/env bash
# 只为【当前 repo】启用/关闭 Claude 会话采集（按 repo 范围）。依赖 jq。
# 把 SessionEnd 采集 hook 写进 <repo>/.claude/settings.local.json（本地、不应提交）。
# 与全局安装二选一，避免重复采集。
#   enable-capture-here.sh [repo-path]            # 启用
#   enable-capture-here.sh --remove [repo-path]   # 移除
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。
set -uo pipefail
command -v jq >/dev/null 2>&1 || { echo "需要 jq（brew install jq）"; exit 1; }

REMOVE=false
if [ "${1:-}" = "--remove" ]; then REMOVE=true; shift; fi
REPO="${1:-$(pwd)}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
CAP_SCRIPT="$SCRIPTS/capture/claude-session-end.sh"
CAP_CMD="bash \"$CAP_SCRIPT\""

top=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || { echo "不是 git 仓库: $REPO" >&2; exit 1; }
CLAUDE_DIR="$top/.claude"; SETTINGS="$CLAUDE_DIR/settings.local.json"
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

TMP="$(mktemp)"
if [ "$REMOVE" = true ]; then
  jq --arg cap "$CAP_CMD" '
    .hooks //= {} | .hooks.SessionEnd //= []
    | .hooks.SessionEnd |= map(select((.hooks // [] | map(.command) | index($cap)) | not))
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
  echo "✓ 已移除采集 hook：$SETTINGS"
else
  jq --arg cap "$CAP_CMD" '
    .hooks //= {} | .hooks.SessionEnd //= []
    | (if [.hooks.SessionEnd[].hooks[]?.command] | index($cap) then .
        else .hooks.SessionEnd += [{hooks:[{type:"command",command:$cap}]}] end)
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
  echo "✓ 已为本 repo 启用采集：$SETTINGS"
  echo "  建议把 .claude/settings.local.json 加入该仓库 .gitignore（含本机绝对路径，不应提交）。"
fi
