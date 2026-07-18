const BOOLEAN_FLAGS = ['dry-run', 'yes', 'help', 'pull-only', 'all', 'current', 'commit', 'publish', 'list', 'import', 'pending', 'skills-only'];
const VALUE_OPTIONS = ['repo-url', 'repo-dir', 'project-dir', 'dir', 'cwd', 'repo', 'days', 'ids', 'revision', 'targets', 'author', 'actor', 'device', 'scope', 'role', 'owner', 'source-author', 'source-role', 'codex-session-id', 'projects-dir', 'sessions-dir', 'desktop-sessions-dir'];

const COMMON_OPTIONS = ['help', 'yes'];
const COMMAND_OPTIONS = new Map([
  ['init', new Set([...COMMON_OPTIONS, 'repo-url', 'dir', 'project-dir', 'dry-run'])],
  ['install', new Set([...COMMON_OPTIONS, 'repo-dir', 'project-dir', 'skills-only', 'dry-run'])],
  ['doctor', new Set([...COMMON_OPTIONS, 'repo-dir', 'project-dir'])],
  ['update', new Set([...COMMON_OPTIONS, 'repo-dir', 'project-dir', 'dry-run'])],
  ['sync', new Set([...COMMON_OPTIONS, 'repo-dir', 'pull-only', 'dry-run'])],
  ['save', new Set([...COMMON_OPTIONS, 'all', 'current', 'commit', 'publish', 'author', 'actor', 'device', 'role', 'codex-session-id', 'cwd'])],
  ['read', new Set([
    ...COMMON_OPTIONS,
    'list', 'import', 'ids', 'revision', 'all', 'pending', 'targets',
    'author', 'actor', 'scope', 'owner', 'source-author', 'source-role',
    'cwd', 'projects-dir', 'sessions-dir', 'desktop-sessions-dir',
  ])],
  ['repo-status', new Set([...COMMON_OPTIONS, 'repo'])],
  ['build-status', new Set([...COMMON_OPTIONS, 'repo', 'days'])],
]);

function validateCommandOptions(command, options) {
  const allowed = COMMAND_OPTIONS.get(command);
  if (allowed) {
    for (const name of Object.keys(options)) {
      if (!allowed.has(name)) throw new Error(`Option --${name} is not valid for ${command}.`);
    }
  }
  if (command === 'save') {
    if (options.all && options.current) throw new Error('save accepts either --all or --current, not both.');
    if (options.all && options['codex-session-id']) throw new Error('save --codex-session-id cannot be combined with --all.');
    if (options.commit && options.publish) throw new Error('save accepts either --commit or --publish, not both.');
  }
  if (command === 'read') {
    if (options.list && options.import) throw new Error('read accepts either --list or --import, not both.');
    if (options.ids && options.all) throw new Error('read --import accepts either --ids or --all, not both.');
    if ((options.ids || options.all || options.revision || options.targets) && !options.import) {
      throw new Error('read --ids, --all, --revision, and --targets require --import.');
    }
    if (options.revision && (options.all || String(options.ids || '').split(',').filter(Boolean).length !== 1)) {
      throw new Error('read --revision requires exactly one --ids logical session and cannot use --all.');
    }
    if (options.pending && options.import) throw new Error('read --pending is only valid with --list.');
  }
}

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

  validateCommandOptions(command, options);
  return { command, options };
}

export const HELP = `Usage:
  session-memory init --repo-url <git-url> [--dir <path>] [--project-dir <path>] [--dry-run]
  session-memory install [--repo-dir <path>] [--project-dir <path>] [--skills-only] [--dry-run]
  session-memory doctor [--repo-dir <path>] [--project-dir <path>]
  session-memory update [--repo-dir <path>] [--project-dir <path>] [--dry-run]
  session-memory sync [--pull-only] [--repo-dir <path>] [--dry-run]
  session-memory save [--current | --all] [--codex-session-id <id>] [--commit | --publish] [--author <handle>] [--actor <id>] [--device <id>] [--role <role>] [--cwd <path>]
  session-memory read [--list [--pending] | --import (--ids <a,b,…> | --all) [--revision <id>]] [--targets claude-code,desktop,codex] [--scope mine|team] [--author <self>] [--actor <self-id>] [--owner <actor-id>] [--source-author <handle>] [--source-role <role>] [--cwd <path>] [--projects-dir <path>] [--sessions-dir <path>] [--desktop-sessions-dir <path>]
  session-memory repo-status [--repo <path>]
  session-memory build-status [--repo <path>] [--days <n>]

Setup commands:
  init     Clone a private memory repository into a stable local directory and install it.
  install  Install an existing local memory repository and repo-local skills.
  doctor   Check Node, Git, repository layout, and repo-local Claude/Codex skill links.
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
  --project-dir <path>  Target project for .claude/.agents skill links (defaults to current directory).
  --skills-only         install: only link skills into the target project (per-project session
                        sharing); skip personal memory sync, CLAUDE.md import, and hooks.
  --dir <path>          Destination directory used by init.
  --repo <path>         Any path inside the target project (repo-status/build-status).
  --cwd <path>          Working directory for save/read (defaults to the current directory).
  --all                 save: scan every client; read --import: choose every candidate.
  --current             save: explicitly select current-session mode (the default).
  --codex-session-id    save: require one exact Codex native session in the current checkout.
  --commit              save: commit the project's session-history/ afterwards.
  --publish             save: commit session-history/ and push the current branch (explicit opt-in).
  --pull-only           sync: pull only, do not commit or push (SessionStart hook).
  --list                read: list importable sessions in this project.
  --pending             read --list: show sessions absent from the configured Codex native store.
  --import              read: perform the import (with --ids or --all).
  --ids <a,b,…>         read: comma-separated logical IDs; legacy base values are also accepted.
  --revision <id>       read: choose one explicit revision when a logical session has multiple heads.
  --targets <list>      read: import targets from claude-code,desktop,codex (cli is an alias).
  --sessions-dir <path> read: override the Codex sessions directory (default $CODEX_HOME/sessions).
  --projects-dir <path> read: override the Claude projects directory.
  --desktop-sessions-dir <path> read: override the Claude Desktop descriptor directory.
  --author <handle>     Current actor's normalized Unicode author handle.
  --actor <id>          Current actor's stable identity (also used by read --scope mine).
  --device <id>         save: device metadata (or set SESSION_MEMORY_DEVICE_ID).
  --scope <mine|team>   read: select the current actor's sessions or every team-visible session (default: team).
  --role <role>         save: acting role stored on new revisions.
  --owner <actor-id>    read: filter logical sessions by immutable owner actor id.
  --source-author <h>   read: filter by the selected revision's author; use --owner for ownership.
  --source-role <role>  read: filter by the selected revision's acting role.
  --days <n>            build-status: only include the last n days (non-negative whole number).
  --dry-run             Show filesystem and process actions without changing state.
  --yes                 Reserved for non-interactive confirmation compatibility.
  --help                Show this help text.`;
