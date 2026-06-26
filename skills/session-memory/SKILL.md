---
name: session-memory
description: Manual session-memory workflow with save, read, and get subcommands. Use it only when the user explicitly invokes Claude's `/session-memory save|read|get`, Codex's `$session-memory save|read|get`, or explicitly asks to run session-memory's save/read/get command. Do not activate it merely because the user mentions progress or saving sessions.
---

# session-memory — manual session memory workflow (save / read / get)

**Manual invocation only.** Follow the corresponding flow only when the user explicitly invokes Claude's `/session-memory <subcommand>` or Codex's `$session-memory <subcommand>`.
Do not trigger automatically. If the user merely mentions progress or memory, tell Claude users they can run `/session-memory get` and Codex users they can run `$session-memory get`; do not run it yourself.

The workflow is implemented by the cross-platform Node CLI shipped with this repository.
First determine `<repo>`, the installation path of this claude-session-memory repository, then run
`node "<repo>/bin/session-memory.mjs" <command>` from the target project's directory. The same
command works on Windows, macOS, and Linux (Node.js 20+ and git are the only requirements).

---

## save — store sessions in this project's session-history/

1. **Ask for scope first:** “Save new sessions from **all** clients, or only the **current** session?”
2. Run the matching command from the target project's directory:
   - Current only: `node "<repo>/bin/session-memory.mjs" save`
   - All: `node "<repo>/bin/session-memory.mjs" save --all` (scans Claude CLI/Desktop and Codex)
3. To commit as well, add `--commit`; it is meaningful only with the default (current-session) scope.
4. Report the command output, including every digest written.

## read — import sessions from other clients into the current client's list

1. **List candidates:** `node "<repo>/bin/session-memory.mjs" read --list` returns a JSON array with base, tool, machine, and title.
2. **Show the candidates to the user** and ask which ones to import (all is allowed). Identify the source client (`tool`) for each.
3. **Import:** `node "<repo>/bin/session-memory.mjs" read --import --ids <base1,base2,…> --targets cli,desktop`
   - After import, the session appears in `claude --resume`; the Desktop sidebar gets a source-prefixed title such as `(codex) …`.
   - **Limits:** imports are same-OS only. Codex sources become placeholder sessions containing a summary and reference to the redacted transcript, not a faithful resume. Desktop import needs an existing `local_*.json` to infer the account directory; otherwise it is skipped.
4. Report the import result, including files written and targets completed.

## get — generate the consolidated project status (STATUS.md)

1. Refresh the branch/worktree index: `node "<repo>/bin/session-memory.mjs" repo-status`.
2. Get aggregated data: `node "<repo>/bin/session-memory.mjs" build-status [--days N]` returns compact JSON grouped by branch.
3. Read `memory/MEMORY.md` and relevant fact files.
4. Write `session-history/STATUS.md`, covering each branch/worktree's work, recent sessions (time, client, files changed), ahead/behind state, outstanding threads, and next steps, then cross-branch observations. When a digest has an empty `summary`, infer one sentence from first_prompt, files, and next_steps.

## Notes
- Privacy: `transcripts/` are redacted on a best-effort basis. Do not treat `[REDACTED:*]` as a real value when quoting transcripts.
- If `session-history/` does not exist, explain that the project has not been saved yet and direct the user to `/session-memory save` (Claude) or `$session-memory save` (Codex).
- Cross-client/machine: a project can have multiple Windows/macOS and Claude/Codex digests; distinguish them by `tool` and `machine`.
