#!/usr/bin/env bash
# 把会话存进项目 session-history/。手动命令（由 /session-memory save 调用）。
#   save.sh                 # -Current：只存当前会话
#   save.sh --all           # 扫所有端（Claude + Codex；mac 上 Desktop 亦可）
#   save.sh --commit        # 写完提交该项目 session-history（仅 current 有意义）
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。
set -uo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
CAP="$SCRIPTS/capture"
# shellcheck source=/dev/null
. "$CAP/_lib.sh"

MODE=current; COMMIT=false; CWD="$(pwd)"
while [ $# -gt 0 ]; do case "$1" in
  --all) MODE=all;; --current) MODE=current;; --commit) COMMIT=true;;
  --cwd) CWD="$2"; shift;;
esac; shift; done

if [ "$MODE" = all ]; then
  echo "save --all：扫描所有端…"
  bash "$CAP/claude-scrape.sh" --all
  bash "$CAP/codex-scrape.sh" --all
  [ -f "$CAP/desktop-scrape.sh" ] && bash "$CAP/desktop-scrape.sh" --all || true
  echo "save --all 完成。"
else
  bash "$CAP/claude-scrape.sh" --current --cwd "$CWD"
  if [ "$COMMIT" = true ]; then
    git_info "$CWD" || true
    [ -n "${GIT_MAIN_ROOT:-}" ] && commit_session_history "$GIT_MAIN_ROOT" "chore(session-history): save current session"
  fi
fi
