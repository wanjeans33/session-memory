#!/usr/bin/env bash
# 扫描 Claude Desktop 的 Claude Code 会话（macOS: ~/Library/Application Support/Claude/claude-code-sessions），
# 转 digest + 脱敏原文，按 cwd 归到对应项目仓库 session-history/。依赖 jq、perl。
#   desktop-scrape.sh            # 增量（游标 ~/.claude/.desktop-scrape-cursor）
#   desktop-scrape.sh --all      # 全量
# Desktop 的 local_*.json 是元数据；真 transcript 在 ~/.claude/projects/<encoded>/<cliSessionId>.jsonl。
# 去重：同会话已被 CLI hook 采过（同 id 的 claude-cli digest）则跳过。
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 0; }

ALL=false; FORCE=false
for a in "$@"; do case "$a" in --all) ALL=true;; --force) FORCE=true;; esac; done
SESS="${DESKTOP_SESSIONS:-$HOME/Library/Application Support/Claude/claude-code-sessions}"
PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"
[ -d "$SESS" ] || { echo "no Desktop sessions dir: $SESS"; exit 0; }
CURSOR_FILE="$HOME/.claude/.desktop-scrape-cursor"
cursor=0
[ "$ALL" = false ] && [ -f "$CURSOR_FILE" ] && cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)

