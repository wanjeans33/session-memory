export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [name, inlineValue] = token.slice(2).split('=', 2);
    if (['dry-run', 'yes', 'help'].includes(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`Option --${name} does not accept a value.`);
      }
      options[name] = true;
      continue;
    }

    if (!['repo-url', 'repo-dir', 'dir'].includes(name)) {
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

Commands:
  init     Clone a private memory repository into a stable local directory and install it.
  install  Install an existing local memory repository for Claude Code and Codex.
  doctor   Check Node, Git, repository layout, and Claude/Codex skill links.
  update   Fast-forward a clean local repository and rerun its installer.

Options:
  --repo-url <git-url>  Private repository URL used by init.
  --repo-dir <path>     Existing local repository used by install, doctor, or update.
  --dir <path>          Destination directory used by init.
  --dry-run             Show filesystem and process actions without changing state.
  --yes                 Reserved for non-interactive confirmation compatibility.
  --help                Show this help text.`;
