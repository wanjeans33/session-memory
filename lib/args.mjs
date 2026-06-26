const BOOLEAN_FLAGS = ['dry-run', 'yes', 'help', 'pull-only', 'all', 'current', 'commit', 'list', 'import', 'force'];
const VALUE_OPTIONS = ['repo-url', 'repo-dir', 'dir', 'cwd', 'repo', 'days', 'ids', 'targets', 'projects-dir', 'sessions-dir', 'desktop-sessions-dir'];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [name, inlineValue] = token.slice(2).split('=', 2);
    if (BOOLEAN_FLAGS.includes(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`Option --${name} does not accept a value.`);
      }
      options[name] = true;
      continue;
    }

    if (!VALUE_OPTIONS.includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }

    const value = inlineValue ?? rest[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options[name] = value;
  }

  return { command, options };
}

export const HELP = `Usage:
  session-memory init --repo-url <git-url> [--dir <path>] [--dry-run]
  session-memory install [--repo-dir <path>] [--dry-run]
  session-memory doctor [--repo-dir <path>]
  session-memory update [--repo-dir <path>] [--dry-run]
  session-memory sync [--pull-only] [--repo-dir <path>] [--dry-run]
  session-memory save [--all] [--commit] [--cwd <path>]
  session-memory read [--list | --import --ids <a,b,…>] [--targets cli,desktop] [--cwd <path>]
  session-memory repo-status [--repo <path>]
  session-memory build-status [--repo <path>] [--days <n>]

Setup commands:
  init     Clone a private memory repository into a stable local directory and install it.
  install  Install an existing local memory repository for Claude Code and Codex.
  doctor   Check Node, Git, repository layout, and Claude/Codex skill links.
  update   Fast-forward a clean local repository and rerun its installer.

Runtime commands:
  sync          Pull (and unless --pull-only commit + push) the memory repository. Used by hooks.
  save          Capture sessions into the current project's session-history/.
  read          Import other clients' sessions into the current client's list.
  repo-status   Write the branch/worktree index to session-history/index.json.
  build-status  Print session-history aggregated by branch (consumed by the get workflow).

Options:
  --repo-url <git-url>  Private repository URL used by init.
  --repo-dir <path>     Existing local memory repository (install/doctor/update/sync).
  --dir <path>          Destination directory used by init.
  --repo <path>         Any path inside the target project (repo-status/build-status).
  --cwd <path>          Working directory for save/read (defaults to the current directory).
  --all                 save: scan every client on this machine.
  --commit              save: commit the project's session-history/ afterwards.
  --pull-only           sync: pull only, do not commit or push (SessionStart hook).
  --list                read: list importable sessions in this project.
  --import              read: perform the import (with --ids).
  --ids <a,b,…>         read: comma-separated session bases to import.
  --targets <list>      read: import targets, e.g. cli,desktop (default cli).
  --days <n>            build-status: only include sessions from the last n days.
  --dry-run             Show filesystem and process actions without changing state.
  --yes                 Reserved for non-interactive confirmation compatibility.
  --help                Show this help text.`;
