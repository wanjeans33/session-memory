import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

const pad = (n) => String(n).padStart(2, '0');

// Local-time stamp "yyyy-MM-dd_HHmmss" used in digest/transcript filenames.
function stamp(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// Write a digest (+ optional redacted transcript) into a project's session-history/.
// Files are UTF-8 without BOM and use \n line endings for clean git diffs.
export function writeSessionDigest({ digest, redactedLines, projectRoot }) {
  if (!projectRoot) throw new Error('projectRoot required');
  const histDir = path.join(projectRoot, 'session-history');
  const digestDir = path.join(histDir, 'digests');
  const tsDir = path.join(histDir, 'transcripts');
  mkdirSync(digestDir, { recursive: true });

  const ended = stamp(digest.ended_at);
  const idClean = String(digest.id ?? '').replace(/[^A-Za-z0-9]/g, '');
  const shortId = idClean.slice(0, 8);
  const base = `${ended}-${digest.tool}-${shortId}`;

  if (redactedLines) {
    mkdirSync(tsDir, { recursive: true });
    const tsPath = path.join(tsDir, `${base}.jsonl`);
    writeFileSync(tsPath, redactedLines.join('\n') + '\n', 'utf8');
    digest.transcript_ref = `session-history/transcripts/${base}.jsonl`;
  }

  const digestPath = path.join(digestDir, `${base}.json`);
  writeFileSync(digestPath, JSON.stringify(digest, null, 2), 'utf8');
  return digestPath;
}

// Commit only session-history/ in a project (used by `save --commit`; never `add -A`).
export function commitSessionHistory(projectRoot, message = 'chore(session-history): update') {
  git(projectRoot, ['add', '--', 'session-history']);
  const status = git(projectRoot, ['status', '--porcelain', '--', 'session-history']);
  if (status && status.trim()) {
    git(projectRoot, ['commit', '-q', '-m', message, '--', 'session-history']);
    return true;
  }
  return false;
}
