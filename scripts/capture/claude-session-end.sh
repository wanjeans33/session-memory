#!/usr/bin/env bash
# Claude Code SessionEnd hook（macOS/Linux）：把刚结束的会话抽成 digest + 脱敏原文，
# 写进【目标项目】session-history/。依赖 jq、perl。任何错误都静默 exit 0，绝不打断 Claude。
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"

main() {
  local tp="${1:-}" cwd="${2:-}" sid=""
  if [ -z "$tp" ] && [ ! -t 0 ]; then
    local stdin; stdin="$(cat)"
    if [ -n "$stdin" ]; then
      tp=$(printf '%s' "$stdin" | jq -r '.transcript_path // empty' 2>/dev/null)
      [ -z "$cwd" ] && cwd=$(printf '%s' "$stdin" | jq -r '.cwd // empty' 2>/dev/null)
      sid=$(printf '%s' "$stdin" | jq -r '.session_id // empty' 2>/dev/null)
    fi
  fi
  [ -n "$tp" ] && [ -f "$tp" ] || exit 0
  command -v jq >/dev/null 2>&1 || exit 0

  # 单遍 jq 提取核心字段
  local parsed
  parsed=$(jq -s '
    def usertext($c): if ($c|type)=="string" then $c
      else ([ $c[]? | select(.type=="text") | .text ] | first) end;
    def istoolresult($c): if ($c|type)=="string" then false
      else (any($c[]?; .type=="tool_result")) end;
    {
      id:        ([ .[].sessionId? // empty ] | first // ""),
      started_at:([ .[].timestamp? // empty ] | first // ""),
      ended_at:  ([ .[].timestamp? // empty ] | last  // ""),
      branch:    ([ .[].gitBranch? // empty | select(. != "" and . != "HEAD") ] | first // ""),
      cwd:       ([ .[].cwd? // empty ] | first // ""),
      version:   ([ .[].version? // empty ] | first // ""),
      prompts:   [ .[] | select(.type=="user" and .message.role=="user")
                   | select(istoolresult(.message.content)|not)
                   | usertext(.message.content)
                   | select(. != null and (startswith("<")|not)) ],
      files:     ([ .[] | select(.type=="assistant") | .message.content[]?
                   | select(.type=="tool_use")
                   | select(.name=="Edit" or .name=="Write" or .name=="MultiEdit" or .name=="NotebookEdit")
                   | .input.file_path? // empty ] | unique),
      tools:     ( reduce ( .[] | select(.type=="assistant") | .message.content[]?
                   | select(.type=="tool_use") | .name ) as $n ({}; .[$n] += 1) )
    }' "$tp" 2>/dev/null)
  [ -n "$parsed" ] || exit 0

  local id branch tcwd version started ended turns first_prompt
  id=$(printf '%s' "$parsed" | jq -r '.id'); [ -z "$id" ] && id="$sid"
  [ -z "$id" ] && id="$(basename "${tp%.jsonl}")"
  branch=$(printf '%s' "$parsed" | jq -r '.branch')
  tcwd=$(printf '%s' "$parsed" | jq -r '.cwd')
  version=$(printf '%s' "$parsed" | jq -r '.version')
  started=$(printf '%s' "$parsed" | jq -r '.started_at')
  ended=$(printf '%s' "$parsed" | jq -r '.ended_at')
  turns=$(printf '%s' "$parsed" | jq -r '.prompts | length')
  first_prompt=$(printf '%s' "$parsed" | jq -r '.prompts[0] // ""')
  [ -z "$cwd" ] && cwd="$tcwd"

  git_info "$cwd" || true
  local root="${GIT_MAIN_ROOT:-$cwd}"; [ -z "$root" ] && root="$(dirname "$tp")"
  [ -n "$branch" ] && GIT_BRANCH="$branch"
  local project; project="$(basename "$root")"

  # first_prompt 脱敏 + 截断
  first_prompt=$(redact_str "$first_prompt" | cut -c1-200)
  # files 相对化
  local files_rel
  files_rel=$(printf '%s' "$parsed" | jq --arg root "$root" '[ .files[] | sub("^" + $root + "/"; "") ]')
  local tools; tools=$(printf '%s' "$parsed" | jq '.tools')

  local digest
  digest=$(jq -n \
    --argjson schema 1 --arg id "$id" --arg tool "claude-cli" \
    --arg machine "$(hostname)" --arg os "$(os_name)" --arg project "$project" \
    --arg cwd "$cwd" --arg branch "${GIT_BRANCH:-}" --argjson isw "${GIT_IS_WORKTREE:-false}" \
    --arg worktree "${GIT_WORKTREE:-}" --arg head "${GIT_HEAD:-}" --argjson dirty "${GIT_DIRTY:-false}" \
    --arg started "$started" --arg ended "$ended" --argjson turns "${turns:-0}" \
    --arg fp "$first_prompt" --argjson files "$files_rel" --argjson tools "$tools" \
    --arg ver "$version" \
    '{schema:$schema,id:$id,tool:$tool,origin:null,machine:$machine,os:$os,project:$project,
      cwd:$cwd,git:{branch:$branch,is_worktree:$isw,worktree:$worktree,head:$head,dirty:$dirty},
      started_at:$started,ended_at:$ended,turns:$turns,first_prompt:$fp,summary:"",
      files_touched:$files,tools_used:$tools,next_steps:[],cli_version:$ver,transcript_ref:null}')

  local base; base="$(digest_base "$ended" "claude-cli" "$id")"
  digest=$(printf '%s' "$digest" | jq --arg r "session-history/transcripts/$base.jsonl" '.transcript_ref=$r')

  local tmp; tmp="$(mktemp)"; redact < "$tp" > "$tmp"
  write_digest "$base" "$digest" "$tmp" "$root" >/dev/null
  rm -f "$tmp"
}
main "${1:-}" "${2:-}" 2>/dev/null || true
exit 0
