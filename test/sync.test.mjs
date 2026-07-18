import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sync } from '../lib/commands/sync.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

test('sync commits only its allowlisted paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-sync-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  try {
    mkdirSync(origin, { recursive: true });
    git(origin, ['init', '--bare', '--initial-branch=main']);
    git(root, ['clone', origin, work]);
    git(work, ['config', 'user.name', 'tester']);
    git(work, ['config', 'user.email', 'tester@example.com']);
    writeFileSync(path.join(work, 'README.md'), 'seed\n', 'utf8');
    git(work, ['add', 'README.md']);
    git(work, ['commit', '-m', 'seed']);
    git(work, ['push', '-u', 'origin', 'main']);

    mkdirSync(path.join(work, 'memory'), { recursive: true });
    writeFileSync(path.join(work, 'memory', 'fact.md'), 'shared\n', 'utf8');
    writeFileSync(path.join(work, 'stray.txt'), 'private\n', 'utf8');
    sync(work);

    assert.match(git(work, ['show', '--name-only', '--pretty=format:', 'HEAD']), /memory\/fact\.md/);
    assert.doesNotMatch(git(work, ['show', '--name-only', '--pretty=format:', 'HEAD']), /stray\.txt/);
    assert.match(git(work, ['status', '--porcelain']), /\?\? stray\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
