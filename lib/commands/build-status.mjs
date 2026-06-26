import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mainRoot } from '../util/git.mjs';

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Aggregate session-history/digests/*.json + index.json grouped by branch; print compact JSON.
export function buildStatus({ repo, days = 0 } = {}) {
  const cwd = repo || process.cwd();
  const root = mainRoot(cwd);
  if (!root) throw new Error(`not a git repo: ${cwd}`);
  const histDir = path.join(root, 'session-history');

  let index = null;
  const indexPath = path.join(histDir, 'index.json');
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      index = null;
    }
  }

  const cutoff = days > 0 ? Date.now() - days * 86400000 : null;

  const sessions = [];
  const digDir = path.join(histDir, 'digests');
  if (existsSync(digDir)) {
    for (const name of readdirSync(digDir)) {
      if (!name.endsWith('.json')) continue;
      let d;
      try {
        d = JSON.parse(readFileSync(path.join(digDir, name), 'utf8'));
      } catch {
        continue;
      }
      if (cutoff && d.ended_at) {
        const t = Date.parse(d.ended_at);
        if (!Number.isNaN(t) && t < cutoff) continue;
      }
      sessions.push({
        ended_at: d.ended_at,
        tool: d.tool,
        branch: d.git ? d.git.branch : null,
        worktree: d.git ? d.git.worktree : null,
        turns: d.turns,
        first_prompt: d.first_prompt,
        summary: d.summary,
        files: d.files_touched,
        next_steps: d.next_steps,
      });
    }
  }

  const byBranch = new Map();
  for (const s of sessions) {
    const b = s.branch || '(unknown)';
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(s);
  }
  const groups = [...byBranch.entries()].map(([branch, list]) => {
    list.sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)));
    return { branch, session_count: list.length, sessions: list };
  });
  groups.sort((a, b) => b.session_count - a.session_count);

  const out = {
    generated_at: isoNow(),
    repo: path.basename(root),
    total_sessions: sessions.length,
    index,
    branches: groups,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}
