#!/usr/bin/env bash
# 在 macOS 上把 Claude Code 接入这个记忆仓库：
#   1) 软链接：~/.claude/projects/<encoded>/memory -> <repo>/memory
#   2) 在 ~/.claude/CLAUDE.md 写入 @import 引用仓库 CLAUDE.md（全局规则）
#   3) 合并 settings/settings.shared.json 进 ~/.claude/settings.json（需要 jq）
#   4) 安装 hooks：SessionStart 拉取 / SessionEnd 归档并推送 / SessionEnd 采集会话
# 采集范围用环境变量 CAPTURE_SCOPE 控制：global（默认，所有项目）| repo（按仓库 enable-capture-here.sh）
#   例：CAPTURE_SCOPE=repo bash scripts/install-mac.sh
# 幂等：可重复运行。修改 settings.json 前会备份为 settings.json.bak。
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/.." && pwd)"
CLAUDE="$HOME/.claude"

# 绝对路径 -> Claude 项目文件夹名（: / _ . 都变成 -）
encode() { printf '%s' "$1" | sed 's/[:/_.]/-/g'; }
ENCODED="$(encode "$REPO")"
PROJ_MEM="$CLAUDE/projects/$ENCODED/memory"

mkdir -p "$(dirname "$PROJ_MEM")" "$REPO/memory"
if [ -L "$PROJ_MEM" ]; then
  rm "$PROJ_MEM"
elif [ -d "$PROJ_MEM" ]; then
  cp -a "$PROJ_MEM/." "$REPO/memory/" 2>/dev/null || true
  rm -rf "$PROJ_MEM"
fi
ln -s "$REPO/memory" "$PROJ_MEM"
echo "✓ 记忆软链接: $PROJ_MEM -> $REPO/memory"

# 技能软链接：~/.claude/skills/<name> -> <repo>/skills/<name>
if [ -d "$REPO/skills" ]; then
  mkdir -p "$CLAUDE/skills"
  for sk in "$REPO"/skills/*/; do
    [ -d "$sk" ] || continue
    name="$(basename "$sk")"
    link="$CLAUDE/skills/$name"
    [ -L "$link" ] && rm "$link"
    [ -d "$link" ] && rm -rf "$link"
    ln -s "${sk%/}" "$link"
    echo "✓ 技能软链接: $link -> ${sk%/}"
  done
fi

# CLAUDE.md import
USER_MD="$CLAUDE/CLAUDE.md"
LINE="@$REPO/CLAUDE.md"
if ! grep -qF "$LINE" "$USER_MD" 2>/dev/null; then
  printf '\n# 多端同步的全局记忆（由 claude-session-memory 安装）\n%s\n' "$LINE" >> "$USER_MD"
  echo "✓ 已在 ~/.claude/CLAUDE.md 写入 import"
else
  echo "• ~/.claude/CLAUDE.md 已包含 import，跳过"
fi

# settings.json 合并 + hooks（需要 jq）
SETTINGS="$CLAUDE/settings.json"
START_CMD="bash \"$REPO/scripts/sync.sh\" --pull-only"
END_CMD="bash \"$REPO/scripts/sync.sh\""
CAPTURE_CMD="bash \"$REPO/scripts/capture/claude-session-end.sh\""
# 采集范围：global（默认，所有项目）/ repo（不装全局，用 enable-capture-here.sh 按仓库启用）
SCOPE="${CAPTURE_SCOPE:-global}"
ADDCAP=true; [ "$SCOPE" = repo ] && ADDCAP=false
if command -v jq >/dev/null 2>&1; then
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak" || echo '{}' > "$SETTINGS"
  TMP="$(mktemp)"
  jq \
    --slurpfile shared "$REPO/settings/settings.shared.json" \
    --arg start "$START_CMD" --arg end "$END_CMD" --arg cap "$CAPTURE_CMD" --argjson addcap "$ADDCAP" '
    ($shared[0] + .) as $merged                       # shared 不覆盖已有键
    | $merged
    | .hooks //= {}
    | .hooks.SessionStart //= []
    | .hooks.SessionEnd  //= []
    | (if [.hooks.SessionStart[].hooks[].command] | index($start) then .
        else .hooks.SessionStart += [{hooks:[{type:"command",command:$start}]}] end)
    | (if [.hooks.SessionEnd[].hooks[].command] | index($end) then .
        else .hooks.SessionEnd += [{hooks:[{type:"command",command:$end}]}] end)
    | (if $addcap then
        (if [.hooks.SessionEnd[].hooks[]?.command] | index($cap) then .
          else .hooks.SessionEnd += [{hooks:[{type:"command",command:$cap}]}] end)
       else
        (.hooks.SessionEnd |= map(select((.hooks // [] | map(.command) | index($cap)) | not)))
       end)
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
  echo "✓ 已合并 settings.json 并安装 hooks（备份在 settings.json.bak）"
  if [ "$ADDCAP" = true ]; then
    echo "✓ 采集范围：global —— 所有项目会话结束都会生成 session-history/"
  else
    echo "• 采集范围：repo —— 未装全局采集 hook。在想启用的仓库里运行：bash \"$REPO/scripts/enable-capture-here.sh\""
  fi
else
  echo "⚠ 未找到 jq，跳过 settings/hooks 合并。请手动安装 jq（brew install jq）后重跑，或手动编辑 ~/.claude/settings.json。"
fi

echo ""
echo "完成。新开一个 Claude Code 会话即可生效。"
