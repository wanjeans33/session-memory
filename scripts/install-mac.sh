#!/usr/bin/env bash
# Connect this memory repository to Claude Code on macOS:
#   1) Symlink ~/.claude/projects/<encoded>/memory -> <repo>/memory
#   2) Add an @import for this repository's CLAUDE.md to ~/.claude/CLAUDE.md
#   3) Merge settings/settings.shared.json into ~/.claude/settings.json (requires jq)
#   4) Install hooks that pull at SessionStart and commit/push this repository at SessionEnd
# Session capture is manual via /session-memory save; no capture hooks are installed.
# Idempotent: safe to re-run. settings.json is backed up as settings.json.bak before changes.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/.." && pwd)"
CLAUDE="$HOME/.claude"

# Absolute path -> Claude project directory name (spaces, :, /, _, and . become -)
encode() { printf '%s' "$1" | sed 's/[ :/_.]/-/g'; }
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
echo "✓ Memory symlink: $PROJ_MEM -> $REPO/memory"

# Skill symlinks: Claude uses ~/.claude/skills and Codex uses ~/.agents/skills.
# Both clients point to the same repository copy to prevent version drift.
if [ -d "$REPO/skills" ]; then
  for skills_dst in "$CLAUDE/skills" "$HOME/.agents/skills"; do
    mkdir -p "$skills_dst"
    for sk in "$REPO"/skills/*/; do
      [ -d "$sk" ] || continue
      name="$(basename "$sk")"
      link="$skills_dst/$name"
      [ -L "$link" ] && rm "$link"
      [ -d "$link" ] && rm -rf "$link"
      ln -s "${sk%/}" "$link"
      echo "✓ Skill symlink: $link -> ${sk%/}"
    done
  done
  # Remove the legacy session-share symlink, renamed to session-memory.
  [ -L "$CLAUDE/skills/session-share" ] && { rm "$CLAUDE/skills/session-share"; echo "✓ Removed legacy skill symlink: session-share"; } || true
fi

# CLAUDE.md import
USER_MD="$CLAUDE/CLAUDE.md"
LINE="@$REPO/CLAUDE.md"
if ! grep -qF "$LINE" "$USER_MD" 2>/dev/null; then
  printf '\n# Cross-device shared memory (installed by claude-session-memory)\n%s\n' "$LINE" >> "$USER_MD"
  echo "✓ Added import to ~/.claude/CLAUDE.md"
else
  echo "• ~/.claude/CLAUDE.md already contains the import; skipped"
fi

# settings.json merge and hooks (requires jq)
SETTINGS="$CLAUDE/settings.json"
START_CMD="bash \"$REPO/scripts/memory-sync/sync.sh\" --pull-only"
END_CMD="bash \"$REPO/scripts/memory-sync/sync.sh\""
if command -v jq >/dev/null 2>&1; then
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak" || echo '{}' > "$SETTINGS"
  TMP="$(mktemp)"
  jq \
    --slurpfile shared "$REPO/settings/settings.shared.json" \
    --arg start "$START_CMD" --arg end "$END_CMD" '
    ($shared[0] + .) as $merged                       # shared settings do not override existing keys
    | $merged
    | .hooks //= {}
    | .hooks.SessionStart //= []
    | .hooks.SessionEnd  //= []
    | (if [.hooks.SessionStart[].hooks[].command] | index($start) then .
        else .hooks.SessionStart += [{hooks:[{type:"command",command:$start}]}] end)
    | (if [.hooks.SessionEnd[].hooks[].command] | index($end) then .
        else .hooks.SessionEnd += [{hooks:[{type:"command",command:$end}]}] end)
    # Capture is manual: remove legacy capture hooks while preserving memory-sync hooks.
    | (.hooks.SessionEnd |= map(select((.hooks // [] | map(.command) | map(test("claude-session-end|claude-scrape|/session-history/capture/")) | any) | not)))
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
  echo "✓ Merged settings.json and installed memory-sync hooks (backup: settings.json.bak)"
  echo "• Session capture is manual: Claude uses /session-memory save; Codex uses \$session-memory save (or scripts/session-history/save.sh)"
else
  echo "⚠ jq was not found; skipped settings/hooks merge. Install it (brew install jq) and rerun, or edit ~/.claude/settings.json manually."
fi

echo ""
echo "Done. Start a new Claude Code or Codex session to load the skills."
