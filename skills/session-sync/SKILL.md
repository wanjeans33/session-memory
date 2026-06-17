---
name: session-sync
description: Back up and restore Claude Code session history (conversation transcripts + memory files) to a private GitHub repo, so history is available across machines (Mac/Windows) and tools (CLI/Desktop). Use when the user wants to back up sessions, restore them on another machine, sync Claude Code history across computers, or set up such a backup.
---

# Session Sync — back up Claude Code history to a private GitHub repo

Backs up `~/.claude/projects/**` (session transcripts `*.jsonl` + `memory/`) to a
private git repo, and restores them on any machine. Heavy tool-result blobs
(images / PDFs) are excluded by default.

## Scripts

- Windows: `scripts/sync.ps1`
- macOS / Linux: `scripts/sync.sh`

Actions: `setup` (one-time per machine), `backup`, `restore`, `status`.

## How to run

Detect the OS and run the matching script from this skill's directory.

- Windows (PowerShell):
  `powershell -ExecutionPolicy Bypass -File "<skill>/scripts/sync.ps1" <action> [args]`
- macOS / Linux:
  `bash "<skill>/scripts/sync.sh" <action> [args]`

### First-time setup (per machine)

1. Create an **EMPTY private repo** on GitHub (no README), e.g.
   `your-name/claude-session-backup`. `gh` is not installed on this machine, so
   create it via the GitHub website and copy its clone URL (HTTPS or SSH).
2. Run setup with that URL:
   - Windows: `sync.ps1 setup -Remote <git-url>`
   - macOS:   `sync.sh setup <git-url>`
   This clones the repo to `~/.claude/session-backup/` and pushes an initial commit.

### Back up (on the machine whose sessions you want to save)

- Windows: `sync.ps1 backup`
- macOS:   `sync.sh backup`

Pulls latest, copies transcripts + memory into the repo, commits, pushes.

### Restore (on another machine, to pull others' history in)

- Windows: `sync.ps1 restore`   (additive — never overwrites existing local files)
- macOS:   `sync.sh restore`

Add `-Force` (PowerShell) / `--force` (bash) to overwrite local files with the repo version.

### Status

- `sync.ps1 status` / `sync.sh status` — shows repo path, remote, last commit, transcript count.

## Important caveats (state these to the user)

- This syncs session **content** so every machine can read / search the full
  history. It does NOT make one session "live" on two machines at once.
- **Cross-OS resume:** each project's folder name encodes the absolute path, which
  differs between Windows (`E--Github-project-draft`) and macOS
  (`-Users-you-Github-project-draft`). A Windows session restored on macOS is
  readable but will NOT appear under `claude --resume` for that project until its
  folder is path-translated. See `reference/path-map.example.json` — wiring this in
  is an optional phase 2.
- **Desktop sidebar:** restored transcripts appear in the **CLI** automatically
  (`claude --resume`). For them to show in the **Desktop** sidebar you still need
  `/desktop` per session (or descriptor injection — optional phase 2).
- Don't back up a session while it is actively being written, to avoid conflict copies.
- Secrets are never synced: only `~/.claude/projects/**` is copied — not
  `.claude.json`, not `~/.claude/sessions/` (live PID registry), not Desktop AppData tokens.
- Include heavy tool-result blobs with `-IncludeToolResults` (PowerShell) /
  `INCLUDE_TOOL_RESULTS=1` (bash) only if you really want them.

## Automation (optional)

To back up automatically, schedule `... backup` via Windows Task Scheduler, or
cron / launchd on macOS. Ask the user before setting this up.
