import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, gitInfo } from '../util/git.mjs';

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Enumerate the repository's branch / worktree state into <project>/session-history/index.json.
export function repoStatus({ repo } = {}) {
  const cwd = repo || process.cwd();
  const root = gitInfo(cwd).toplevel;
  if (!root) throw new Error(`not a git repo: ${cwd}`);
  const rootLower = root.toLowerCase();

  let defaultBranch = 'main';
  if (!git(cwd, ['rev-parse', '--verify', '-q', 'refs/heads/main'])) {
    if (git(cwd, ['rev-parse', '--verify', '-q', 'refs/heads/master'])) defaultBranch = 'master';
  }

  // worktrees
  const worktrees = [];
  const wtRaw = git(cwd, ['worktree', 'list', '--porcelain']) || '';
  let cur = null;
  for (const line of wtRaw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) worktrees.push(cur);
      const p = line.slice(9).replace(/\\/g, '/').replace(/\/+$/, '');
      let rel;
      if (p === root) rel = '.';
      else if (p.toLowerCase().startsWith(`${rootLower}/`)) rel = p.slice(root.length).replace(/^\/+/, '');
      else rel = p;
      cur = { path: rel, branch: null, head: null, detached: false, locked: false };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice(5).slice(0, 7);
    } else if (line.startsWith('branch ')) {
      if (cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      if (cur) cur.detached = true;
    } else if (line.startsWith('locked')) {
      if (cur) cur.locked = true;
    }
  }
  if (cur) worktrees.push(cur);

  // branches with ahead/behind vs default and last commit
  const branches = [];
  const refs = git(cwd, ['for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(committerdate:iso-strict)|%(authorname)', 'refs/heads']) || '';
  for (const r of refs.split('\n')) {
    if (!r.trim()) continue;
    const parts = r.split('|');
    const name = parts[0];
    let ahead = 0;
    let behind = 0;
    if (name !== defaultBranch) {
      const lr = git(cwd, ['rev-list', '--left-right', '--count', `${defaultBranch}...${name}`]);
      if (lr) {
        const nums = lr.trim().split(/\s+/);
        if (nums.length >= 2) {
          behind = Number.parseInt(nums[0], 10) || 0;
          ahead = Number.parseInt(nums[1], 10) || 0;
        }
      }
    }
    branches.push({ name, head: parts[1], last_commit: parts[2], last_author: parts[3], ahead, behind });
  }

  const index = {
    generated_at: isoNow(),
    repo: path.basename(root),
    default_branch: defaultBranch,
    head: (git(cwd, ['rev-parse', '--short', 'HEAD']) || '').trim(),
    worktrees,
    branches,
  };

  const histDir = path.join(root, 'session-history');
  mkdirSync(histDir, { recursive: true });
  const outPath = path.join(histDir, 'index.json');
  writeFileSync(outPath, JSON.stringify(index, null, 2), 'utf8');
  console.log(outPath);
  return outPath;
}
