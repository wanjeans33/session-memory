# session-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933)

[中文](README.md) · **English**

Store Claude Code, Claude Desktop, and Codex project conversations in Git, then continue them in
another client or on another device.

Schema 4 does three things:

1. normalize native transcripts into canonical events;
2. keep one stable `logical_id` with immutable revisions; and
3. materialize a revision into a native client with a small embedded marker.

If the semantic content hash already exists in the current project history, `save` is a no-op. Saving
immediately after `read`, without a real continuation, also writes no revision. Only new user work
appends a revision under the same `logical_id`.

A control-only `/session-memory save` or `$session-memory save` turn and its tool/confirmation output
are excluded. A mixed message that also contains a real task is preserved.

Requirements: Node.js 20+ and Git. Project commands use the current checkout returned by
`git rev-parse --show-toplevel`; a linked worktree uses its own branch and `session-history/`.

## Install

Enable project-session continuity only:

```bash
git clone https://github.com/wanjeans33/session-memory
cd session-memory
node bin/session-memory.mjs install --skills-only --project-dir <target-project>
```

This links the manual skill for:

- Claude Code: `/session-memory save|read|get`
- Codex: `$session-memory save|read|get`

The CLI can also be run directly from the target project:

```bash
node "<session-memory-repo>/bin/session-memory.mjs" <command>
```

## Shortest round trip

Save and publish on device A:

```bash
node "<repo>/bin/session-memory.mjs" save --publish
```

Update the project normally on device B, then list and import:

```bash
git pull
node "<repo>/bin/session-memory.mjs" read --list --scope team
node "<repo>/bin/session-memory.mjs" read --import --ids <logical-id> --targets codex --scope team
```

Continue the imported native session and run `save`. Its marker preserves the original `logical_id`.
`read` never auto-pulls, stashes, rebases, or discards worktree changes.

## save

```bash
node "<repo>/bin/session-memory.mjs" save --current
node "<repo>/bin/session-memory.mjs" save --all
node "<repo>/bin/session-memory.mjs" save --current --codex-session-id <native-id>
```

- The default saves the current native session in the current checkout.
- A runtime `CODEX_THREAD_ID` / `CODEX_SESSION_ID` or explicit native ID must match exactly. A missing
  ID or another checkout fails instead of falling back.
- `save --all` scans every supported client but keeps only sessions whose cwd is this checkout.
- A canonical content hash already in the current project history writes zero revisions.
- A schema-4 marker writes zero revisions only when its revision/hash verifies there and matches current content.
- Content extending a stored revision appends one immutable child.
- Content extending no stored revision fails and asks the user to read the intended branch; it does
  not guess a parent.

`save` is local. `--commit` commits only `session-history/`; `--publish` also pushes the current branch.
The three outcomes are reported separately. `save --all` cannot combine with either option.

## read

```bash
node "<repo>/bin/session-memory.mjs" read --list --scope mine
node "<repo>/bin/session-memory.mjs" read --list --scope team
node "<repo>/bin/session-memory.mjs" read --import --all --targets claude-code,codex --scope team
```

`read` identifies native files from a schema-4 marker or stored `(tool, native_session_id)`; it keeps no project-side binding/checkpoint.
An old markerless replica needs exactly one legacy content match; zero/multiple warn and are ignored, so `read` may create a marked replica without position guesses.

For each target:

- missing: create a native session and embed a schema-4 marker;
- selected revision or canonical content already present: skip;
- content equals any stored revision: treat it as clean and update the same native ID in place;
- content equals no stored revision: treat it as an unsaved continuation and block overwrite;
- multiple heads: block until one revision is selected with `--revision <revision-id>` for one
  `logical_id`.

There is no force-copy option. Repeated reads do not create extra replicas to influence sidebar
ordering or pagination.

`read --list` reports logical and revision IDs, owner, source, heads, conflict state, and current
native IDs. `--pending` means the configured Codex native store has no match; it is not proof that a
previous import failed. Verify by native ID because a client sidebar may show only a recent subset.

There is no five-session or other internal cap. Eleven distinct, conflict-free logical sessions must
remain eleven through `save --all → read --list --scope team → read --import --all`. Every filter,
missing source, and conflict must be reported.

## Storage model

```text
session-history/
└── v4/sessions/<logical-id>/
    ├── events/<revision-id>.jsonl
    └── revisions/<revision-id>.json
```

- `logical_id` is the stable project conversation identity. A new native source derives it from the
  canonical client and native ID; an imported marker carries it across clients.
- Events are immutable `user_message`, `assistant_message`, `tool_call`, and `tool_result` records.
- Revision metadata contains parents, immutable owner, author/role/device/source, event count, and
  content hash.
- Heads are derived from parent links; there is no mutable `latest` record.

Schema 4 writes no `project.json`, `replicas/`, checkpoints, or `imported_line_count`. Its native
marker contains only logical/revision/content identity and source metadata. Native files remain owned
by their clients.

## Identity, scope, and conflicts

For team and multi-device use, configure stable identities:

```bash
node "<repo>/bin/session-memory.mjs" save \
  --author alice --actor alice --device alice-laptop --role developer
```

The environment equivalents are `SESSION_MEMORY_AUTHOR`, `SESSION_MEMORY_ACTOR_ID`,
`SESSION_MEMORY_DEVICE_ID`, and `SESSION_MEMORY_ROLE`. Handles are NFKC-normalized, lowercased, and
retain Unicode letters/digits plus `._-`; explicit punctuation/emoji-only values fail.

`mine` filters by immutable owner; `team` selects every repository-visible session. Legacy data without
an actor uses owner name for `mine` / `--owner`. These are filters, not access control; other source
filters are `--source-author` and `--source-role`. Two devices continuing one revision create two heads;
select one with `--revision`.

## Compatibility and safety

- Schemas 1, 2, and 3 remain read-only compatible; schema 4 is the only new write format. V3/v4 form
  one DAG: the first v4 continuation may parent to v3 without hiding other heads or rewriting legacy.
- Canonical events and revision metadata are committed to the project. Redaction is best-effort, so
  use a private repository and secret scanning for sensitive work.
- Ledger and native-store writes validate realpath containment, reject traversal and symlink/junction
  escapes, and replace via same-directory temporary file plus rename. Codex SQLite is never modified.
- Writers use a checkout-realpath process lock. After an abnormal exit, verify that no writer remains
  before deleting the exact stale lock named by the CLI.
- Scans ignore only a missing directory (`ENOENT`). Permission, `ENOTDIR`, and other I/O errors fail
  instead of silently turning eleven sessions into five.

## Other commands

| Command | Purpose |
|---|---|
| `repo-status` | write the branch/worktree index |
| `build-status [--days N]` | emit project status grouped by logical session |
| `get` skill flow | write `session-history/STATUS.md` |
| `doctor` / `update` | inspect or update the installation |

Run `node bin/session-memory.mjs --help` for full syntax. Personal `CLAUDE.md` / `memory/` sync is a
separate optional mode enabled only by a full install without `--skills-only`.
