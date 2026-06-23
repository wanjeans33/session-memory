# claude-session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![platform](https://img.shields.io/badge/Windows-%E2%9C%85%20tested-success)
![platform](https://img.shields.io/badge/macOS%20%2F%20Linux-%E2%9A%A0%EF%B8%8F%20scripts%20ready%2C%20needs%20testing-orange)

[Chinese](README.md) · **English**

Sync Claude Code's **memory** across **Mac / Windows / iPhone**: your rules & preferences
(`CLAUDE.md`) and accumulated facts (`memory/`). It also distills sessions from every endpoint
into **per-project progress records** (`session-history/`, see "Multi-endpoint session history").

Core idea: **use one git repo as the single source of truth**, and let Claude Code read/write
those files **in place** via symlinks / directory junctions; git handles cross-machine sync.
This is also the only way to reach iPhone (see below).

> 🧩 **This is a public template repository.** Do **not** store your personal memory in this
> public repo. The right way: click **Use this template** (or fork) to create **your own repo and
> set it Private**, then clone it and run the installer — your memory syncs to **your private
> repo**, not here. See "Quick start" below.
>
> ⚠️ **The repo holding your personal memory MUST be private.** After install, the memory-sync
> hooks **auto commit + push** your `CLAUDE.md` / `memory/` facts to it. `.gitignore` already
> excludes `.credentials.json` and similar — **never** commit any token/secret.

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Windows (`.ps1`) | ✅ End-to-end tested | PowerShell 5.1+ |
| macOS / Linux (`.sh`) | ⚠️ Scripts ready, community testing wanted | Needs `jq` (`brew install jq`); some features use `perl`/`uuidgen` |
| iPhone | ✅ Cloud / remote | See the "iPhone" section |

---

## What gets synced

| Data | Portable? | Notes |
|---|---|---|
| `CLAUDE.md` (rules/prefs) | ✅ | Each machine's `~/.claude/CLAUDE.md` references it via `@import` |
| `memory/` (MEMORY.md + fact files) | ✅ | Symlinked/junctioned to this repo |
| `settings/settings.shared.json` | ⚠️ | Curated, portable settings merged into local settings.json |
| `session-history/` (inside each project) | ⚠️ | Per-project session digests + redacted transcripts; lives in the **target project** repo, not here |
| Credentials `.credentials.json` | ❌ | Never synced |

### Why there is no cross-OS resume
Each OS encodes a project's absolute path into a different folder name (`E:\proj` → `E--proj`
vs `/Users/x/proj`), and transcripts embed absolute paths, so the same conversation cannot be
recognized as resumable on another machine/OS. Instead of real-time resume, we distill each
session into a **searchable progress digest** (see "Multi-endpoint session history").

---

## Quick start

### 0. Create your own **private** repo from this template
On GitHub, click **Use this template → Create a new repository** and set **Visibility = Private**
(or fork it, then make it private in Settings). Name it whatever you like.

> Why it must be private: after install, the memory-sync hooks **auto commit + push** your
> `CLAUDE.md` / `memory/` facts to this repo. It must be **your** private repo — never this public template.
>
> Prefer not to use the GitHub template? Start from scratch: `git init` locally, then
> `gh repo create <name> --private --source . --push`.

