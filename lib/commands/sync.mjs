import { run } from '../util/run.mjs';
import { git } from '../util/git.mjs';
import { osName } from '../util/transcript.mjs';

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Sync the memory repository: pull latest, then (unless pull-only) commit and push local changes.
// Session history is not handled here — it lands per-project via `save`.
export function sync(repositoryDir, { pullOnly = false, dryRun = false } = {}) {
  run('git', ['pull', '--rebase', '--autostash'], { cwd: repositoryDir, dryRun });
  if (pullOnly) return;

  run('git', ['add', '-A'], { cwd: repositoryDir, dryRun });
  if (dryRun) {
    console.log('$ git commit / push (skipped: dry run)');
    return;
  }
  const changes = git(repositoryDir, ['status', '--porcelain']);
  if (changes && changes.trim()) {
    run('git', ['commit', '-m', `sync(${osName()}): ${stamp()}`], { cwd: repositoryDir });
    run('git', ['push'], { cwd: repositoryDir });
  }
}
