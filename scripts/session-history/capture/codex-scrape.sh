#!/usr/bin/env bash
# 扫描 Codex CLI rollout 会话（~/.codex/sessions/**/rollout-*.jsonl），转 digest + 脱敏原文，
# 按各自 cwd 归到对应项目仓库 session-history/。依赖 jq、perl。
#   codex-scrape.sh            # 增量（游标 ~/.claude/.codex-scrape-cursor）
#   codex-scrape.sh --all      # 全量重扫
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 0; }

ALL=false; [ "${1:-}" = "--all" ] && ALL=true
SESS="${CODEX_SESSIONS:-$HOME/.codex/sessions}"
[ -d "$SESS" ] || { echo "no codex sessions dir: $SESS"; exit 0; }
CURSOR_FILE="$HOME/.claude/.codex-scrape-cursor"
cursor=0
[ "$ALL" = false ] && [ -f "$CURSOR_FILE" ] && cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)

written=0; skipped=0; newcursor=$cursor
# 按 mtime 排序遍历
while IFS= read -r file; do
  [ -n "$file" ] || continue
  mt=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || echo 0)
  if [ "$ALL" = false ] && [ "$mt" -le "$cursor" ]; then continue; fi
  [ "$mt" -gt "$newcursor" ] && newcursor=$mt

  parsed=$(jq -s '
    def realuser($t): ($t != null) and (($t|ltrimstr(" ")|ascii_downcase) as $s
      | ([ "# agents.md","<instructions","<permissions","<user_instructions","<environment_context","<system","<context" ]
         | any(. as $p | $s | startswith($p)) | not));
    (.[] | select(.type=="session_meta") | .payload) as $m
    | {
        id: ($m.id // ""), cwd: ($m.cwd // ""), origin: ($m.originator // ""), cli: ($m.cli_version // ""),
        started_at: ([ .[].timestamp? // empty ] | first // ""),
        ended_at:   ([ .[].timestamp? // empty ] | last  // ""),
        prompts: [ .[] | select(.type=="response_item") | .payload
                   | select(.type=="message" and .role=="user")
                   | ([ .content[]? | select(.type=="input_text") | .text ] | first)
                   | select(realuser(.)) ],
        files: ([ .[] | select(.type=="response_item") | .payload
                  | select(.type=="custom_tool_call" and .name=="apply_patch")
                  | .input | split("\n")[] | capture("^\\*\\*\\* (?:Add|Update|Delete) File: (?<p>.+)$") | .p ] | unique),
        tools: ( reduce ( .[] | select(.type=="response_item") | .payload
                  | select(.type=="function_call" or .type=="custom_tool_call") | .name ) as $n ({}; .[$n] += 1) )
      }' "$file" 2>/dev/null)
  [ -n "$parsed" ] || continue

  cwd=$(printf '%s' "$parsed" | jq -r '.cwd')
  git_info "$cwd" || { skipped=$((skipped+1)); continue; }
  [ -n "${GIT_MAIN_ROOT:-}" ] || { skipped=$((skipped+1)); continue; }
  root="$GIT_MAIN_ROOT"; project="$(basename "$root")"

  id=$(printf '%s' "$parsed" | jq -r '.id'); [ -z "$id" ] && id="$(basename "${file%.jsonl}")"
  origin=$(printf '%s' "$parsed" | jq -r '.origin')
  cli=$(printf '%s' "$parsed" | jq -r '.cli')
  started=$(printf '%s' "$parsed" | jq -r '.started_at')
  ended=$(printf '%s' "$parsed" | jq -r '.ended_at')
  turns=$(printf '%s' "$parsed" | jq -r '.prompts | length')
  first_prompt=$(printf '%s' "$parsed" | jq -r '.prompts[0] // ""')
  first_prompt=$(redact_str "$first_prompt" | cut -c1-200)
  files_rel=$(printf '%s' "$parsed" | jq --arg root "$root" '[ .files[] | sub("^" + $root + "/"; "") ]')
  tools=$(printf '%s' "$parsed" | jq '.tools')

  digest=$(jq -n \
    --argjson schema 1 --arg id "$id" --arg tool "codex" --arg origin "$origin" \
    --arg machine "$(hostname)" --arg os "$(os_name)" --arg project "$project" \
    --arg cwd "$cwd" --arg branch "${GIT_BRANCH:-}" --argjson isw "${GIT_IS_WORKTREE:-false}" \
    --arg worktree "${GIT_WORKTREE:-}" --arg head "${GIT_HEAD:-}" --argjson dirty "${GIT_DIRTY:-false}" \
    --arg started "$started" --arg ended "$ended" --argjson turns "${turns:-0}" \
    --arg fp "$first_prompt" --argjson files "$files_rel" --argjson tools "$tools" --arg cli "$cli" \
    '{schema:$schema,id:$id,tool:$tool,origin:$origin,machine:$machine,os:$os,project:$project,
      cwd:$cwd,git:{branch:$branch,is_worktree:$isw,worktree:$worktree,head:$head,dirty:$dirty},
      started_at:$started,ended_at:$ended,turns:$turns,first_prompt:$fp,summary:"",
      files_touched:$files,tools_used:$tools,next_steps:[],cli_version:$cli,transcript_ref:null}')
  base="$(digest_base "$ended" "codex" "$id")"
  digest=$(printf '%s' "$digest" | jq --arg r "session-history/transcripts/$base.jsonl" '.transcript_ref=$r')
  tmp="$(mktemp)"; redact < "$file" > "$tmp"
  write_digest "$base" "$digest" "$tmp" "$root" >/dev/null
  rm -f "$tmp"
  written=$((written+1))
done < <(find "$SESS" -name 'rollout-*.jsonl' -type f | while read -r p; do echo "$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null) $p"; done | sort -n | cut -d' ' -f2-)

echo "$newcursor" > "$CURSOR_FILE"
echo "codex-scrape: wrote $written digest(s), skipped $skipped (non-git)."