### 1. First machine (Windows)
```powershell
git clone <your-private-repo-url> <local-path>\claude-session-memory
cd <local-path>\claude-session-memory
# Wire into Claude Code (junction + import + merge settings/hooks)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### 2. Other machines (macOS / Linux)
```bash
git clone <your-private-repo-url> ~/Github_project/claude-session-memory
cd ~/Github_project/claude-session-memory
bash scripts/install-mac.sh        # needs jq to auto-merge settings/hooks: brew install jq
```

### Optional: install with the npm CLI

The public npm CLI only manages installation and maintenance. It never publishes or uploads your personal memory; that data remains in your private Git repository.

To install on a new machine, cloning by default into `~/.local/share/session-memory` on macOS/Linux or `%LOCALAPPDATA%\session-memory` on Windows:

```bash
npx @wanjeans/session-memory init --repo-url <your-private-repository-url>
```

If you already have a local clone, do not clone another copy. Use:

```bash
npx @wanjeans/session-memory install --repo-dir <local-repository-path>
```

Maintenance commands:

```bash
npx @wanjeans/session-memory doctor
npx @wanjeans/session-memory update
```

Every command that changes the machine supports `--dry-run`; `init` also accepts `--dir <path>` to override the default clone directory.

What the installer does (identical on both, idempotent, re-runnable):
1. Links `~/.claude/projects/<encoded-project>/memory` → this repo's `memory/`;
2. Adds one line `@<repo>/CLAUDE.md` to `~/.claude/CLAUDE.md` to import global rules;
3. Merges `settings/settings.shared.json` into `~/.claude/settings.json` (backs up to `.bak` first);
4. Links skills under `skills/` into Claude's `~/.claude/skills/` and Codex's `~/.agents/skills/` (incl. `session-memory`);
5. Installs **memory-sync** hooks: **SessionStart** pulls, **SessionEnd** commits & pushes the
   memory repo. (Session capture installs **no** hook — it's the manual `/session-memory save`;
   the installer also cleans up any legacy capture hooks.)

---

## Daily use
- Memory sync is **automatic**: `git pull` on session start, `commit` + `push` on session end.
- Session history is **manual**: in Claude run `/session-memory save|read|get`; in Codex run `$session-memory save|read|get`.
- Memory and rule edits get committed alongside `memory/` and `CLAUDE.md`.
- Manual fallback (sync the memory repo anytime):
  - Windows: `powershell -File scripts\memory-sync\sync.ps1`
  - macOS: `bash scripts/memory-sync/sync.sh`
- To make memory apply to **all** projects: the import in `~/.claude/CLAUDE.md` already loads it
  globally (which in turn imports `memory/MEMORY.md`).

---

## iPhone

There is **no local Claude Code** on iPhone. Two viable paths:

1. **Remote Control** — from the Claude iOS app, take over a session running on your Mac/Windows.
   Compute happens on that already-synced machine, so it **automatically uses its local (synced)
   memory** — no phone-side setup.
2. **Cloud web** (claude.ai/code) — the session runs on an Anthropic cloud VM that **clones this
   repo** and reads the committed `CLAUDE.md` and `memory/`. Put your most useful, stable facts in
   `CLAUDE.md` / `memory/MEMORY.md` so cloud sessions load them at start (`MEMORY.md` auto-loads
   only the first ~200 lines / 25KB; deeper fact files are read on demand). The cloud VM **cannot
   see** your local `~/.claude`.

---

## Directory layout
```
.
├── CLAUDE.md                 # Global rules/prefs (synced)
├── DESIGN.md                 # Architecture + digest schema of the session-memory system
├── memory/                   # File-based memory: MEMORY.md index + one file per fact
├── settings/settings.shared.json
├── skills/
│   └── session-memory/       # Manual skill: save / read / get subcommands
└── scripts/
    ├── install-windows.ps1 / install-mac.sh    # Install entry points (both subsystems)
    ├── memory-sync/          # (1) Memory sync: sync.* (pull/commit/push this repo, auto hook)
    └── session-history/      # (2) Session history (fully manual)
        ├── save.*            #     Capture current/all sessions into session-history/
        ├── read.*            #     Import other-endpoint sessions into the current endpoint (CLI + Desktop)
        ├── repo-status.*     #     Enumerate branches/worktrees → index.json
        ├── build-status.*    #     Aggregate digests by branch (consumed by get)
        └── capture/          #     Adapters: claude-scrape / codex-scrape / desktop-scrape / _lib
```

> Two subsystems: **(1) Memory sync** (CLAUDE.md + memory, stable rules/facts shared across
> machines, **automatic**) and **(2) Session history** (per-project progress, **manual** via
> `/session-memory`). They are independent.

---

## Multi-endpoint session history

Beyond syncing "memory", this repo provides a system that **distills each endpoint's agent
sessions into project progress** (design: [DESIGN.md](DESIGN.md)). **Fully manual**, one skill
`session-memory` with three subcommands (use `/session-memory <subcommand>` inside a target project):

- **`/session-memory save`** — saves sessions into **that project's** `session-history/`
  (digest + redacted transcript). It asks: save **all** endpoints' new sessions (scan Claude
  CLI/Desktop + Codex) or only the **current** one.
- **`/session-memory read`** — imports **other-endpoint** sessions from `session-history/` into
  the **current** endpoint's list: CLI (visible to `claude --resume`) + Desktop (sidebar), with
  source-tag title prefixes like `(codex) …`. Choose specific ones or all.
- **`/session-memory get`** — combines `session-history/` + branch/worktree index + `memory/`
  into a `STATUS.md`: which branch does what, recent sessions, open threads, next steps.

Underlying scripts: `scripts/session-history/{save,read,repo-status,build-status}.*` +
`capture/{claude,codex,desktop}-scrape.*`. You can also run them directly (e.g. `save.ps1 -All`,
`read.ps1 -List`).

> **No automatic hook**: capture only happens when you run `save`. Memory-sync remains automatic.

> **Privacy**: transcripts are **best-effort redacted** (keys/tokens → `[REDACTED:*]`).
> `session-history/` lands in the **target project** repo — keep that repo private and add a
> secret-scan in CI as a backstop. Redaction can never be 100%.
>
> **Platform**: Windows (`.ps1`) is end-to-end verified. The macOS/Linux `.sh` versions depend on
> `jq`/`perl` and have **not yet been verified on a real machine** — double-check the output on
> your first macOS run.

## Security
- **Use a private repo only** (for your data). `.gitignore` excludes `.credentials.json`,
  `*.key`, `*.pem`, `*.token`, etc.
- Self-check (should print nothing):
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```

## License
[MIT](LICENSE)
