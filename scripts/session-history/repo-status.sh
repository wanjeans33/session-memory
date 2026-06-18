#!/usr/bin/env bash
# 枚举仓库分支/worktree 状态 -> <project>/session-history/index.json。依赖 jq。
#   repo-status.sh [repo-path]
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }
REPO="${1:-$(pwd)}"
common=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "not a git repo: $REPO" >&2; exit 1; }
MAIN_ROOT=$(cd "$(dirname "$common")" && pwd)

DEFAULT=main
git -C "$REPO" rev-parse --verify -q refs/heads/main >/dev/null 2>&1 || \
  { git -C "$REPO" rev-parse --verify -q refs/heads/master >/dev/null 2>&1 && DEFAULT=master; }

# worktrees
wt_json=$(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk -v root="$MAIN_ROOT" '
  function flush() { if (p!="") { rel=p; if (p==root) rel="."; else if (index(p,root"/")==1) rel=substr(p,length(root)+2);
      printf "%s{\"path\":\"%s\",\"branch\":\"%s\",\"head\":\"%s\",\"detached\":%s}", (n++? ",":""), rel, b, h, (d?"true":"false") } }
  /^worktree /{ flush(); p=substr($0,10); b=""; h=""; d=0 }
  /^HEAD /{ h=substr($0,6,7) }
  /^branch /{ b=substr($0,8); sub(/^refs\/heads\//,"",b) }
  /^detached/{ d=1 }
  END{ flush() }')

# branches
br_json=""
while IFS='|' read -r name head date author; do
  [ -n "$name" ] || continue
  ahead=0; behind=0
  if [ "$name" != "$DEFAULT" ]; then
    lr=$(git -C "$REPO" rev-list --left-right --count "$DEFAULT...$name" 2>/dev/null)
    behind=$(echo "$lr" | awk '{print $1+0}'); ahead=$(echo "$lr" | awk '{print $2+0}')
  fi
  br_json="${br_json}${br_json:+,}$(jq -nc --arg n "$name" --arg h "$head" --arg d "$date" --arg a "$author" \
    --argjson ah "$ahead" --argjson bh "$behind" '{name:$n,head:$h,last_commit:$d,last_author:$a,ahead:$ah,behind:$bh}')"
done < <(git -C "$REPO" for-each-ref --format='%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)|%(authorname)' refs/heads)

HEAD=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)
hist="$MAIN_ROOT/session-history"; mkdir -p "$hist"
jq -n --arg gen "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repo "$(basename "$MAIN_ROOT")" \
  --arg def "$DEFAULT" --arg head "$HEAD" \
  --argjson wt "[${wt_json}]" --argjson br "[${br_json}]" \
  '{generated_at:$gen,repo:$repo,default_branch:$def,head:$head,worktrees:$wt,branches:$br}' \
  > "$hist/index.json"
echo "$hist/index.json"
