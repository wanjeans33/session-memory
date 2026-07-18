import os from 'node:os';
import { git } from './git.mjs';

// Normalize a display name into a stable handle usable as a directory name,
// e.g. "Wang Jing" -> "wang-jing".
export function normalizeHandle(name) {
  const h = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return h || null;
}

// Who is saving/syncing on this machine. Resolution order:
//   1. SESSION_MEMORY_AUTHOR env var (explicit override)
//   2. git config user.name (global config also applies outside a repo)
//   3. OS account name
// Always returns a non-empty handle; "unknown" only if everything above is empty.
export function resolveAuthor({ env = process.env, cwd } = {}) {
  const fromEnv = normalizeHandle(env.SESSION_MEMORY_AUTHOR);
  if (fromEnv) return fromEnv;

  const fromGit = normalizeHandle(git(cwd ?? null, ['config', 'user.name']));
  if (fromGit) return fromGit;

  try {
    const fromOs = normalizeHandle(os.userInfo().username);
    if (fromOs) return fromOs;
  } catch {
    // fall through
  }
  return 'unknown';
}
