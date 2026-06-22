#!/usr/bin/env bash
# 把 Claude Code 会话（~/.claude/projects/<encoded>/<id>.jsonl）抽成 digest + 脱敏原文，
# 写进对应项目 session-history/。手动调用，无 hook。依赖 jq、perl。
#   claude-scrape.sh                 # -Current：采当前 cwd 对应项目里 mtime 最新的会话
#   claude-scrape.sh --all           # 扫 ~/.claude/projects/**/*.jsonl 全部
#   claude-scrape.sh --transcript X  # 指定单个 jsonl
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 0; }
PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"

save_one() {
  local tp="$1"
  [ -n "$tp" ] && [ -f "$tp" ] || return 0
  local parsed
  parsed=$(jq -s '
    def usertext($c): if ($c|type)=="string" then $c else ([ $c[]? | select(.type=="text") | .text ] | first) end;
    def istoolresult($c): if ($c|type)=="string" then false else (any($c[]?; .type=="tool_result")) end;
    { id:([.[].sessionId? //empty]|first//""), started_at:([.[].timestamp? //empty]|first//""),
      ended_at:([.[].timestamp? //empty]|last//""),
      branch:([.[].gitBranch? //empty|select(.!=""and .!="HEAD")]|first//""),
      cwd:([.[].cwd? //empty]|first//""), version:([.[].version? //empty]|first//""),
      prompts:[ .[]|select(.type=="user" and .message.role=="user")|select(istoolresult(.message.content)|not)
                |usertext(.message.content)|select(.!=null and (startswith("<")|not)) ],
      files:([ .[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")
               |select(.name=="Edit" or .name=="Write" or .name=="MultiEdit" or .name=="NotebookEdit")|.input.file_path? //empty ]|unique),
      tools:( reduce (.[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")|.name) as $n ({}; .[$n]+=1) )
    }' "$tp" 2>/dev/null)
  [ -n "$parsed" ] || return 0

  local id branch cwd version started ended turns first_prompt
  id=$(printf '%s' "$parsed" | jq -r '.id'); [ -z "$id" ] && id="$(basename "${tp%.jsonl}")"
  branch=$(printf '%s' "$parsed" | jq -r '.branch'); cwd=$(printf '%s' "$parsed" | jq -r '.cwd')
  version=$(printf '%s' "$parsed" | jq -r '.version')
  started=$(printf '%s' "$parsed" | jq -r '.started_at'); ended=$(printf '%s' "$parsed" | jq -r '.ended_at')
  turns=$(printf '%s' "$parsed" | jq -r '.prompts|length'); first_prompt=$(printf '%s' "$parsed" | jq -r '.prompts[0]//""')

  git_info "$cwd" || true
  local root="${GIT_MAIN_ROOT:-$cwd}"; [ -z "$root" ] && root="$(dirname "$tp")"
  [ -n "$branch" ] && GIT_BRANCH="$branch"
  local project; project="$(basename "$root")"
  first_prompt=$(redact_str "$first_prompt" | cut -c1-200)
  local files_rel tools
  files_rel=$(printf '%s' "$parsed" | jq --arg root "$root" '[ .files[] | sub("^"+$root+"/";"") ]')
  tools=$(printf '%s' "$parsed" | jq '.tools')

  local digest
  digest=$(jq -n \
    --argjson schema 1 --arg id "$id" --arg tool "claude-cli" \
    --arg machine "$(hostname)" --arg os "$(os_name)" --arg project "$project" \
    --arg cwd "$cwd" --arg branch "${GIT_BRANCH:-}" --argjson isw "${GIT_IS_WORKTREE:-false}" \
    --arg worktree "${GIT_WORKTREE:-}" --arg head "${GIT_HEAD:-}" --argjson dirty "${GIT_DIRTY:-false}" \
    --arg started "$started" --arg ended "$ended" --argjson turns "${turns:-0}" \
    --arg fp "$first_prompt" --argjson files "$files_rel" --argjson tools "$tools" --arg ver "$version" \
    '{schema:$schema,id:$id,tool:$tool,origin:null,machine:$machine,os:$os,project:$project,
      cwd:$cwd,git:{branch:$branch,is_worktree:$isw,worktree:$worktree,head:$head,dirty:$dirty},
      started_at:$started,ended_at:$ended,turns:$turns,first_prompt:$fp,summary:"",
      files_touched:$files,tools_used:$tools,next_steps:[],cli_version:$ver,transcript_ref:null}')
  local base; base="$(digest_base "$ended" "claude-cli" "$id")"
  digest=$(printf '%s' "$digest" | jq --arg r "session-history/transcripts/$base.jsonl" '.transcript_ref=$r')
  local tmp; tmp="$(mktemp)"; redact < "$tp" > "$tmp"
  write_digest "$base" "$digest" "$tmp" "$root" >/dev/null
  rm -f "$tmp"
  return 0
}

MODE=current; TP=""; CWD="$(pwd)"
while [ $# -gt 0 ]; do case "$1" in
  --all) MODE=all;; --current) MODE=current;;
  --transcript) TP="$2"; MODE=transcript; shift;;
  --cwd) CWD="$2"; shift;;
esac; shift; done

n=0
if [ "$MODE" = transcript ]; then
  save_one "$TP" && n=$((n+1))
elif [ "$MODE" = all ]; then
  while IFS= read -r f; do save_one "$f" && n=$((n+1)); done \
    < <(find "$PROJECTS" -name '*.jsonl' -type f 2>/dev/null | grep -v '/memory/')
else
  enc="$(encode_project "$CWD")"; pd="$PROJECTS/$enc"
  if [ -d "$pd" ]; then
    latest=$(ls -t "$pd"/*.jsonl 2>/dev/null | head -1)
    [ -n "$latest" ] && { save_one "$latest" && n=$((n+1)); }
  fi
fi
echo "claude-scrape: wrote $n digest(s)."
