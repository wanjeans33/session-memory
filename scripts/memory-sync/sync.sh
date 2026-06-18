#!/usr/bin/env bash
# 同步【记忆仓库】：拉取最新，提交本机对 memory/ 与 CLAUDE.md 的改动并推送。
# （会话历史不在这里——见 scripts/session-history/，按项目落地。）
#   sync.sh              # 全量同步（手动或 SessionEnd）
#   sync.sh --pull-only  # 仅拉取（SessionStart，开工前取最新）
set -euo pipefail
PULL_ONLY="${1:-}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/../.." && pwd)"
cd "$REPO"

git pull --rebase --autostash
if [ "$PULL_ONLY" != "--pull-only" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "sync(mac): $(date '+%Y-%m-%d %H:%M')"
    git push
  fi
fi
