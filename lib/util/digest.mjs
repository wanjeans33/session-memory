import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { run } from './run.mjs';
import { resolveAuthor } from './author.mjs';

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
// The author gets its own subdirectory so concurrent writers never touch each
// other's files (digests/<author>/…, transcripts/<author>/…).
export function writeSessionDigest({ digest, redactedLines, projectRoot }) {
  if (!projectRoot) throw new Error('projectRoot required');
  if (!digest.author) digest.author = resolveAuthor({ cwd: projectRoot });
  const histDir = path.join(projectRoot, 'session-history');
  const digestDir = path.join(histDir, 'digests', digest.author);
  const tsDir = path.join(histDir, 'transcripts', digest.author);
  mkdirSync(digestDir, { recursive: true });

  const ended = stamp(digest.ended_at);
  const idClean = String(digest.id ?? '').replace(/[^A-Za-z0-9]/g, '');
  const shortId = idClean.slice(0, 8);
  const base = `${ended}-${digest.tool}-${shortId}`;

  if (redactedLines) {
    mkdirSync(tsDir, { recursive: true });
    const tsPath = path.join(tsDir, `${base}.jsonl`);
    writeFileSync(tsPath, redactedLines.join('\n') + '\n', 'utf8');
    digest.transcript_ref = `session-history/transcripts/${digest.author}/${base}.jsonl`;
  }

  const digestPath = path.join(digestDir, `${base}.json`);
  writeFileSync(digestPath, JSON.stringify(digest, null, 2), 'utf8');
  return digestPath;
}

// Commit only session-history/ in a project (used by `save --commit`; never `add -A`).
export function commitSessionHistory(projectRoot, message = 'chore(session-history): update') {
  if (!existsSync(path.join(projectRoot, 'session-history'))) return false;
  run('git', ['add', '--', 'session-history'], { cwd: projectRoot });
  const status = git(projectRoot, ['status', '--porcelain', '--', 'session-history']);
  if (status === null) throw new Error('Could not inspect staged session-history changes.');
  if (status && status.trim()) {
    run('git', ['commit', '-q', '-m', message, '--', 'session-history'], { cwd: projectRoot });
    return true;
  }
  return false;
}
