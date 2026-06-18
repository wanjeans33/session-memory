#!/usr/bin/env bash
# 汇聚 session-history/digests/*.json + index.json，按分支分组，输出紧凑 JSON 到 stdout。
#   build-status.sh [repo-path]
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }
REPO="${1:-$(pwd)}"
common=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "not a git repo: $REPO" >&2; exit 1; }
MAIN_ROOT=$(cd "$(dirname "$common")" && pwd)
hist="$MAIN_ROOT/session-history"

index='null'; [ -f "$hist/index.json" ] && index=$(cat "$hist/index.json")

digests='[]'
if [ -d "$hist/digests" ]; then
  digests=$(jq -s '[ .[] | {ended_at,tool,branch:.git.branch,worktree:.git.worktree,turns,first_prompt,summary,files:.files_touched,next_steps} ]' \
    "$hist/digests"/*.json 2>/dev/null || echo '[]')
fi

jq -n --arg gen "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repo "$(basename "$MAIN_ROOT")" \
  --argjson index "$index" --argjson sessions "$digests" '
  {
    generated_at: $gen, repo: $repo, total_sessions: ($sessions|length), index: $index,
    branches: ( $sessions | group_by(.branch // "(unknown)")
      | map({ branch: (.[0].branch // "(unknown)"), session_count: length,
              sessions: (sort_by(.ended_at) | reverse) })
      | sort_by(.session_count) | reverse )
  }'
