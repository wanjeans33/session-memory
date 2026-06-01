#!/usr/bin/env bash
# 把本机的 Claude Code 会话记录（*.jsonl）复制到仓库 sessions/mac/ 下作为归档。
# 只复制文件，不做 git 操作（由 sync.sh 负责 commit/push）。排除 memory/（它是软链接）。
set -euo pipefail
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROJECTS="$HOME/.claude/projects"
DEST="$REPO/sessions/mac"

[ -d "$PROJECTS" ] || exit 0
mkdir -p "$DEST"
cd "$PROJECTS"
# 保留 <项目>/... 目录结构
find . -type f -name '*.jsonl' -not -path '*/memory/*' | while IFS= read -r f; do
  mkdir -p "$DEST/$(dirname "$f")"
  cp -f "$f" "$DEST/$f"
done
