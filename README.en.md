# claude-session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![platform](https://img.shields.io/badge/Windows-%E2%9C%85%20tested-success)
![platform](https://img.shields.io/badge/macOS%20%2F%20Linux-Node-blue)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

[Chinese](README.md) · **English**

Sync Claude Code's **memory** across **Mac / Windows / iPhone**: your rules & preferences
(`CLAUDE.md`) and accumulated facts (`memory/`). It also distills sessions from every endpoint
into **per-project progress records** (`session-history/`, see "Multi-endpoint session history").

Core idea: **use one git repo as the single source of truth**, and let Claude Code read/write
those files **in place** via symlinks / directory junctions; git handles cross-machine sync.
This is also the only way to reach iPhone (see below).

> 🟢 **Everything is implemented in Node.js (one codebase for Windows / macOS / Linux)**, requiring
> only **Node ≥ 20** and **git**. No PowerShell, bash, or jq needed — install, memory sync, and
> session capture all go through one CLI (`bin/session-memory.mjs`).

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
| Windows | ✅ End-to-end tested | Node ≥ 20 + git; junctions (no admin needed) |
| macOS / Linux | ✅ Same Node codebase | Node ≥ 20 + git; symlinks. No jq / bash |
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

The install entry point is identical on every platform — `node bin/session-memory.mjs install`
(create links + import + merge settings/hooks).
The `session-memory` skill is installed into the target project where you run the command; pass
`--project-dir <target-project-path>` to choose a different project explicitly.

### 1. First machine (Windows)
```powershell
git clone <your-private-repo-url> <local-path>\claude-session-memory
cd <local-path>\claude-session-memory
node bin/session-memory.mjs install --project-dir <target-project-path>
```

### 2. Other machines (macOS / Linux)
```bash
git clone <your-private-repo-url> ~/Github_project/claude-session-memory
cd ~/Github_project/claude-session-memory
node bin/session-memory.mjs install --project-dir <target-project-path>
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

If the session is open inside the target project, run it from that project directory and the skill
lands there. If you run it elsewhere, pass the target explicitly:

```bash
npx @wanjeans/session-memory install --repo-dir <local-repository-path> --project-dir <target-project-path>
```

Maintenance commands:

```bash
npx @wanjeans/session-memory doctor
npx @wanjeans/session-memory update
```

Every command that changes the machine supports `--dry-run`; `init` also accepts `--dir <path>` to override the default clone directory.

What `install` does (identical on every OS, idempotent, re-runnable):
1. Links `~/.claude/projects/<encoded-project>/memory` → this repo's `memory/` (junction on Windows, symlink elsewhere);
2. Adds one line `@<repo>/CLAUDE.md` to `~/.claude/CLAUDE.md` to import global rules;
3. Merges `settings/settings.shared.json` into `~/.claude/settings.json` (backs up to `.bak` first);
4. Links skills under `skills/` into the target project's `.claude/skills/` and `.agents/skills/` (incl. `session-memory`); the default target is the current working directory, and the installer does **not** install Claude/Codex global skills;
5. Installs **memory-sync** hooks: **SessionStart** pulls, **SessionEnd** commits & pushes the
   memory repo (the hook command is `node …/bin/session-memory.mjs sync`). (Session capture installs
   **no** hook — it's the manual `/session-memory save`; the installer also cleans up any legacy
   capture hooks and old `.ps1/.sh` sync hooks.)

---

## Daily use
- Memory sync is **automatic**: `git pull` on session start, `commit` + `push` on session end.
- Session history is **manual**: first install the skill into the current target project; in Claude run `/session-memory save|read|get`, and in Codex run `$session-memory save|read|get`.
- Memory and rule edits get committed alongside `memory/` and `CLAUDE.md`.
- Manual fallback (sync the memory repo anytime, same on every OS):
  - `node bin/session-memory.mjs sync` (pull only: add `--pull-only`)
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
│   └── session-memory/       # Manual skill source: save / read / get subcommands
├── bin/session-memory.mjs    # CLI entry point (single entry for every command)
└── lib/                      # Node implementation (one codebase, all platforms)
    ├── main.mjs              #   Command dispatch
    ├── args.mjs / paths.mjs  #   Arg parsing / cross-platform paths
    ├── commands/             #   install · sync · save · read · repo-status · build-status
    ├── capture/              #   Capture adapters: claude · codex · desktop
    └── util/                 #   git · redact · transcript · digest · run
```

CLI commands (see `node bin/session-memory.mjs --help`):

| Command | Purpose |
|---|---|
| `init` / `install` / `update` / `doctor` | Install & maintain (clone, wire up, upgrade, self-check) |
| `sync [--pull-only]` | (1) Memory sync: pull / (commit + push) the memory repo (used by hooks) |
| `save [--all] [--commit]` | (2) Capture current / all endpoints' sessions into `session-history/` |
| `read --list \| --import --ids …` | (2) Import other endpoints into the current client's list (CLI + Desktop) |
| `repo-status` / `build-status` | (2) Branch/worktree index + per-branch aggregation (consumed by `get`) |

> Two subsystems: **(1) Memory sync** (CLAUDE.md + memory, stable rules/facts shared across
> machines, **automatic**) and **(2) Session history** (per-project progress, **manual** via
> `/session-memory`). They are independent.

---

## Multi-endpoint session history

Beyond syncing "memory", this repo provides a system that **distills each endpoint's agent
sessions into project progress** (design: [DESIGN.md](DESIGN.md)). **Fully manual**, one skill
`session-memory` with three subcommands (first install it into the target project's `.claude/skills/`
or `.agents/skills/`, then use `/session-memory <subcommand>` or `$session-memory <subcommand>` inside
that project):

- **`/session-memory save`** — saves sessions into **that project's** `session-history/`
  (digest + redacted transcript). It asks: save **all** endpoints' new sessions (scan Claude
  CLI/Desktop + Codex) or only the **current** one.