iso_from_ms() { local ms="$1"; [ -z "$ms" ] || [ "$ms" = "null" ] && return; local s=$((ms/1000));
  date -u -r "$s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; }

written=0; deduped=0; skipped=0; newcursor=$cursor
while IFS= read -r mf; do
  [ -n "$mf" ] || continue
  mt=$(stat -f %m "$mf" 2>/dev/null || stat -c %Y "$mf" 2>/dev/null || echo 0)
  if [ "$ALL" = false ] && [ "$mt" -le "$cursor" ]; then continue; fi
  [ "$mt" -gt "$newcursor" ] && newcursor=$mt

  cliId=$(jq -r '.cliSessionId // empty' "$mf" 2>/dev/null); [ -n "$cliId" ] || continue
  wt=$(jq -r '.worktreePath // ""' "$mf"); cwd0=$(jq -r '.cwd // ""' "$mf")
  cwd="$wt"; [ -z "$cwd" ] && cwd="$cwd0"; [ -n "$cwd" ] || continue
  title=$(jq -r '.title // ""' "$mf"); mbranch=$(jq -r '.branch // ""' "$mf")
  cturns=$(jq -r '.completedTurns // 0' "$mf")
  started=$(iso_from_ms "$(jq -r '.createdAt // 0' "$mf")")
  ended=$(iso_from_ms "$(jq -r '.lastActivityAt // 0' "$mf")")

  git_info "$cwd" || { skipped=$((skipped+1)); continue; }
  [ -n "${GIT_MAIN_ROOT:-}" ] || { skipped=$((skipped+1)); continue; }
  root="$GIT_MAIN_ROOT"; project="$(basename "$root")"

  short=$(printf '%s' "$cliId" | tr -cd 'A-Za-z0-9' | cut -c1-8)
  if [ "$FORCE" = false ] && ls "$root"/session-history/digests/*-claude-cli-"$short".json >/dev/null 2>&1; then
    deduped=$((deduped+1)); continue
  fi

  tr=$(find "$PROJECTS" -name "$cliId.jsonl" -type f 2>/dev/null | head -1)
  files_rel='[]'; tools='{}'; turns="$cturns"; first_prompt="$title"; version=""; redacted_file=""
  if [ -n "$tr" ]; then
    parsed=$(jq -s '
      def usertext($c): if ($c|type)=="string" then $c else ([ $c[]? | select(.type=="text") | .text ] | first) end;
      def istoolresult($c): if ($c|type)=="string" then false else (any($c[]?; .type=="tool_result")) end;
      { started:([.[].timestamp?//empty]|first//""), ended:([.[].timestamp?//empty]|last//""),
        branch:([.[].gitBranch?//empty|select(.!=""and .!="HEAD")]|first//""), version:([.[].version?//empty]|first//""),
        prompts:[ .[]|select(.type=="user" and .message.role=="user")|select(istoolresult(.message.content)|not)
                  |usertext(.message.content)|select(.!=null and (startswith("<")|not)) ],
        files:([ .[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")
                 |select(.name=="Edit" or .name=="Write" or .name=="MultiEdit" or .name=="NotebookEdit")|.input.file_path?//empty ]|unique),
        tools:( reduce (.[]|select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")|.name) as $n ({}; .[$n]+=1) )
      }' "$tr" 2>/dev/null)
    if [ -n "$parsed" ]; then
      tcount=$(printf '%s' "$parsed" | jq -r '.prompts|length')
      [ "$tcount" -gt 0 ] && turns="$tcount"
      fp=$(printf '%s' "$parsed" | jq -r '.prompts[0] // ""'); [ -n "$fp" ] && first_prompt="$fp"
      s=$(printf '%s' "$parsed" | jq -r '.started'); [ -n "$s" ] && started="$s"
      e=$(printf '%s' "$parsed" | jq -r '.ended'); [ -n "$e" ] && ended="$e"
      tb=$(printf '%s' "$parsed" | jq -r '.branch'); [ -n "$tb" ] && GIT_BRANCH="$tb"
      version=$(printf '%s' "$parsed" | jq -r '.version')
      files_rel=$(printf '%s' "$parsed" | jq --arg root "$root" '[ .files[] | sub("^"+$root+"/";"") ]')
      tools=$(printf '%s' "$parsed" | jq '.tools')
      redacted_file="$(mktemp)"; redact < "$tr" > "$redacted_file"
    fi
  fi
  [ -n "$mbranch" ] && [ "$mbranch" != "HEAD" ] && GIT_BRANCH="$mbranch"
  first_prompt=$(redact_str "$first_prompt" | cut -c1-200)

  digest=$(jq -n \
    --argjson schema 1 --arg id "$cliId" --arg tool "claude-desktop" --arg origin "desktop" \
    --arg machine "$(hostname)" --arg os "$(os_name)" --arg project "$project" \
    --arg cwd "$cwd" --arg branch "${GIT_BRANCH:-}" --argjson isw "${GIT_IS_WORKTREE:-false}" \
    --arg worktree "${GIT_WORKTREE:-}" --arg head "${GIT_HEAD:-}" --argjson dirty "${GIT_DIRTY:-false}" \
    --arg started "$started" --arg ended "$ended" --argjson turns "${turns:-0}" \
    --arg fp "$first_prompt" --arg title "$title" --argjson files "$files_rel" --argjson tools "$tools" --arg cli "$version" \
    '{schema:$schema,id:$id,tool:$tool,origin:$origin,machine:$machine,os:$os,project:$project,
      cwd:$cwd,git:{branch:$branch,is_worktree:$isw,worktree:$worktree,head:$head,dirty:$dirty},
      started_at:$started,ended_at:$ended,turns:$turns,first_prompt:$fp,title:$title,summary:"",
      files_touched:$files,tools_used:$tools,next_steps:[],cli_version:$cli,transcript_ref:null}')
  base="$(digest_base "$ended" "claude-desktop" "$cliId")"
  [ -n "$redacted_file" ] && digest=$(printf '%s' "$digest" | jq --arg r "session-history/transcripts/$base.jsonl" '.transcript_ref=$r')
  write_digest "$base" "$digest" "$redacted_file" "$root" >/dev/null
  [ -n "$redacted_file" ] && rm -f "$redacted_file"
  written=$((written+1))
done < <(find "$SESS" -name 'local_*.json' -type f 2>/dev/null | while read -r p; do echo "$(stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null) $p"; done | sort -n | cut -d' ' -f2-)

echo "$newcursor" > "$CURSOR_FILE"
echo "desktop-scrape: wrote $written, deduped $deduped, skipped $skipped (non-git)."
