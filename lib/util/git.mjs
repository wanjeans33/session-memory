import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Run `git -C <cwd> <args>` and return trimmed stdout, or null on failure.
export function git(cwd, args) {
  const full = cwd ? ['-C', cwd, ...args] : args;
  const result = spawnSync('git', full, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? '').replace(/\r/g, '');
}

function firstLine(text) {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

const toFwd = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// Parent directory of an already forward-slashed absolute path.
function parentFwd(p) {
  return toFwd(p).replace(/\/[^/]*$/, '');
}

// Absolute path of the repository's main worktree root (the parent of git-common-dir).
export function mainRoot(cwd) {
  const commonDir = firstLine(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (!commonDir) return null;
  return parentFwd(commonDir);
}

// Branch / HEAD / worktree info for a working directory. Mirrors the former _lib Get-GitInfo.
export function gitInfo(cwd) {
  const info = {
    branch: null,
    head: null,
    dirty: false,
    is_worktree: false,
    worktree: null,
    toplevel: null,
    main_root: null,
  };
  if (!cwd || !existsSync(cwd)) return info;

  const top = firstLine(git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel']));
  if (!top) return info;
  info.toplevel = toFwd(top);

  const commonDir = firstLine(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (commonDir) info.main_root = parentFwd(commonDir);

  if (info.main_root) {
    const tl = info.toplevel.toLowerCase();
    const mr = info.main_root.toLowerCase();
    info.is_worktree = tl !== mr;
    if (info.is_worktree && tl.startsWith(`${mr}/`)) {
      info.worktree = info.toplevel.slice(info.main_root.length).replace(/^\/+/, '');
    }
  }

  info.branch = firstLine(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
  info.head = firstLine(git(cwd, ['rev-parse', '--short', 'HEAD']));
  info.dirty = Boolean(firstLine(git(cwd, ['status', '--porcelain'])));
  return info;
}
