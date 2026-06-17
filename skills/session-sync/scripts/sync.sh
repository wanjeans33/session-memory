#!/usr/bin/env bash
# Back up / restore Claude Code session history to a private git repo.
#   sync.sh setup <git-url>
#   sync.sh backup
#   sync.sh restore           # additive (never clobbers local)
#   sync.sh restore --force   # overwrite local with repo version
#   sync.sh status
set -euo pipefail

ACTION="${1:-status}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PROJECTS="$CLAUDE_DIR/projects"
REPO="$CLAUDE_DIR/session-backup"
REPO_PROJECTS="$REPO/projects"
THIS_HOST="$(hostname)"
INCLUDE_TOOL_RESULTS="${INCLUDE_TOOL_RESULTS:-0}"

has_repo() { [ -d "$REPO/.git" ]; }

EXCLUDES=( --exclude='*.jpg' --exclude='*.jpeg' --exclude='*.png' \
           --exclude='*.gif' --exclude='*.pdf' --exclude='*.webp' )
[ "$INCLUDE_TOOL_RESULTS" = "1" ] || EXCLUDES+=( --exclude='tool-results/' )

case "$ACTION" in
  setup)
    REMOTE="${2:-}"
    if has_repo; then echo "Already set up at $REPO"; git -C "$REPO" remote -v; exit 0; fi
    [ -n "$REMOTE" ] || { echo "Need: sync.sh setup <git-url>  (create an EMPTY private GitHub repo first)"; exit 1; }
    [ -e "$REPO" ] && { echo "$REPO exists but is not a git repo; remove/rename it first"; exit 1; }
    git clone "$REMOTE" "$REPO"
    printf '* -text\n' > "$REPO/.gitattributes"
    mkdir -p "$REPO_PROJECTS"; : > "$REPO_PROJECTS/.gitkeep"
    [ -f "$REPO/README.md" ] || printf '# Claude Code session backup\n\nManaged by the session-sync skill. Holds transcripts + memory from ~/.claude/projects.\n' > "$REPO/README.md"
    git -C "$REPO" add -A
    git -C "$REPO" diff --cached --quiet || git -C "$REPO" commit -m "init session-backup from $THIS_HOST"
    git -C "$REPO" push -u origin HEAD
    echo "Setup complete: $REPO -> $REMOTE"
    ;;

  backup)
    has_repo || { echo "Not set up. Run: sync.sh setup <git-url>"; exit 1; }
    git -C "$REPO" pull --no-edit || true
    mkdir -p "$REPO_PROJECTS"
    [ -d "$PROJECTS" ] && rsync -a "${EXCLUDES[@]}" "$PROJECTS/" "$REPO_PROJECTS/"
    git -C "$REPO" add -A
    if git -C "$REPO" diff --cached --quiet; then echo "No changes to back up."; exit 0; fi
    git -C "$REPO" commit -m "backup from $THIS_HOST at $(date '+%Y-%m-%d %H:%M:%S')"
    git -C "$REPO" push || { git -C "$REPO" pull --no-edit && git -C "$REPO" push; }
    echo "Backed up to remote."
    ;;

  restore)
    has_repo || { echo "Not set up. Run setup first."; exit 1; }
    git -C "$REPO" pull --no-edit || true
    if [ "${2:-}" = "--force" ] || [ "${FORCE:-0}" = "1" ]; then UPD=(); else UPD=(--ignore-existing); fi
    [ -d "$REPO_PROJECTS" ] && rsync -a "${UPD[@]}" "${EXCLUDES[@]}" "$REPO_PROJECTS/" "$PROJECTS/"
    echo "Restore complete."
    ;;

  status)
    echo "Claude dir : $CLAUDE_DIR"
    echo "Backup repo: $REPO"
    if has_repo; then
      git -C "$REPO" remote get-url origin || true
      git -C "$REPO" log -1 --format='last commit: %h %ci (%an)' || true
      echo "transcripts in repo: $(find "$REPO_PROJECTS" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
    else
      echo "Not set up yet. Run: sync.sh setup <git-url>"
    fi
    ;;

  *)
    echo "Unknown action: $ACTION (use setup|backup|restore|status)"; exit 1
    ;;
esac
