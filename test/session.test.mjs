import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNative } from '../lib/commands/install.mjs';
import { redact } from '../lib/util/redact.mjs';
import { encodeProject, parseClaudeTranscript, relFiles, splitLines } from '../lib/util/transcript.mjs';

test('redacts common secret shapes', () => {
  assert.match(redact('key sk-ant-ABCDEFGHIJKLMNOPQRSTUV'), /REDACTED:anthropic-key/);
  assert.match(redact('ghp_' + 'a'.repeat(36)), /REDACTED:github-token/);
  assert.match(redact('Authorization: Bearer abc.def-123'), /REDACTED:bearer/);
  assert.match(redact('password=hunter2secret'), /\[REDACTED\]/);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('encodeProject turns a path into a project folder name', () => {
  assert.equal(encodeProject('E:\\Github_project\\session-memory'), 'E--Github-project-session-memory');
  assert.equal(encodeProject('/Users/alice/proj.x'), '-Users-alice-proj-x');
});

test('splitLines drops a leading BOM and trailing CR', () => {
  assert.deepEqual(splitLines('﻿{"a":1}\r\n{"b":2}'), ['{"a":1}', '{"b":2}']);
});

test('parseClaudeTranscript extracts metadata, turns, files, and tools', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-20T10:00:00Z',
      sessionId: 'sid-1',
      cwd: '/p',
      gitBranch: 'main',
      version: '1.2',
      message: { role: 'user', content: 'fix the bug' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-20T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.js' } }] },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    }),
  ];
  const r = parseClaudeTranscript(lines);
  assert.equal(r.id, 'sid-1');
  assert.equal(r.branch, 'main');
  assert.equal(r.cwd, '/p');
  assert.equal(r.version, '1.2');
  assert.equal(r.started_at, '2026-06-20T10:00:00Z');
  assert.equal(r.ended_at, '2026-06-20T10:01:00Z');
  assert.equal(r.turns, 1); // tool_result-only user message does not count
  assert.equal(r.first_prompt, 'fix the bug');
  assert.deepEqual(r.files, ['/p/a.js']);
  assert.deepEqual(r.tools, { Edit: 1 });
});

test('relFiles makes paths relative to root with forward slashes', () => {
  assert.deepEqual(relFiles(['E:\\proj\\src\\a.js', 'E:\\other\\b.js'], 'E:\\proj'), ['src/a.js', 'E:/other/b.js']);
});

test('installNative installs skills into the target project, not global skill folders', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-install-'));
  const repo = path.join(root, 'memory-repo');
  const project = path.join(root, 'target-project');
  const home = path.join(root, 'home');

  try {
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'bin'), { recursive: true });
    mkdirSync(path.join(repo, 'lib'), { recursive: true });
    mkdirSync(path.join(repo, 'skills', 'session-memory'), { recursive: true });
    mkdirSync(path.join(repo, 'settings'), { recursive: true });
    mkdirSync(project, { recursive: true });

    installNative(
      repo,
      {
        home,
        claudeDir: path.join(home, '.claude'),
        codexSkillsDir: path.join(home, '.agents', 'skills'),
      },
      { projectDir: project }
    );

    const sourceSkill = path.join(repo, 'skills', 'session-memory');
    assert.equal(realpathSync(path.join(project, '.claude', 'skills', 'session-memory')), realpathSync(sourceSkill));
    assert.equal(realpathSync(path.join(project, '.agents', 'skills', 'session-memory')), realpathSync(sourceSkill));
    assert.equal(existsSync(path.join(home, '.claude', 'skills', 'session-memory')), false);
    assert.equal(existsSync(path.join(home, '.agents', 'skills', 'session-memory')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
