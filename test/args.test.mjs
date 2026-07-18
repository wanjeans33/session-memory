import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../lib/args.mjs';
import { getPaths } from '../lib/paths.mjs';

test('parses the save and read product commands', () => {
  assert.deepEqual(
    parseArgs(['save', '--current', '--codex-session-id', 'native-1', '--author', 'alice']),
    { command: 'save', options: { current: true, 'codex-session-id': 'native-1', author: 'alice' } }
  );
  assert.deepEqual(
    parseArgs(['read', '--import', '--ids', 'logical-1', '--revision', 'rev-1', '--targets', 'codex', '--scope', 'team']),
    {
      command: 'read',
      options: {
        import: true,
        ids: 'logical-1',
        revision: 'rev-1',
        targets: 'codex',
        scope: 'team',
      },
    }
  );
});

test('rejects ambiguous or unsupported command options', () => {
  assert.throws(() => parseArgs(['save', '--all', '--current']), /either --all or --current/);
  assert.throws(() => parseArgs(['read', '--list', '--import']), /either --list or --import/);
  assert.throws(() => parseArgs(['read', '--ids', 'logical-1']), /require --import/);
  assert.throws(() => parseArgs(['read', '--import', '--all', '--revision', 'rev-1']), /requires exactly one --ids/);
  assert.throws(() => parseArgs(['read', '--force']), /Unknown option/);
});

test('uses stable platform-specific storage paths', () => {
  assert.equal(getPaths({ HOME: '/home/alice' }, 'linux').repositoryDir, '/home/alice/.local/share/session-memory');
  assert.equal(
    getPaths({ USERPROFILE: 'C:\\Users\\Alice', LOCALAPPDATA: 'C:\\Local' }, 'win32').repositoryDir,
    'C:\\Local\\session-memory'
  );
});
