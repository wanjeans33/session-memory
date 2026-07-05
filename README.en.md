# claude-session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![platform](https://img.shields.io/badge/Windows-%E2%9C%85%20tested-success)
![platform](https://img.shields.io/badge/macOS%20%2F%20Linux-Node-blue)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

[中文](README.md) · **English**

Turn Claude Code / Codex "session progress" and "memory" into git-synced, shareable assets. Two ways to use it — pick what you need:

| Mode | What it solves | How to install | Repository needed |
|---|---|---|---|
| **A. Per-project session sharing** (teams / multi-client) | Every session becomes a searchable progress record; teammates and other clients pick up the context | clone this repo → link the skill into your project (one command) | this public repo works as-is |
| **B. Personal memory sync** (multi-machine, automatic) | `CLAUDE.md` rules + `memory/` facts sync across Mac / Windows / iPhone | create a **private** repo from the template → full install | your own **private** repo |

> 🟢 Everything is one Node CLI (`bin/session-memory.mjs`) — a single codebase for
> Windows / macOS / Linux, requiring only **Node ≥ 20** and **git**. No PowerShell / bash / jq.

---

## Mode A: enable session sharing for a project (fastest start)

Just clone this public repository — a skills-only install writes **none** of your personal data into the clone:

```bash
git clone https://github.com/wanjeans33/session-memory
cd session-memory
node bin/session-memory.mjs install --skills-only --project-dir <target-project>
```

This links the `session-memory` skill into the target project's `.claude/skills/` and `.agents/skills/`.
Then, in a new session **inside the target project**, Claude uses `/session-memory <subcommand>` and
Codex uses `$session-memory <subcommand>`:

- **`save`** — stores sessions into that project's `session-history/` (digest + redacted transcript).
  It asks whether to save **all** clients' new sessions (scanning Claude CLI/Desktop + Codex) or only
  the **current** one; add `--commit` to commit right away.
- **`read`** — imports **other people's / other clients'** sessions from `session-history/` into the
  **current** client's list (visible to `claude --resume` and the Desktop sidebar), with source-tagged
  titles like `(codex@alice) …`.
- **`get`** — combines digests + the branch/worktree index + `memory/` into `STATUS.md`:
  who is doing what on which branch, recent sessions, open threads, next steps.

`session-history/` travels with the **target project's** git repo: members push/pull the project as
usual and session progress syncs along.

**Multi-person collaboration** (design in [DESIGN.md](DESIGN.md)):

- Every record carries an `author` (defaults to `git config user.name`; override with the
  `SESSION_MEMORY_AUTHOR` env var) and lands under `session-history/digests/<author>/` —
  concurrent writers **never conflict**;
- `read --list` shows the author column and supports `--author <handle>`;
- `get` aggregates per-branch `authors`, so STATUS.md answers "who is working on what".

> ⚠️ **Privacy**: transcripts are redacted on a **best-effort** basis (keys/tokens → `[REDACTED:*]`) —
> never 100% — and are readable by project collaborators. **Keep the target project repo private**
> and add a secret-scan CI (e.g. gitleaks) as a backstop.

### Why "progress records" instead of cross-OS resume
Each OS encodes project paths into different folder names (`E:\proj` → `E--proj` vs `/Users/x/proj`)
and transcripts embed absolute paths, so a conversation can't be resumed on another machine. Instead
we persist **searchable digests** and reconnect context via `read`/`get` (`read` import is currently
same-OS only).

---

## Mode B: automatic personal memory sync across devices

### 0. Create your own **private** repository from the template
Click **Use this template → Create a new repository** on this repo, and set **Visibility to Private**.

> ⚠️ **Why private is mandatory**: after a full install, the memory-sync hooks **automatically
> commit + push** your personal `CLAUDE.md` / `memory/` facts to that repository. It must never be a
> public repo, and never this template.
> Prefer starting from scratch? `git init`, then `gh repo create <name> --private --source . --push`.

### 1. Install on every machine

```bash
git clone <your-private-repo-url> ~/claude-session-memory   # any path works on Windows
cd ~/claude-session-memory
node bin/session-memory.mjs install --project-dir <target-project>
```

What `install` does (identical on all platforms, idempotent, safe to re-run):

1. Links `~/.claude/projects/<encoded>/memory` to this repo's `memory/` (junction on Windows — no
   admin required; symlink elsewhere);
