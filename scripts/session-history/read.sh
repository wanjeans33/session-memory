#!/usr/bin/env bash
# 把本项目 session-history/ 的会话导入当前端（CLI --resume + Desktop sidebar），标题打来源标签。
# 手动命令（由 /session-memory read 调用）。依赖 jq、perl、uuidgen。
#   read.sh --list
#   read.sh --import --ids base1,base2 [--targets cli,desktop]
# 限制：仅同 OS 导入；Codex 为占位非全保真。
# ⚠️ 未在开发机验证；首次在 mac 运行请核对。设计见 DESIGN.md。
set -uo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPTS/capture/_lib.sh"
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 0; }

MODE=list; IDS=""; TARGETS="cli"; CWD="$(pwd)"
PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"
DESK="${DESKTOP_SESSIONS:-$HOME/Library/Application Support/Claude/claude-code-sessions}"
while [ $# -gt 0 ]; do case "$1" in
  --list) MODE=list;; --import) MODE=import;;
  --ids) IDS="$2"; shift;; --targets) TARGETS="$2"; shift;; --cwd) CWD="$2"; shift;;
esac; shift; done

git_info "$CWD" || true
ROOT="${GIT_MAIN_ROOT:-$CWD}"
DIG="$ROOT/session-history/digests"
[ -d "$DIG" ] || { echo "本项目无 session-history/digests。"; exit 0; }

label() { case "$1" in codex) echo codex;; claude-desktop) echo desktop;; claude-cli) echo cli;; *) echo "$1";; esac; }
to_ms() { local iso="$1"; [ -z "$iso" ] && { echo 0; return; }
  local s; s=$(date -u -d "$iso" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" +%s 2>/dev/null || echo 0); echo $((s*1000)); }

if [ "$MODE" = list ]; then
  for f in "$DIG"/*.json; do [ -e "$f" ] || continue
    jq -c --arg base "$(basename "${f%.json}")" '{base:$base, tool:.tool, machine:.machine, ended_at:.ended_at, title:(.title // .first_prompt)}' "$f"
  done | jq -s '.'
  exit 0
fi

[ -n "$IDS" ] || { echo "用 --ids 指定 base（逗号分隔），可先 --list。"; exit 0; }
ENC="$(encode_project "$CWD")"; TPROJ="$PROJECTS/$ENC"; mkdir -p "$TPROJ"
DSCOPE=""
case ",$TARGETS," in *,desktop,*)
  anyl=$(find "$DESK" -name 'local_*.json' -type f 2>/dev/null | head -1)
  [ -n "$anyl" ] && DSCOPE="$(dirname "$anyl")" ;;
esac

done=0
IFS=',' read -ra BASES <<< "$IDS"
for base in "${BASES[@]}"; do
  base="$(printf '%s' "$base" | tr -d ' ')"
  dp="$DIG/$base.json"; [ -f "$dp" ] || { echo "跳过（找不到）：$base"; continue; }
  tool=$(jq -r '.tool' "$dp"); lbl="$(label "$tool")"
  newid="$(uuidgen | tr 'A-Z' 'a-z')"
  title=$(jq -r '(.title // .first_prompt) // "(无标题)"' "$dp")
  branch=$(jq -r '.git.branch // ""' "$dp")
  fp=$(jq -r '.first_prompt // ""' "$dp")
  tref=$(jq -r '.transcript_ref // ""' "$dp")
  srcts=""; [ -n "$tref" ] && [ -f "$ROOT/$tref" ] && srcts="$ROOT/$tref"
  out="$TPROJ/$newid.jsonl"

  if [ -n "$srcts" ] && { [ "$tool" = claude-cli ] || [ "$tool" = claude-desktop ]; }; then
    tagged=0; : > "$out"
    while IFS= read -r ln; do
      if [ "$tagged" -eq 0 ] && printf '%s' "$ln" | grep -q '"type":"user"'; then
        nl=$(printf '%s' "$ln" | jq -c --arg L "($lbl) " '
          if (.type=="user" and .message.role=="user") then
            (if (.message.content|type)=="string" then .message.content=($L+.message.content)
             else (.message.content |= (if length>0 and (map(.type=="text")|any)
               then ( (first(.[]|select(.type=="text"))) as $t | map(if .type=="text" and .text==$t.text then .text=($L+.text) else . end))
               else . end)) end) else . end' 2>/dev/null) || nl="$ln"
        [ -n "$nl" ] && ln="$nl"; tagged=1
      fi
      printf '%s\n' "$ln" >> "$out"
    done < "$srcts"
  else
    note="[导入自 $tool] turns=$(jq -r '.turns' "$dp")。脱敏原文见 $tref。"
    jq -nc --arg fp "($lbl) $fp" --arg id "$newid" --arg cwd "$CWD" --arg br "$branch" --arg ts "$(jq -r '.started_at//""' "$dp")" \
      '{type:"user",message:{role:"user",content:$fp},timestamp:$ts,sessionId:$id,cwd:$cwd,gitBranch:$br,version:"imported"}' > "$out"
    jq -nc --arg note "$note" --arg id "$newid" --arg ts "$(jq -r '.ended_at//""' "$dp")" \
      '{type:"assistant",message:{role:"assistant",content:[{type:"text",text:$note}]},timestamp:$ts,sessionId:$id}' >> "$out"
  fi
  msg="导入 $base → CLI: $out"

  if [ -n "$DSCOPE" ]; then
    luuid="$(uuidgen | tr 'A-Z' 'a-z')"
    jq -n --arg sid "local_$luuid" --arg cli "$newid" --arg cwd "$CWD" --arg br "$branch" \
      --arg title "($lbl) $title" --argjson c "$(to_ms "$(jq -r '.started_at//""' "$dp")")" \
      --argjson la "$(to_ms "$(jq -r '.ended_at//""' "$dp")")" --argjson turns "$(jq -r '.turns//0' "$dp")" \
      '{sessionId:$sid,cliSessionId:$cli,cwd:$cwd,originCwd:$cwd,worktreePath:"",branch:$br,
        title:$title,titleSource:"auto",createdAt:$c,lastActivityAt:$la,model:"claude-opus-4-8",
        isArchived:false,permissionMode:"auto",completedTurns:$turns}' > "$DSCOPE/local_$luuid.json"
    msg="$msg | Desktop: $DSCOPE/local_$luuid.json"
  elif case ",$TARGETS," in *,desktop,*) true;; *) false;; esac; then
    msg="$msg | Desktop: 跳过（未找到现存 local_*.json）"
  fi
  echo "$msg"; done=$((done+1))
done
echo "read: 导入 $done 条。"
