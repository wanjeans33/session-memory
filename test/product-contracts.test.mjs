import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scrapeClaude } from '../lib/capture/claude.mjs';
import { scrapeCodex } from '../lib/capture/codex.mjs';
import { read } from '../lib/commands/read.mjs';
import { main } from '../lib/main.mjs';
import { buildClaudeSession, buildCodexSession } from '../lib/util/native-import.mjs';
import {
  canonicalEvents,
  contentHashForEvents,
  loadLogicalSessions,
  saveSessionRevision,
  sha256,
} from '../lib/util/session-ledger.mjs';
import { encodeProject } from '../lib/util/transcript.mjs';

const ALICE = identity('alice', 'alice-laptop');
const BOB = identity('bob', 'bob-desktop');
const CAROL = identity('carol', 'carol-laptop');

function identity(name, device) {
  return {
    SESSION_MEMORY_AUTHOR: name,
    SESSION_MEMORY_ACTOR_ID: `${name}-id`,
    SESSION_MEMORY_DEVICE_ID: device,
    SESSION_MEMORY_ROLE: 'developer',
  };
}

function project(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `session-memory-${label}-`));
  const result = spawnSync('git', ['init', '--initial-branch=main'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function remove(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function claudeLines(id, cwd, turns) {
  const rows = [];
  let second = 0;
  for (const [user, assistant] of turns) {
    rows.push({
      type: 'user',
      timestamp: `2026-07-18T08:00:${String(second++).padStart(2, '0')}.000Z`,
      sessionId: id,
      cwd,
      gitBranch: 'main',
      version: 'test',
      message: { role: 'user', content: user },
    });
    rows.push({
      type: 'assistant',
      timestamp: `2026-07-18T08:00:${String(second++).padStart(2, '0')}.000Z`,
      sessionId: id,
      cwd,
      gitBranch: 'main',
      message: { role: 'assistant', content: [{ type: 'text', text: assistant }] },
    });
  }
  return rows.map((row) => JSON.stringify(row));
}

function writeClaude(file, id, cwd, turns) {
  writeFileSync(file, `${claudeLines(id, cwd, turns).join('\n')}\n`, 'utf8');
}

function saveClaude(file, env, at) {
  return scrapeClaude({
    transcriptPath: file,
    env,
    now: () => new Date(at),
  });
}

function appendCodexTurn(file, user, assistant, control = false) {
  const rows = [
    {
      timestamp: '2026-07-18T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] },
    },
    {
      timestamp: '2026-07-18T10:00:00.001Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: user },
    },
    {
      timestamp: '2026-07-18T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] },
    },
  ];
  if (control) {
    rows.push({
      timestamp: '2026-07-18T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: 'unchanged' },
    });
  }
  appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function filesUnder(root, predicate) {
  if (!existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (predicate(entry.name)) found.push(full);
    }
  }
  return found;
}

function rollouts(root) {
  return filesUnder(root, (name) => /^rollout-.*\.jsonl$/.test(name));
}

function sequence(prefix = 'id') {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function silent(fn) {
  const output = [];
  const warnings = [];
  const original = console.log;
  const originalWarn = console.warn;
  console.log = (value) => output.push(String(value));
  console.warn = (value) => warnings.push(String(value));
  try {
    return { result: fn(), output, warnings };
  } finally {
    console.log = original;
    console.warn = originalWarn;
  }
}

async function silentAsync(fn) {
  const output = [];
  const warnings = [];
  const original = console.log;
  const originalWarn = console.warn;
  console.log = (value) => output.push(String(value));
  console.warn = (value) => warnings.push(String(value));
  try {
    return { result: await fn(), output, warnings };
  } finally {
    console.log = original;
    console.warn = originalWarn;
  }
}

function writeV3Revision(root, { logicalId, revisionId, parents, lines, savedAt }) {
  const v3 = path.join(root, 'session-history', 'v3');
  const projectFile = path.join(v3, 'project.json');
  const sessionDir = path.join(v3, 'sessions', logicalId);
  const transcript = path.join(sessionDir, 'transcripts', `${revisionId}.jsonl`);
  const revisionFile = path.join(sessionDir, 'revisions', `${revisionId}.json`);
  mkdirSync(path.dirname(transcript), { recursive: true });
  mkdirSync(path.dirname(revisionFile), { recursive: true });
  if (!existsSync(projectFile)) {
    mkdirSync(v3, { recursive: true });
    writeFileSync(projectFile, '{"schema":3,"project_id":"legacy-project"}\n', 'utf8');
  }
  writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  const events = canonicalEvents(lines, 'claude-cli', { legacyToolValues: true });
  writeFileSync(revisionFile, `${JSON.stringify({
    schema: 3,
    project_id: 'legacy-project',
    logical_id: logicalId,
    revision_id: revisionId,
    parents,
    owner: 'alice',
    owner_actor_id: 'alice-id',
    author: 'alice',
    actor_id: 'alice-id',
    device_id: 'legacy-device',
    tool: 'claude-cli',
    native_session_id: 'legacy-native',
    content_hash: contentHashForEvents(events),
    content_hash_version: 2,
    event_count: events.length,
    saved_at: savedAt,
    ended_at: savedAt,
    transcript_ref: path.relative(root, transcript).replace(/\\/g, '/'),
  }, null, 2)}\n`, 'utf8');
}

function writeLegacyDigest(root, base, fields) {
  const dir = path.join(root, 'session-history', 'digests', 'alice');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify({
    schema: 2,
    tool: 'claude-cli',
    author: 'alice',
    machine: 'legacy-device',
    ended_at: '2026-07-01T10:00:00Z',
    ...fields,
  })}\n`, 'utf8');
}

function writeMarkerlessCodex(root, codexDir, id, prompt) {
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(path.join(codexDir, `rollout-${id}.jsonl`), `${[
    { type: 'session_meta', payload: { id, cwd: root, originator: 'session-memory' } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function importCodex(root, codexDir, env, options = {}) {
  return silent(() => read({
    import: true,
    all: true,
    targets: 'codex',
    scope: 'team',
    cwd: root,
    codexSessionsDir: codexDir,
    projectsDir: path.join(root, 'unused-claude'),
    env,
    uuidFactory: options.uuidFactory || sequence('native'),
    now: options.now || (() => new Date('2026-07-18T09:00:00.000Z')),
    ...options,
  })).result;
}

test('save is content-idempotent', () => {
  const root = project('unchanged');
  const source = path.join(root, 'source.jsonl');
  try {
    writeClaude(source, 'source-1', root, [['Plan the release', 'Release planned']]);
    assert.equal(saveClaude(source, ALICE, '2026-07-18T08:01:00Z').written, 1);
    const again = saveClaude(source, ALICE, '2026-07-18T08:02:00Z');
    assert.equal(again.written, 0);
    assert.equal(again.unchanged, 1);
    assert.equal(loadLogicalSessions(root)[0].revision_count, 1);
  } finally {
    remove(root);
  }
});

test('read followed by no work or a save control turn creates no revision', () => {
  const root = project('control-noop');
  const source = path.join(root, 'source.jsonl');
  const codexDir = path.join(root, 'codex-device');
  try {
    writeClaude(source, 'source-2', root, [['Write the plan', 'Plan written']]);
    saveClaude(source, ALICE, '2026-07-18T08:01:00Z');
    importCodex(root, codexDir, BOB);
    const rollout = rollouts(codexDir)[0];
    assert.ok(rollout);

    assert.equal(scrapeCodex({ rolloutPath: rollout, sessionsDir: codexDir, env: BOB }).unchanged, 1);
    appendCodexTurn(rollout, '$session-memory save', 'Nothing new to save.', true);
    const controlSave = scrapeCodex({ rolloutPath: rollout, sessionsDir: codexDir, env: BOB });
    assert.equal(controlSave.written, 0);
    assert.equal(controlSave.unchanged, 1);
    assert.equal(loadLogicalSessions(root)[0].revision_count, 1);
  } finally {
    remove(root);
  }
});

test('a real continuation keeps the logical id and parents the imported revision', () => {
  const root = project('continuation');
  const source = path.join(root, 'source.jsonl');
  const codexDir = path.join(root, 'codex-device');
  try {
    writeClaude(source, 'source-3', root, [['Create the design', 'Design created']]);
    saveClaude(source, ALICE, '2026-07-18T08:01:00Z');
    const before = loadLogicalSessions(root)[0];
    importCodex(root, codexDir, BOB);
    const rollout = rollouts(codexDir)[0];
    appendCodexTurn(rollout, 'Add deployment notes', 'Deployment notes added');

    const saved = scrapeCodex({
      rolloutPath: rollout,
      sessionsDir: codexDir,
      env: BOB,
      now: () => new Date('2026-07-18T10:01:00Z'),
    });
    assert.equal(saved.written, 1);
    const after = loadLogicalSessions(root);
    assert.equal(after.length, 1);
    assert.equal(after[0].logical_id, before.logical_id);
    assert.equal(after[0].revision_count, 2);
    assert.deepEqual(after[0].latest.parents, [before.latest_revision_id]);
  } finally {
    remove(root);
  }
});

test('read reuses one replica, updates it when clean, and blocks when dirty', () => {
  const root = project('read-upsert');
  const source = path.join(root, 'source.jsonl');
  const codexDir = path.join(root, 'codex-device');
  const turns = [['Base request', 'Base answer']];
  try {
    writeClaude(source, 'source-4', root, turns);
    saveClaude(source, ALICE, '2026-07-18T08:01:00Z');
    assert.equal(importCodex(root, codexDir, BOB).created, 1);
    const rollout = rollouts(codexDir)[0];

    assert.equal(importCodex(root, codexDir, BOB).skipped, 1);
    assert.equal(rollouts(codexDir).length, 1);

    turns.push(['Remote update', 'Remote answer']);
    writeClaude(source, 'source-4', root, turns);
    saveClaude(source, ALICE, '2026-07-18T08:02:00Z');
    assert.equal(importCodex(root, codexDir, BOB).updated, 1);
    assert.equal(rollouts(codexDir).length, 1);
    assert.match(readFileSync(rollout, 'utf8'), /Remote update/);

    appendCodexTurn(rollout, 'Unsaved local work', 'Local answer');
    const dirtyAtSameHead = importCodex(root, codexDir, BOB);
    assert.equal(dirtyAtSameHead.skipped, 0);
    assert.equal(dirtyAtSameHead.blocked, 1);
    turns.push(['New remote update', 'New remote answer']);
    writeClaude(source, 'source-4', root, turns);
    saveClaude(source, ALICE, '2026-07-18T08:03:00Z');
    const blocked = importCodex(root, codexDir, BOB);
    assert.equal(blocked.blocked, 1);
    const local = readFileSync(rollout, 'utf8');
    assert.match(local, /Unsaved local work/);
    assert.doesNotMatch(local, /New remote update/);
  } finally {
    remove(root);
  }
});

test('mine selects immutable ownership while team sees all sessions', () => {
  const root = project('ownership');
  const aliceSource = path.join(root, 'alice.jsonl');
  const bobSource = path.join(root, 'bob.jsonl');
  const emptyCodex = path.join(root, 'empty-codex');
  const emptyClaude = path.join(root, 'empty-claude');
  try {
    writeClaude(aliceSource, 'alice-source', root, [['Alice work', 'Done']]);
    writeClaude(bobSource, 'bob-source', root, [['Bob work', 'Done']]);
    saveClaude(aliceSource, ALICE, '2026-07-18T08:01:00Z');
    saveClaude(bobSource, BOB, '2026-07-18T08:02:00Z');

    const list = (scope, env) => silent(() => read({
      list: true,
      scope,
      cwd: root,
      codexSessionsDir: emptyCodex,
      projectsDir: emptyClaude,
      env,
    })).result;
    assert.deepEqual(list('mine', ALICE).map((row) => row.owner), ['alice']);
    assert.deepEqual(list('mine', BOB).map((row) => row.owner), ['bob']);
    assert.equal(list('team', CAROL).length, 2);
  } finally {
    remove(root);
  }
});

test('two devices may branch from one base, and read then requires --revision', () => {
  const root = project('heads');
  const source = path.join(root, 'source.jsonl');
  const deviceB = path.join(root, 'device-b');
  const deviceC = path.join(root, 'device-c');
  const target = path.join(root, 'target');
  try {
    writeClaude(source, 'source-5', root, [['Shared base', 'Base answer']]);
    saveClaude(source, ALICE, '2026-07-18T08:01:00Z');
    const base = loadLogicalSessions(root)[0];

    importCodex(root, deviceB, BOB, { uuidFactory: sequence('bob') });
    importCodex(root, deviceC, CAROL, { uuidFactory: sequence('carol') });
    appendCodexTurn(rollouts(deviceB)[0], 'Bob branch', 'Bob answer');
    appendCodexTurn(rollouts(deviceC)[0], 'Carol branch', 'Carol answer');
    scrapeCodex({ rolloutPath: rollouts(deviceB)[0], sessionsDir: deviceB, env: BOB, now: () => new Date('2026-07-18T10:01:00Z') });
    scrapeCodex({ rolloutPath: rollouts(deviceC)[0], sessionsDir: deviceC, env: CAROL, now: () => new Date('2026-07-18T10:02:00Z') });

    const branched = loadLogicalSessions(root)[0];
    assert.equal(branched.revision_count, 3);
    assert.equal(branched.heads.length, 2);
    assert.ok(branched.heads.every((head) => head.parents[0] === base.latest_revision_id));

    const ambiguous = importCodex(root, target, ALICE);
    assert.equal(ambiguous.created, 0);
    assert.equal(ambiguous.blocked, 1);

    const chosen = branched.heads[0].revision_id;
    const explicit = silent(() => read({
      import: true,
      ids: branched.logical_id,
      revision: chosen,
      targets: 'codex',
      scope: 'team',
      cwd: root,
      codexSessionsDir: target,
      projectsDir: path.join(root, 'unused-claude'),
      env: ALICE,
      uuidFactory: sequence('chosen'),
      now: () => new Date('2026-07-18T11:00:00Z'),
    })).result;
    assert.equal(explicit.created, 1);
    const meta = JSON.parse(readFileSync(rollouts(target)[0], 'utf8').split(/\r?\n/)[0]);
    assert.equal(meta.payload.session_memory.revision_id, chosen);
  } finally {
    remove(root);
  }
});

test('list and read --all preserve exactly 11 legacy sessions', () => {
  const root = project('eleven');
  const digestDir = path.join(root, 'session-history', 'digests', 'alice');
  const codexDir = path.join(root, 'codex-device');
  try {
    mkdirSync(digestDir, { recursive: true });
    for (let index = 1; index <= 11; index += 1) {
      const base = `2026-07-${String(index).padStart(2, '0')}_legacy-${index}`;
      writeFileSync(path.join(digestDir, `${base}.json`), `${JSON.stringify({
        schema: 2,
        id: `legacy-native-${index}`,
        tool: 'claude-cli',
        author: 'alice',
        machine: 'alice-pc',
        ended_at: `2026-07-${String(index).padStart(2, '0')}T10:00:00Z`,
        first_prompt: `legacy plan ${index}`,
      })}\n`, 'utf8');
    }

    const listed = silent(() => read({ list: true, scope: 'team', cwd: root, codexSessionsDir: codexDir, projectsDir: path.join(root, 'empty-claude'), env: BOB })).result;
    assert.equal(listed.length, 11);
    const imported = importCodex(root, codexDir, BOB, { uuidFactory: sequence('legacy-import') });
    assert.equal(imported.created, 11);
    assert.equal(rollouts(codexDir).length, 11);
    // Replicas produced by the oldest importer had originator=session-memory but no marker.
    for (const file of rollouts(codexDir).slice(0, 5)) {
      const lines = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
      const meta = JSON.parse(lines[0]);
      delete meta.payload.session_memory;
      lines[0] = JSON.stringify(meta);
      writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    }
    const after = silent(() => read({ list: true, scope: 'team', cwd: root, codexSessionsDir: codexDir, projectsDir: path.join(root, 'empty-claude'), env: BOB })).result;
    assert.equal(after.length, 11);
    assert.equal(after.filter((row) => row.pending_codex).length, 0);
  } finally {
    remove(root);
  }
});

test('schema-2 digest and transcript remain readable', () => {
  const root = project('schema2');
  const base = '2026-07-01_legacy-schema2';
  const digestDir = path.join(root, 'session-history', 'digests', 'alice');
  const transcriptDir = path.join(root, 'session-history', 'transcripts', 'alice');
  const transcriptRef = `session-history/transcripts/alice/${base}.jsonl`;
  const claudeDir = path.join(root, 'claude-device');
  try {
    mkdirSync(digestDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(path.join(root, transcriptRef), `${claudeLines('legacy-source', root, [['Legacy request', 'Legacy answer']]).join('\n')}\n`, 'utf8');
    writeFileSync(path.join(digestDir, `${base}.json`), `${JSON.stringify({
      schema: 2,
      id: 'legacy-source',
      tool: 'claude-cli',
      author: 'alice',
      machine: 'alice-pc',
      ended_at: '2026-07-01T10:00:00Z',
      first_prompt: 'wrong fallback',
      transcript_ref: transcriptRef,
    })}\n`, 'utf8');

    const listed = silent(() => read({ list: true, scope: 'team', cwd: root, projectsDir: claudeDir, codexSessionsDir: path.join(root, 'empty-codex'), env: BOB })).result;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'Legacy request');
    const imported = silent(() => read({
      import: true,
      all: true,
      targets: 'cli',
      scope: 'team',
      cwd: root,
      projectsDir: claudeDir,
      codexSessionsDir: path.join(root, 'empty-codex'),
      env: BOB,
      uuidFactory: sequence('legacy-claude'),
    })).result;
    assert.equal(imported.created, 1);
    const native = filesUnder(path.join(claudeDir, encodeProject(root)), (name) => name.endsWith('.jsonl'))[0];
    const text = readFileSync(native, 'utf8');
    assert.match(text, /Legacy request/);
    assert.match(text, /Legacy answer/);
    assert.equal(JSON.parse(text.split(/\r?\n/)[0]).sessionMemory.schema, 4);

    writeLegacyDigest(root, 'empty-schema2', { id: 'empty-legacy-source' });
    const emptyClaudeDir = path.join(root, 'empty-legacy-claude');
    const importEmpty = () => silent(() => read({
      import: true,
      ids: 'empty-schema2',
      targets: 'cli',
      scope: 'team',
      cwd: root,
      projectsDir: emptyClaudeDir,
      codexSessionsDir: path.join(root, 'empty-codex'),
      env: BOB,
      uuidFactory: sequence('empty-legacy'),
    })).result;
    assert.deepEqual([importEmpty().created, importEmpty().created], [0, 0]);
    assert.equal(filesUnder(path.join(emptyClaudeDir, encodeProject(root)), (name) => name.endsWith('.jsonl')).length, 0);
  } finally {
    remove(root);
  }
});

test('continuing one schema-3 head creates a mixed-DAG child and preserves the other head', () => {
  const root = project('mixed-dag');
  const logicalId = 'mixed-session';
  const base = claudeLines('legacy-native', root, [['Shared base', 'Base answer']]);
  const branchA = [...base, ...claudeLines('legacy-native', root, [['Branch A', 'A answer']])];
  const branchB = [...base, ...claudeLines('legacy-native', root, [['Branch B', 'B answer']])];
  try {
    writeV3Revision(root, { logicalId, revisionId: 'v3-base', parents: [], lines: base, savedAt: '2026-07-18T08:00:00Z' });
    writeV3Revision(root, { logicalId, revisionId: 'v3-a', parents: ['v3-base'], lines: branchA, savedAt: '2026-07-18T08:01:00Z' });
    writeV3Revision(root, { logicalId, revisionId: 'v3-b', parents: ['v3-base'], lines: branchB, savedAt: '2026-07-18T08:02:00Z' });
    const selected = loadLogicalSessions(root)[0].revisions.find((revision) => revision.revision_id === 'v3-a');

    const continued = saveSessionRevision({
      projectRoot: root,
      digest: { tool: 'claude-cli', native_session_id: 'v4-native', first_prompt: 'Shared base' },
      transcriptLines: [...branchA, ...claudeLines('v4-native', root, [['Continue A', 'A continued']])],
      marker: {
        schema: 4,
        logical_id: logicalId,
        revision_id: selected.revision_id,
        content_hash: selected.content_hash,
        owner: 'alice',
        owner_actor_id: 'alice-id',
      },
      env: BOB,
      now: () => new Date('2026-07-18T09:00:00Z'),
    });

    assert.equal(continued.status, 'saved');
    assert.deepEqual(continued.revision.parents, ['v3-a']);
    const mixed = loadLogicalSessions(root)[0];
    assert.equal(mixed.revision_count, 4);
    assert.deepEqual(mixed.heads.map((head) => head.revision_id).sort(), ['v3-b', continued.revision_id].sort());
    assert.equal(mixed.revisions.find((revision) => revision.revision_id === 'v3-b').source_schema, 3);
    assert.equal(mixed.revisions.find((revision) => revision.revision_id === continued.revision_id).source_schema, 4);
  } finally {
    remove(root);
  }
});

test('a schema-4 marker for a nonexistent revision cannot make an empty ledger a no-op', () => {
  const root = project('pseudo-marker');
  const lines = claudeLines('pseudo-native', root, [['Real content', 'Real answer']]);
  try {
    const result = saveSessionRevision({
      projectRoot: root,
      digest: { tool: 'claude-cli', native_session_id: 'pseudo-native', first_prompt: 'Real content' },
      transcriptLines: lines,
      marker: {
        schema: 4,
        logical_id: 'pseudo-session',
        revision_id: 'missing-revision',
        content_hash: contentHashForEvents(canonicalEvents(lines, 'claude-cli')),
        owner: 'alice',
        owner_actor_id: 'alice-id',
      },
      env: ALICE,
    });
    assert.equal(result.status, 'saved');
    assert.equal(result.logical_id, 'pseudo-session');
    assert.equal(loadLogicalSessions(root)[0].revision_count, 1);
  } finally {
    remove(root);
  }
});

test('legacy schema-2 ownership remains visible to --scope mine with author and actor identity', async () => {
  const root = project('legacy-mine');
  try {
    writeLegacyDigest(root, 'legacy-mine', { id: 'legacy-mine-native', first_prompt: 'Owned legacy plan' });
    const listed = await silentAsync(() => main([
      'read', '--list', '--scope', 'mine', '--author', 'alice', '--actor', 'alice',
      '--cwd', root,
      '--projects-dir', path.join(root, 'empty-claude'),
      '--sessions-dir', path.join(root, 'empty-codex'),
    ], process.env));
    assert.equal(listed.result.length, 1);
    assert.equal(listed.result[0].owner, 'alice');
  } finally {
    remove(root);
  }
});

test('native adapters preserve required shapes and canonical hashes', () => {
  const events = [
    { kind: 'user_message', content: 'Inspect the file' },
    { kind: 'tool_call', name: 'inspect', arguments: { path: 'src/a.js', depth: 2 } },
    { kind: 'tool_call', name: 'search', arguments: { query: 'TODO' } },
    { kind: 'tool_result', output: 'inspect-ok' },
    { kind: 'tool_result', output: 'search-ok' },
    { kind: 'assistant_message', content: 'Inspection complete' },
  ];
  const codexLines = buildCodexSession({
    events,
    id: 'codex-roundtrip',
    cwd: 'C:/project',
    marker: { schema: 4, logical_id: 'roundtrip', revision_id: 'rev-1' },
    importedAt: new Date('2026-07-18T10:00:00Z'),
    uuidFactory: sequence('roundtrip'),
  });
  const codexRows = codexLines.map((line) => JSON.parse(line));
  const codexCalls = codexRows.filter((row) => row.payload?.type === 'function_call');
  const codexResults = codexRows.filter((row) => row.payload?.type === 'function_call_output');
  assert.deepEqual(codexCalls.map((row) => JSON.parse(row.payload.arguments)), [events[1].arguments, events[2].arguments]);
  assert.equal(new Set(codexCalls.map((row) => row.payload.call_id)).size, 2);
  assert.deepEqual(codexResults.map((row) => row.payload.call_id), codexCalls.map((row) => row.payload.call_id));
  assert.equal(contentHashForEvents(canonicalEvents(codexLines, 'codex')), contentHashForEvents(events));

  const claudeLinesBuilt = buildClaudeSession({
    events,
    id: 'claude-roundtrip',
    cwd: 'C:/project',
    marker: { schema: 4, logical_id: 'roundtrip', revision_id: 'rev-1' },
    importedAt: new Date('2026-07-18T10:00:00Z'),
    uuidFactory: sequence('claude-row'),
  });
  const claudeRows = claudeLinesBuilt.map((line) => JSON.parse(line));
  for (const [index, row] of claudeRows.entries()) {
    assert.ok(row.uuid);
    assert.equal(row.parentUuid, index === 0 ? null : claudeRows[index - 1].uuid);
    assert.equal(row.isSidechain, false);
    assert.equal(row.userType, 'external');
  }
  const claudeCallIds = claudeRows.flatMap((row) => row.message?.content || [])
    .filter((item) => item.type === 'tool_use').map((item) => item.id);
  const claudeResultIds = claudeRows.flatMap((row) => row.message?.content || [])
    .filter((item) => item.type === 'tool_result').map((item) => item.tool_use_id);
  assert.equal(new Set(claudeCallIds).size, 2);
  assert.deepEqual(claudeResultIds, claudeCallIds);
  assert.equal(contentHashForEvents(canonicalEvents(claudeLinesBuilt, 'claude-cli')), contentHashForEvents(events));

  const malformedMiddle = [claudeLinesBuilt[0], '{malformed', ...claudeLinesBuilt.slice(1)];
  assert.throws(
    () => canonicalEvents(malformedMiddle, 'claude-cli'),
    /Invalid native transcript row/
  );
  assert.deepEqual(canonicalEvents(malformedMiddle, 'claude-cli', { allowMalformedRows: true }), events);
  assert.deepEqual(canonicalEvents([...claudeLinesBuilt, '{partial'], 'claude-cli'), events);
});

test('markerless session-memory replicas with zero or multiple matches do not abort list', () => {
  const root = project('markerless-safe');
  const codexDir = path.join(root, 'codex-device');
  try {
    writeLegacyDigest(root, 'ambiguous-a', { id: 'legacy-a', first_prompt: 'Ambiguous prompt' });
    writeLegacyDigest(root, 'ambiguous-b', { id: 'legacy-b', first_prompt: 'Ambiguous prompt' });
    writeLegacyDigest(root, 'known', { id: 'legacy-known', first_prompt: 'Known prompt' });
    writeMarkerlessCodex(root, codexDir, 'zero-match', 'Unknown prompt');
    writeMarkerlessCodex(root, codexDir, 'multi-match', 'Ambiguous prompt');

    const listed = silent(() => read({
      list: true,
      scope: 'team',
      cwd: root,
      projectsDir: path.join(root, 'empty-claude'),
      codexSessionsDir: codexDir,
      env: ALICE,
    }));
    assert.equal(listed.result.length, 3);
    assert.equal(listed.warnings.length, 2);
    assert.match(listed.warnings.join('\n'), /matched 0 legacy sessions/);
    assert.match(listed.warnings.join('\n'), /matched 2 legacy sessions/);
  } finally {
    remove(root);
  }
});

test('writes reject an escaping session-history link and an existing checkout lock', () => {
  const linkedRoot = project('linked-path');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'session-memory-outside-'));
  const lockedRoot = project('locked');
  const save = (root, id) => saveSessionRevision({
    projectRoot: root,
    digest: { tool: 'claude-cli', native_session_id: id, cwd: root, first_prompt: 'safe request' },
    transcriptLines: claudeLines(id, root, [['Safe request', 'Safe answer']]),
    env: ALICE,
  });
  try {
    symlinkSync(outside, path.join(linkedRoot, 'session-history'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => save(linkedRoot, 'linked-source'), /Refusing linked session-history/);

    const lockDir = path.join(os.tmpdir(), 'session-memory-ledger-locks');
    mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, `${sha256(realpathSync(lockedRoot))}.lock`);
    writeFileSync(lockFile, '{"pid":999999,"token":"other"}\n', { encoding: 'utf8', flag: 'wx' });
    try {
      assert.throws(() => save(lockedRoot, 'locked-source'), /Another session-memory write is in progress/);
    } finally {
      rmSync(lockFile, { force: true });
    }
  } finally {
    remove(linkedRoot);
    remove(outside);
    remove(lockedRoot);
  }
});