- **`/session-memory read`** — imports **other-endpoint** sessions from `session-history/` into
  the **current** endpoint's list: CLI (visible to `claude --resume`) + Desktop (sidebar), with
  source-tag title prefixes like `(codex) …`. Choose specific ones or all.
- **`/session-memory get`** — combines `session-history/` + branch/worktree index + `memory/`
  into a `STATUS.md`: which branch does what, recent sessions, open threads, next steps.

Underlying implementation: `lib/commands/{save,read,repo-status,build-status}.mjs` +
`lib/capture/{claude,codex,desktop}.mjs`. You can also run them directly (e.g.
`node bin/session-memory.mjs save --all`, `… read --list`).

> **No automatic hook**: capture only happens when you run `save`. Memory-sync remains automatic.

> **Privacy**: transcripts are **best-effort redacted** (keys/tokens → `[REDACTED:*]`).
> `session-history/` lands in the **target project** repo — keep that repo private and add a
> secret-scan in CI as a backstop. Redaction can never be 100%.
>
> **Platform**: implemented in pure Node (one codebase for all platforms), requiring only Node ≥ 20
> and git. Windows is end-to-end verified; macOS/Linux run the same code and the same commands —
> still worth double-checking the output on your first run.

### Multi-person collaboration (initial support)

Several people can share one repository, each saving sessions in and reading the others' for context:

- Every digest records an `author` (defaults to `git config user.name`, overridable with the
  `SESSION_MEMORY_AUTHOR` env var) and lands under `session-history/digests/<author>/` and
  `transcripts/<author>/`, so concurrent writers never conflict.
- `read --list` shows the author column and supports `--author <handle>`; imported titles carry a
  source-person tag like `(codex@alice) …`.
- `get` aggregation includes per-branch `authors`, so STATUS.md answers "who is working on what".
- memory-sync commits only whitelisted paths (never `add -A`) and retries a rejected push after a rebase.

> Note: sharing with a team means your (redacted) transcripts are readable by collaborators. Keep the
> team repo private and add a secret-scan CI (e.g. gitleaks). The shared layout split (shared/ + users/)
> and digest-only team default are on the roadmap as Phase 9b/9c (see [DESIGN.md](DESIGN.md)).

## Security
- **Use a private repo only** (for your data). `.gitignore` excludes `.credentials.json`,
  `*.key`, `*.pem`, `*.token`, etc.
- Self-check (should print nothing):
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```

## License
[MIT](LICENSE)
