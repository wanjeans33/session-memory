import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitInfo } from '../util/git.mjs';
import { legacyLogicalId, loadLogicalSessions } from '../util/session-ledger.mjs';

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Collect *.json under dir, including digests/<author>/ subdirectories and legacy flat files.
function walkJson(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJson(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Aggregate session-history/digests/*.json + index.json grouped by branch; print compact JSON.
export function buildStatus({ repo, days = 0 } = {}) {
  const cwd = repo || process.cwd();
  const root = gitInfo(cwd).toplevel;
  if (!root) throw new Error(`not a git repo: ${cwd}`);
  const histDir = path.join(root, 'session-history');

  let index = null;
  const indexPath = path.join(histDir, 'index.json');
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid session-history index ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cutoff = days > 0 ? Date.now() - days * 86400000 : null;

  const byLogicalId = new Map();
  for (const session of loadLogicalSessions(root)) {
    if (session.latest) byLogicalId.set(session.logical_id, session.latest);
  }
  const digDir = path.join(histDir, 'digests');
  if (existsSync(digDir)) {
    for (const file of walkJson(digDir)) {
      let d;
      try {
        d = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`Invalid legacy session digest ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (cutoff && d.ended_at) {
        const t = Date.parse(d.ended_at);
        if (!Number.isNaN(t) && t < cutoff) continue;
      }
      const logicalId = legacyLogicalId(d, path.basename(file, '.json'));
      const previous = byLogicalId.get(logicalId);
      if (!previous || String(d.ended_at || '').localeCompare(String(previous.ended_at || '')) > 0) {
        byLogicalId.set(logicalId, { ...d, logical_id: logicalId });
      }
    }
  }

  const sessions = [];
  for (const d of byLogicalId.values()) {
      if (cutoff && d.ended_at) {
        const t = Date.parse(d.ended_at);
        if (!Number.isNaN(t) && t < cutoff) continue;
      }
      sessions.push({
        logical_id: d.logical_id || d.id,
        revision_id: d.revision_id || null,
        ended_at: d.ended_at,
        owner: d.owner ?? d.author ?? null,
        author: d.author ?? null,
        role: d.role ?? null,
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

  const byBranch = new Map();
  for (const s of sessions) {
    const b = s.branch || '(unknown)';
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(s);
  }
  const groups = [...byBranch.entries()].map(([branch, list]) => {
    list.sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)));
    const authors = [...new Set(list.map((s) => s.author).filter(Boolean))];
    return { branch, session_count: list.length, authors, sessions: list };
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
