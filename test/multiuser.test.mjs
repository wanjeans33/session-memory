import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { normalizeHandle, resolveAuthor } from '../lib/util/author.mjs';
import { writeSessionDigest } from '../lib/util/digest.mjs';
import { read } from '../lib/commands/read.mjs';
import { sync } from '../lib/commands/sync.mjs';

test('normalizeHandle produces stable directory-safe handles', () => {
  assert.equal(normalizeHandle('Wang Jing'), 'wang-jing');
  assert.equal(normalizeHandle('  Alice  '), 'alice');
  assert.equal(normalizeHandle('bob@example.com'), 'bob-example.com');
  assert.equal(normalizeHandle('---'), null);
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle(null), null);
});

test('resolveAuthor prefers the SESSION_MEMORY_AUTHOR env override', () => {
  assert.equal(resolveAuthor({ env: { SESSION_MEMORY_AUTHOR: 'Team Bot 01' } }), 'team-bot-01');
});

test('writeSessionDigest namespaces files by author', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-digest-'));
  try {
    const digest = {
      schema: 2,
      id: 'abc12345-0000',
      tool: 'claude-cli',
      author: 'alice',
      ended_at: '2026-07-05T10:00:00Z',
    };
    const p = writeSessionDigest({ digest, redactedLines: ['{"a":1}'], projectRoot: root });
    assert.match(p.replace(/\\/g, '/'), /session-history\/digests\/alice\/2026-07-05_.*-claude-cli-abc12345\.json$/);
    assert.match(digest.transcript_ref, /^session-history\/transcripts\/alice\//);
    assert.ok(existsSync(path.join(root, digest.transcript_ref)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeSessionDigest fills a missing author', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-digest-'));
  try {
    const digest = { schema: 2, id: 'def6789', tool: 'codex', ended_at: '2026-07-05T11:00:00Z' };
    writeSessionDigest({ digest, projectRoot: root });
    assert.ok(digest.author && digest.author.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read --list walks author subdirectories and legacy flat files, and filters by author', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-read-'));
  const digests = path.join(root, 'session-history', 'digests');
  try {
    mkdirSync(path.join(digests, 'alice'), { recursive: true });
    writeFileSync(
      path.join(digests, 'alice', '2026-07-05_100000-claude-cli-aaaa.json'),
      JSON.stringify({ schema: 2, author: 'alice', tool: 'claude-cli', machine: 'm1', ended_at: '2026-07-05T10:00:00Z', first_prompt: 'a' }),
      'utf8'
    );
    writeFileSync(
      path.join(digests, '2026-07-04_090000-codex-bbbb.json'),
      JSON.stringify({ schema: 1, tool: 'codex', machine: 'm2', ended_at: '2026-07-04T09:00:00Z', first_prompt: 'b' }),
      'utf8'
    );

    const capture = [];
    const orig = console.log;
    console.log = (s) => capture.push(s);
    try {
      read({ list: true, cwd: root });
    } finally {
      console.log = orig;
    }
    const rows = JSON.parse(capture.join('\n'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].author, 'alice'); // newest first
    assert.equal(rows[1].author, null); // legacy digest without author

    capture.length = 0;
    console.log = (s) => capture.push(s);
    try {
      read({ list: true, cwd: root, author: 'alice' });
    } finally {
      console.log = orig;
    }
    assert.equal(JSON.parse(capture.join('\n')).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const runGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

test('sync commits only whitelisted paths, never git add -A', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-sync-'));
  try {
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    mkdirSync(origin, { recursive: true });
    runGit(origin, ['init', '--bare', '--initial-branch=main']);
    runGit(root, ['clone', origin, work]);
    runGit(work, ['config', 'user.name', 'tester']);
    runGit(work, ['config', 'user.email', 'tester@example.com']);
    writeFileSync(path.join(work, 'README.md'), 'seed\n', 'utf8');
    runGit(work, ['add', 'README.md']);
    runGit(work, ['commit', '-m', 'seed']);
    runGit(work, ['push', '-u', 'origin', 'main']);

    mkdirSync(path.join(work, 'memory'), { recursive: true });
    writeFileSync(path.join(work, 'memory', 'fact.md'), 'a fact\n', 'utf8');
    writeFileSync(path.join(work, 'stray.txt'), 'not synced\n', 'utf8');

    sync(work);

    const committed = runGit(work, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.match(committed, /memory\/fact\.md/);
    assert.doesNotMatch(committed, /stray\.txt/);
    const status = runGit(work, ['status', '--porcelain']);
    assert.match(status, /\?\? stray\.txt/); // left untouched for its owner to handle
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
