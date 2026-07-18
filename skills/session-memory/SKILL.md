---
name: session-memory
description: Manual project session continuity for Claude Code, Claude Desktop, and Codex with save, read, and get. Use only when the user explicitly invokes `/session-memory save|read|get`, `$session-memory save|read|get`, or explicitly asks to run one of those session-memory operations. Do not activate merely because the user mentions progress, history, or memory.
---

# session-memory

Run this workflow only after an explicit `save`, `read`, or `get` request. Resolve this repository as `<session-memory-repo>`, then run its Node 20+ CLI from the target project:

```text
node "<session-memory-repo>/bin/session-memory.mjs" <command>
```

Treat the current checkout from `git rev-parse --show-toplevel` as the project root. In a linked worktree, operate on that worktree and branch. Read [DESIGN.md](../../DESIGN.md) only when debugging identity, conflict, migration, or integrity behavior.

## save

If the user did not choose current or all sessions, ask which scope they want. Run:
```text
node "<session-memory-repo>/bin/session-memory.mjs" save --current
node "<session-memory-repo>/bin/session-memory.mjs" save --all
```

- Add stable identity when needed: `--author <handle> --actor <id> --device <id> --role <role>`.
- For an exact Codex source, use runtime `CODEX_THREAD_ID` / `CODEX_SESSION_ID` or
  `--codex-session-id <id>`. Treat missing IDs and another checkout as errors; never fall back.
- Keep `save --all` inside the current checkout; exclude other projects and sibling worktrees.
- Treat a canonical hash in the current project history as unchanged; a schema-4 import is unchanged
  only when current content and its marker/revision verify there. Exclude pure control turns.
- Preserve the embedded `logical_id` for continuations. If content extends no stored revision, stop
  and require `read` of the intended branch instead of guessing a parent.
- Use `--commit` only when asked to commit `session-history/`. Use `--publish` only when asked to push
  the current branch. Report save, commit, and push separately.
- Do not combine `save --all` with `--commit` or `--publish`.

Report selected sources, new logical/revision IDs and paths, unchanged counts, failures, and Git
outcomes. Never call a local save published unless push succeeds.

## read

First ensure the current checkout already contains the desired `session-history/` state. Do not
auto-pull, stash, rebase, or discard local changes.

Unless the user chose a scope, ask for `mine` or `team`, then list candidates:
```text
node "<session-memory-repo>/bin/session-memory.mjs" read --list --scope mine
node "<session-memory-repo>/bin/session-memory.mjs" read --list --scope team
```

Import selected or all candidates:
```text
node "<session-memory-repo>/bin/session-memory.mjs" read --import --ids <logical-id,...> --targets claude-code,codex --scope team
node "<session-memory-repo>/bin/session-memory.mjs" read --import --all --targets desktop --scope mine
```

Use source filters `--owner`, `--source-author`, and `--source-role`; legacy data without an actor uses
owner name for `mine` / `--owner`. Invalid filters fail closed. `--revision` requires exactly one ID.

Enforce these upsert rules:

- no native match: create one with a schema-4 marker;
- target revision/content already present: skip;
- native content equals any stored revision: update the same native ID in place;
- native content equals no stored revision: block as unsaved continuation;
- multiple heads: block until the user supplies `--revision`.

The CLI has no force-copy option. Never duplicate for sidebar ordering; verify by native ID. Use a markerless
legacy replica only on one content match; otherwise warn/ignore it and let `read` create a marked copy—never guess by position.

There is no five-session cap. Eleven distinct selected, conflict-free sessions must remain eleven
through save-all, list, and import-all; report every filter, missing source, conflict, and scan error.

Report created, updated, already-current, blocked, and missing counts plus written paths/native IDs.

## get

Run:

```text
node "<session-memory-repo>/bin/session-memory.mjs" repo-status
node "<session-memory-repo>/bin/session-memory.mjs" build-status [--days N]
```

Read `memory/MEMORY.md` and only relevant fact files if present. Write
`session-history/STATUS.md` with checkout state, owners/contributors, logical sessions, heads, recent
revisions, files changed, and next steps. Aggregate by logical session.

## Safety

- Treat `session-history/v4` canonical events and revision metadata as the only new write model. It
  has no `project.json`, replicas, checkpoints, or imported line count.
- Keep schema 1/2/3 read-only; merge v3/v4 as one DAG so the first v4 continuation may parent to v3 without hiding old heads.
- Surface malformed data and all scan errors except a genuinely missing directory. Never accept a
  plausible partial result.
- Keep ledger/native writes under their real roots, reject traversal and link escapes, use atomic
  replacement, and never modify Codex SQLite.
- Respect the checkout-scoped write lock. After an abnormal exit, verify no writer remains before
  deleting the exact stale lock reported by the CLI.
- Treat redaction as best effort and `mine|team` as selection, not access control.
