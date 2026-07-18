import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installNative } from '../lib/commands/install.mjs';
import { redact, redactJsonLine } from '../lib/util/redact.mjs';
import { cleanRealUserText, isSessionMemoryControlText } from '../lib/util/user-text.mjs';

function silent(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

test('redacts common credentials', () => {
  assert.match(redact(`token ghp_${'a'.repeat(36)}`), /REDACTED:github-token/);
  assert.match(redact('Authorization: Bearer abc.def-123'), /REDACTED:bearer/);
  assert.match(redact('password=hunter2secret'), /REDACTED/);
  assert.equal(redact('ordinary text'), 'ordinary text');
  const escaped = redactJsonLine(JSON.stringify({
    code: `const token = "ghp_${'a'.repeat(36)}";\nconst path = "C:\\\\tmp";`,
  }));
  assert.doesNotThrow(() => JSON.parse(escaped));
  assert.match(JSON.parse(escaped).code, /REDACTED/);
  assert.doesNotMatch(JSON.parse(escaped).code, /ghp_/);
});

test('recognizes only pure session-memory control turns', () => {
  assert.equal(isSessionMemoryControlText('$session-memory save --current --commit'), true);
  assert.equal(isSessionMemoryControlText('/session-memory read --import --ids logical-1 --targets codex'), true);
  assert.equal(cleanRealUserText('$session-memory save'), null);
  assert.equal(cleanRealUserText('$session-memory save, then fix the bug'), '$session-memory save, then fix the bug');
});

test('skills-only install links the skill into the project and touches no personal state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-memory-install-'));
  const repo = path.join(root, 'memory-repo');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  try {
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'skills', 'session-memory'), { recursive: true });
    mkdirSync(project, { recursive: true });
    silent(() => installNative(
      repo,
      {
        home,
        claudeDir: path.join(home, '.claude'),
        codexSkillsDir: path.join(home, '.agents', 'skills'),
      },
      { projectDir: project, skillsOnly: true }
    ));

    const source = realpathSync(path.join(repo, 'skills', 'session-memory'));
    assert.equal(realpathSync(path.join(project, '.claude', 'skills', 'session-memory')), source);
    assert.equal(realpathSync(path.join(project, '.agents', 'skills', 'session-memory')), source);
    assert.equal(existsSync(path.join(home, '.claude', 'CLAUDE.md')), false);
    assert.equal(existsSync(path.join(home, '.claude', 'settings.json')), false);
    assert.equal(existsSync(path.join(repo, 'memory')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
