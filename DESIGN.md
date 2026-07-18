# Session Memory schema 4

## 1. Boundary

The project repository is the source of truth for conversation continuity. Claude and Codex native
session IDs are local implementation details; `logical_id` is the stable project conversation ID.
Every command operates on the current checkout from `git rev-parse --show-toplevel`. Linked
worktrees keep separate branch history until normal Git integration combines it.

Schema 4 intentionally stores only:

- immutable canonical events;
- immutable revision metadata; and
- a small marker embedded in materialized native sessions.

It has no `project.json`, project-side replica bindings, mutable checkpoints, or imported line count.

## 2. Invariants

1. One conversation keeps one `logical_id` across clients and devices.
2. A revision is immutable and content-addressed within its logical session.
3. An existing canonical content hash in the current project history makes `save` a no-op.
4. An imported session with no real continuation is a no-op only when its marker/revision verifies against that history.
5. A continuation appends under the same `logical_id` and the deepest matching saved prefix.
6. Canonical events exclude native IDs, timestamps, paths, thinking, and control-only session-memory
   turns; they retain messages and supported tool evidence.
7. `read` is an upsert: exact skip, stored-clean in-place update, unsaved-dirty block.
8. Multiple heads are preserved and require explicit `--revision`; there is no last-write-wins or
   automatic semantic merge.
9. Actor, role, device, client, machine, and path are metadata, not logical identity.
10. Candidate count has no UI-derived cap. Eleven distinct selected sessions remain eleven unless an
    explicit filter, missing source, or conflict is reported.
11. Local save, Git commit, and push are separate outcomes.

## 3. Storage

```text
session-history/
└── v4/sessions/<logical-id>/
    ├── events/<revision-id>.jsonl
    └── revisions/<revision-id>.json
```

Canonical event kinds are `user_message`, `assistant_message`, `tool_call`, and `tool_result`.
`content_hash = sha256(stable_json(events))`. A revision ID is deterministically derived from
`logical_id + content_hash`.

Example revision metadata:

```json
{
  "schema": 4,
  "logical_id": "session-…",
  "revision_id": "rev-…",
  "parents": ["rev-…"],
  "owner": "alice",
  "owner_actor_id": "alice",
  "author": "bob",
  "actor_id": "bob",
  "role": "reviewer",
  "device_id": "bob-laptop",
  "tool": "codex",
  "native_session_id": "…",
  "content_hash": "…",
  "content_hash_version": 3,
  "event_count": 42,
  "events_ref": "session-history/v4/sessions/…/events/rev-….jsonl"
}
```

Owner is immutable for a logical session. Heads are derived from parent references; no mutable
`latest` record is written.

## 4. Native marker

`read` embeds this schema-4 marker in Codex `session_meta.payload.session_memory` or Claude's first
structured row as `sessionMemory`:

```json
{
  "schema": 4,
  "logical_id": "session-…",
  "revision_id": "rev-…",
  "content_hash": "…",
  "owner": "alice",
  "owner_actor_id": "alice",
  "source_tool": "codex",
  "source_id": "…",
  "source_author": "alice",
  "source_role": "developer"
}
```

The marker records materialized identity; it is not a mutable checkpoint or authority. Its
revision/hash must verify against the current project history before a no-op. A new unmarked source
derives its `logical_id` from canonical client + native session ID.

## 5. Save algorithm

1. Select the exact runtime/explicit native ID when present; otherwise select the newest candidate in
   the current checkout. Never fall back after an exact-ID failure.
2. Parse the marker, normalize native rows into canonical events, and compute the content hash.
3. Resolve `logical_id` from the marker, an existing revision with matching `(tool,
   native_session_id)`, or the deterministic new-source rule.
4. Return no-op if content equals a stored revision; trust a marker only when its revision/hash verifies in current project history.
5. Find the deepest stored revision whose events are a prefix of current events. If revisions exist
   but no prefix matches, fail and require reading the intended branch.
6. Atomically append the event file and revision metadata. Never mutate an earlier revision.
7. Optionally commit only `session-history/`; optionally publish by pushing the current branch.

## 6. Read algorithm

1. Load schema-4 sessions plus read-only schema-1/2/3 candidates.
2. Apply `mine|team`, owner, author, role, logical-ID, and revision filters. For legacy data without an
   actor, `mine` and owner filtering compare the owner name. Invalid explicit filters fail closed.
3. Identify native candidates by marker, then stored source identity. Use a markerless legacy replica only
   on one content match; zero/multiple warn and are ignored, allowing a marked copy without position guesses.
4. For each selected target:
   - no match: create a native session with the schema-4 marker;
   - selected revision ID or content hash already present: skip;
   - current content hash equals any stored revision: it is clean; update that native file/ID in place;
   - current content hash equals no stored revision: it is dirty; block overwrite;
   - multiple heads without `--revision`: block.
5. Report created, updated, already-current, blocked, and missing items with native IDs and paths.

There is no force-copy mode. Sidebar visibility and import state are verified separately.

## 7. Compatibility and conflicts

Schemas 1, 2, and 3 remain readable. Their files are never deleted or rewritten; schema 4 is the only
new write format. V3 and v4 revisions with one `logical_id` form one DAG: the first v4 continuation
may parent to v3, and every unsuperseded old head remains visible.

Two children of one revision are two heads. `read --list` exposes both; importing requires one
explicit `--revision`. Git push races are handled by the user's normal Git workflow and are distinct
from the revision DAG.

## 8. Safety and verification

- Validate revision path/ID agreement, content hash, event count, immutable owner, parents, and DAG
  acyclicity. Malformed data fails closed.
- Confine ledger and native writes by realpath; reject traversal, symlink/junction escapes, and target
  symlinks. Replace via same-directory temporary file plus rename. Never edit Codex SQLite.
- Serialize mutations with a checkout-realpath process lock outside Git. Hold publish operations
  through stage, commit, and push. A stale lock is removed only after confirming no writer remains.
- Ignore only missing directories during scans. Permission, `ENOTDIR`, and other I/O failures abort
  rather than returning a plausible partial set.
- Verify unchanged save, imported no-op, real continuation, repeat read, clean refresh, dirty block,
  multi-head selection, legacy read compatibility, path safety, worktrees, and eleven-session
  round-trip behavior.
