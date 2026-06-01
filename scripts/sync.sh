#!/usr/bin/env bash
# 同步记忆仓库：拉取最新，归档本机会话，提交并推送。
#   sync.sh              # 全量同步（手动或 SessionEnd）
#   sync.sh --pull-only  # 仅拉取（SessionStart，开工前取最新）
set -euo pipefail
PULL_ONLY="${1:-}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/.." && pwd)"
cd "$REPO"

git pull --rebase --autostash
if [ "$PULL_ONLY" != "--pull-only" ]; then
  "$SCRIPTS/archive-sessions.sh" "$REPO"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "sync(mac): $(date '+%Y-%m-%d %H:%M')"
    git push
  fi
fi
