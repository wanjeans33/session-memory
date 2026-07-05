import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../util/run.mjs';
import { git } from '../util/git.mjs';
import { osName } from '../util/transcript.mjs';

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Paths the automatic sync is allowed to commit. Never `git add -A`: with several
// people (or machines) sharing the repository, a blanket add would sweep up files
// the current writer does not own — rebase leftovers, another user's half-pushed
// work, stray artifacts.
const SYNC_PATHS = ['CLAUDE.md', 'AGENTS.md', 'memory', 'settings', 'shared', 'users', 'sessions'];

const PUSH_ATTEMPTS = 3;

// Sync the memory repository: pull latest, then (unless pull-only) commit and push
// local changes. Concurrent pushers race on `git push`, so a rejected push is
// retried after another rebase. Session history is not handled here — it lands
// per-project via `save`.
export function sync(repositoryDir, { pullOnly = false, dryRun = false } = {}) {
  run('git', ['pull', '--rebase', '--autostash'], { cwd: repositoryDir, dryRun });
  if (pullOnly) return;

  const addPaths = SYNC_PATHS.filter((p) => existsSync(path.join(repositoryDir, p)));
  if (addPaths.length === 0) return;
  run('git', ['add', '--', ...addPaths], { cwd: repositoryDir, dryRun });
  if (dryRun) {
    console.log('$ git commit / push (skipped: dry run)');
    return;
  }
  const changes = git(repositoryDir, ['status', '--porcelain', '--', ...addPaths]);
  if (!changes || !changes.trim()) return;

  run('git', ['commit', '-m', `sync(${osName()}): ${stamp()}`], { cwd: repositoryDir });
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    try {
      run('git', ['push'], { cwd: repositoryDir });
      return;
    } catch (err) {
      if (attempt === PUSH_ATTEMPTS) throw err;
      console.log(`push rejected (attempt ${attempt}/${PUSH_ATTEMPTS}), rebasing and retrying…`);
      run('git', ['pull', '--rebase', '--autostash'], { cwd: repositoryDir });
    }
  }
}
