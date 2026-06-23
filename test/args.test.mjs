import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../lib/args.mjs';
import { getPaths } from '../lib/paths.mjs';

test('parses init options', () => {
  assert.deepEqual(parseArgs(['init', '--repo-url', 'git@example.com:me/memory.git', '--dir=/tmp/memory', '--dry-run']), {
    command: 'init',
    options: { 'repo-url': 'git@example.com:me/memory.git', dir: '/tmp/memory', 'dry-run': true },
  });
});

test('rejects unknown and missing option values', () => {
  assert.throws(() => parseArgs(['init', '--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['init', '--repo-url']), /requires a value/);
});

test('uses platform-specific stable paths', () => {
  assert.deepEqual(getPaths({ HOME: '/home/alice' }, 'linux').repositoryDir, '/home/alice/.local/share/session-memory');
  assert.deepEqual(getPaths({ USERPROFILE: 'C:\\Users\\Alice', LOCALAPPDATA: 'C:\\Local' }, 'win32').repositoryDir, 'C:\\Local\\session-memory');
});