2. Adds an `@<repo>/CLAUDE.md` import to `~/.claude/CLAUDE.md`, so global rules apply to all projects;
3. Merges `settings/settings.shared.json` into `~/.claude/settings.json` (backup `.bak` first);
4. Same as Mode A: links the skills into the target project (`--skills-only` does only this step);
5. Installs the **memory-sync** hooks: SessionStart pulls, SessionEnd commits + pushes the memory repo.
   Sync commits only whitelisted paths (never `git add -A`) and retries a rejected push after a rebase.

### Optional: npm CLI

The public npm CLI only handles install/maintenance flows and **never** uploads your personal memory:

```bash
npx @wanjeans/session-memory init --repo-url <your-private-repo-url>   # first time: clone + install
npx @wanjeans/session-memory install --repo-dir <local-repo-path>      # existing clone
npx @wanjeans/session-memory doctor                                    # self-check
npx @wanjeans/session-memory update                                    # upgrade
```

Every command that changes your machine supports `--dry-run`.

### Daily use
- Memory sync is **zero-touch**: `git pull` on session start, `commit + push` on session end.
- Manual fallback: `node bin/session-memory.mjs sync` (add `--pull-only` to only pull).
- Session history stays **manual** (see Mode A's save / read / get).

### iPhone
There is no local Claude Code on iPhone; two paths:

1. **Remote Control** — the Claude iOS app takes over a session running on your Mac/Windows, which
   automatically uses that machine's synced memory.
2. **Cloud** (claude.ai/code) — the cloud VM clones your private repo and reads the committed
   `CLAUDE.md` and `memory/`. Note `MEMORY.md` auto-loads only the first ~200 lines / 25KB; the cloud
   VM cannot see your local `~/.claude`.

---

## What syncs where

| Data | Destination | Notes |
|---|---|---|
| `CLAUDE.md` (rules/preferences) | memory repo (Mode B) | referenced via `@import` on each machine |
| `memory/` (MEMORY.md + fact files) | memory repo (Mode B) | symlink/junction, read/written in place |
| `settings/settings.shared.json` | memory repo (Mode B) | curated portable settings, merged locally |
| `session-history/` (digests + redacted transcripts) | **target project** repo (Mode A) | per project, per author |
| Credentials (`.credentials.json`, …) | ❌ never | excluded by `.gitignore` |

## Layout & CLI

```
.
├── CLAUDE.md                 # global rules/preferences (synced in Mode B)
├── DESIGN.md                 # architecture & digest schema
├── memory/                   # file-based memory: MEMORY.md index + one fact per file
├── settings/settings.shared.json
├── skills/session-memory/    # manual skill: save / read / get
├── bin/session-memory.mjs    # CLI entry point
└── lib/                      # Node implementation (commands / capture / util)
```

| Command | Purpose |
|---|---|
| `install [--skills-only] [--project-dir …]` | install (skills-only = link the skill into a project only) |
| `init` / `update` / `doctor` | clone & wire up / upgrade / self-check |
| `sync [--pull-only]` | memory sync (invoked by hooks) |
| `save [--all] [--commit]` | capture sessions into `session-history/` |
| `read --list [--author …] \| --import --ids …` | list / import other people's & clients' sessions |
| `repo-status` / `build-status` | branch index + per-branch aggregation (consumed by `get`) |

Full options: `node bin/session-memory.mjs --help`.

## Platform support

| Platform | Status |
|---|---|
| Windows | ✅ verified end-to-end (junction, no admin) |
| macOS / Linux | ✅ same Node codebase (symlinks) |
| iPhone | ✅ via Remote Control / cloud (see Mode B) |

## Security
- Repos holding personal memory (Mode B) or team sessions (Mode A target projects) **must be private**.
- `.gitignore` excludes `.credentials.json`, `*.key`, `*.pem`, `*.token`, etc. **Never** commit tokens/keys.
- Self-check (should print nothing):
  ```bash
  git log --all --full-history -- '**/.credentials.json'
  ```
