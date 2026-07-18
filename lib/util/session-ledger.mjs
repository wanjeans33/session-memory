import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHandle, resolveAuthor } from './author.mjs';
import { redactJsonLine } from './redact.mjs';
import { sessionSourceKey } from './session-source.mjs';
import { cleanRealUserText, isSessionMemoryControlText } from './user-text.mjs';

const V4_DIR = 'v4';
const V3_CONTENT_HASH_VERSION = 2;
export const CONTENT_HASH_VERSION = 3;
const heldLocks = new Map();

function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name, full)) out.push(full);
  }
  return out;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeToken(value, prefix) {
  const raw = String(value || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return raw;
  return `${prefix}-${sha256(raw || prefix).slice(0, 32)}`;
}

function canonicalClient(tool) {
  return tool === 'claude-desktop' ? 'claude-cli' : tool;
}

export function logicalIdForNative(tool, nativeSessionId) {
  return `session-${sha256(`${canonicalClient(tool)}\u0000${nativeSessionId}`).slice(0, 32)}`;
}

export function legacyLogicalId(digest, base = '') {
  if (digest?.logical_id) return safeToken(digest.logical_id, 'session');
  return `legacy-${sha256(sessionSourceKey(digest, base)).slice(0, 32)}`;
}

export function legacyRevisionId(digest, base = '') {
  const sourceKey = sessionSourceKey(digest, base);
  return digest?.revision_id || `legacy-${sha256(`${sourceKey}\u0000${digest?.ended_at || ''}`).slice(0, 32)}`;
}

export function normalizeSessionMarker(marker) {
  if (!marker) return null;
  if (marker.logical_id) return { ...marker, logical_id: safeToken(marker.logical_id, 'session') };
  if (marker.source_key) {
    return {
      ...marker,
      logical_id: `legacy-${sha256(marker.source_key).slice(0, 32)}`,
      revision_id: marker.revision_id || null,
    };
  }
  return { ...marker };
}

export function resolveSessionIdentity({ env = process.env, cwd } = {}) {
  const explicitAuthor = String(env.SESSION_MEMORY_AUTHOR ?? '').trim();
  const explicitActor = String(env.SESSION_MEMORY_ACTOR_ID ?? '').trim();
  const explicitDevice = String(env.SESSION_MEMORY_DEVICE_ID ?? '').trim();
  const explicitRole = String(env.SESSION_MEMORY_ROLE ?? '').trim();
  const author = resolveAuthor({ env, cwd });
  const actor = normalizeHandle(explicitActor);
  const device = normalizeHandle(explicitDevice);
  const role = normalizeHandle(explicitRole);
  if (explicitAuthor && !normalizeHandle(explicitAuthor)) throw new Error('SESSION_MEMORY_AUTHOR must contain a Unicode letter or number.');
  if (explicitActor && !actor) throw new Error('SESSION_MEMORY_ACTOR_ID must contain a Unicode letter or number.');
  if (explicitDevice && !device) throw new Error('SESSION_MEMORY_DEVICE_ID must contain a Unicode letter or number.');
  if (explicitRole && !role) throw new Error('SESSION_MEMORY_ROLE must contain a Unicode letter or number.');
  return {
    author,
    actor_id: actor || `actor-${sha256(author).slice(0, 16)}`,
    device_id: device || `device-${sha256(os.hostname()).slice(0, 16)}`,
    role,
  };
}

export function sessionMarker(lines, tool) {
  for (const line of lines || []) {
    let row;
    try {
      row = typeof line === 'string' ? JSON.parse(line) : line;
    } catch {
      continue;
    }
    if (tool === 'codex' && row?.type === 'session_meta') {
      return {
        marker: row.payload?.session_memory || null,
        native_session_id: row.payload?.id || row.payload?.session_id || null,
        originator: row.payload?.originator || null,
      };
    }
    if (tool !== 'codex' && row?.sessionMemory) {
      return { marker: row.sessionMemory, native_session_id: row.sessionId || null, originator: 'session-memory' };
    }
  }
  return { marker: null, native_session_id: null, originator: null };
}

function claudeRawUserText(row) {
  if (row?.type !== 'user' || row?.message?.role !== 'user' || row.isMeta || row.sourceToolUseID) return null;
  const content = row.message.content;
  if (Array.isArray(content) && content.some((item) => item?.type === 'tool_result')) return null;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n')
      : '';
}

function codexRawUserText(row) {
  if (row?.type === 'event_msg' && row.payload?.type === 'user_message') return row.payload.message;
  if (row?.type === 'response_item' && row.payload?.type === 'message' && row.payload?.role === 'user') {
    return (row.payload.content || [])
      .filter((item) => item?.type === 'input_text')
      .map((item) => item.text || '')
      .join('\n');
  }
  return null;
}

function textContent(items, accepted) {
  return (items || [])
    .filter((item) => accepted.has(item?.type) && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function canonicalToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (value === null || value === undefined) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Preserve non-JSON historical input in the object shape Claude requires.
  }
  return { historical_input: typeof value === 'string' ? value : stableJson(value) };
}

function canonicalToolResult(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return stableJson(value);
}

export function canonicalEvents(lines, tool, { legacyToolValues = false, allowMalformedRows = false } = {}) {
  const input = (lines || []).filter((line) => (
    typeof line !== 'string' || line.trim()
  ));
  const rows = [];
  for (let index = 0; index < input.length; index += 1) {
    const line = input[index];
    try {
      rows.push(typeof line === 'string' ? JSON.parse(line) : line);
    } catch (error) {
      if (allowMalformedRows) continue;
      if (index === input.length - 1) continue; // A live native session may end in one partial row.
      throw new Error(`Invalid native transcript row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const events = [];
  let skipControlTurn = false;
  if (tool === 'codex') {
    const hasResponseUser = rows.some((row) => (
      row?.type === 'response_item'
      && row.payload?.type === 'message'
      && row.payload?.role === 'user'
      && cleanRealUserText(textContent(row.payload.content, new Set(['input_text'])))
    ));
    const hasResponseAssistant = rows.some((row) => (
      row?.type === 'response_item'
      && row.payload?.type === 'message'
      && row.payload?.role === 'assistant'
      && textContent(row.payload.content, new Set(['output_text', 'text']))
    ));
    for (const row of rows) {
      const payload = row?.payload || {};
      if (row?.type === 'response_item' && payload.type === 'message') {
        if (payload.role === 'user') {
          const raw = textContent(payload.content, new Set(['input_text']));
          if (isSessionMemoryControlText(raw)) {
            skipControlTurn = true;
            continue;
          }
          const content = cleanRealUserText(raw);
          if (content) {
            skipControlTurn = false;
            events.push({ kind: 'user_message', content });
          }
        } else if (payload.role === 'assistant' && !skipControlTurn) {
          const content = textContent(payload.content, new Set(['output_text', 'text']));
          if (content) events.push({ kind: 'assistant_message', content });
        }
      } else if (row?.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
        if (!skipControlTurn) {
          const value = payload.arguments ?? payload.input ?? null;
          events.push({ kind: 'tool_call', name: payload.name || null, arguments: legacyToolValues ? value : canonicalToolArguments(value) });
        }
      } else if (row?.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
        if (!skipControlTurn) {
          const value = payload.output ?? null;
          events.push({ kind: 'tool_result', output: legacyToolValues ? value : canonicalToolResult(value) });
        }
      } else if (!hasResponseUser && row?.type === 'event_msg' && payload.type === 'user_message') {
        if (isSessionMemoryControlText(payload.message)) {
          skipControlTurn = true;
          continue;
        }
        const content = cleanRealUserText(payload.message);
        if (content) {
          skipControlTurn = false;
          events.push({ kind: 'user_message', content });
        }
      } else if (!hasResponseAssistant && row?.type === 'event_msg' && payload.type === 'agent_message' && payload.message && !skipControlTurn) {
        events.push({ kind: 'assistant_message', content: String(payload.message) });
      }
    }
    return events;
  }

  for (const row of rows) {
    if (row?.type === 'user' && row.message?.role === 'user') {
      const raw = claudeRawUserText(row);
      if (isSessionMemoryControlText(raw)) {
        skipControlTurn = true;
        continue;
      }
      if (Array.isArray(row.message.content) && !skipControlTurn) {
        for (const item of row.message.content) {
          if (item?.type === 'tool_result') {
            const value = item.content ?? null;
            events.push({ kind: 'tool_result', output: legacyToolValues ? value : canonicalToolResult(value) });
          }
        }
      }
      const content = cleanRealUserText(raw);
      if (content) {
        skipControlTurn = false;
        events.push({ kind: 'user_message', content });
      }
    } else if (row?.type === 'assistant' && row.message?.role === 'assistant' && !skipControlTurn) {
      for (const item of row.message.content || []) {
        if (item?.type === 'text' && item.text) events.push({ kind: 'assistant_message', content: item.text });
        if (item?.type === 'tool_use') {
          const value = item.input ?? null;
          events.push({ kind: 'tool_call', name: item.name || null, arguments: legacyToolValues ? value : canonicalToolArguments(value) });
        }
      }
    }
  }
  return events;
}

export function contentHashForEvents(events) {
  return sha256(stableJson(events || []));
}

export function canonicalContentHash(lines, tool) {
  return contentHashForEvents(canonicalEvents(lines, tool));
}

export function eventsStartWith(events, prefix) {
  if (!Array.isArray(prefix) || prefix.length > events.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (stableJson(events[index]) !== stableJson(prefix[index])) return false;
  }
  return true;
}

// Compatibility only: schema-1/2 imports used a recorded native line boundary.
// New schema-4 imports use semantic hashes and do not need this state.
export function legacyImportHasContinuation(lines, tool, marker) {
  const boundary = Number(marker?.imported_line_count);
  if (!Number.isInteger(boundary) || boundary < 0) return true;
  const nonBlank = (lines || []).filter((line) => String(line || '').trim());
  for (let index = boundary; index < nonBlank.length; index += 1) {
    let row;
    try {
      row = typeof nonBlank[index] === 'string' ? JSON.parse(nonBlank[index]) : nonBlank[index];
    } catch {
      continue;
    }
    const raw = tool === 'codex' ? codexRawUserText(row) : claudeRawUserText(row);
    if (cleanRealUserText(raw)) return true;
  }
  return false;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertSessionHistoryContained(projectRoot) {
  const root = path.resolve(projectRoot);
  const history = path.join(root, 'session-history');
  if (!existsSync(history)) return;
  if (lstatSync(history).isSymbolicLink()) throw new Error(`Refusing linked session-history path: ${history}`);
  if (!isContained(realpathSync(root), realpathSync(history))) throw new Error(`Refusing session-history outside project: ${history}`);
}

function assertSafeWrite(projectRoot, target) {
  const root = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(target);
  if (!isContained(root, resolvedTarget)) throw new Error(`Refusing session-history write outside project: ${resolvedTarget}`);
  const realRoot = realpathSync(root);
  let cursor = root;
  for (const part of path.relative(root, resolvedTarget).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing session-history write through link: ${cursor}`);
    if (!isContained(realRoot, realpathSync(cursor))) throw new Error(`Refusing session-history write outside project: ${cursor}`);
  }
}

function atomicWrite(projectRoot, file, content) {
  assertSafeWrite(projectRoot, file);
  mkdirSync(path.dirname(file), { recursive: true });
  assertSafeWrite(projectRoot, file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function readJson(file, label = 'session-memory JSON') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeHistoryFile(projectRoot, ref, pattern) {
  if (!ref || path.isAbsolute(ref)) return null;
  const root = path.resolve(projectRoot);
  const history = path.join(root, 'session-history');
  const file = path.resolve(root, ref);
  if (!isContained(history, file) || !pattern.test(path.relative(history, file).replace(/\\/g, '/'))) return null;
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return null;
  if (!isContained(realpathSync(history), realpathSync(file))) return null;
  return file;
}

function acquireLock(projectRoot) {
  const key = realpathSync(path.resolve(projectRoot));
  const held = heldLocks.get(key);
  if (held) {
    held.depth += 1;
    let released = false;
    return () => {
      if (!released) held.depth -= 1;
      released = true;
    };
  }
  const dir = path.join(os.tmpdir(), 'session-memory-ledger-locks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha256(key)}.lock`);
  const token = randomUUID();
  try {
    writeFileSync(file, `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Another session-memory write is in progress (${file}). Verify no writer is running before removing a stale lock.`);
    throw error;
  }
  heldLocks.set(key, { depth: 1, file, token });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = heldLocks.get(key);
    current.depth -= 1;
    if (current.depth > 0) return;
    heldLocks.delete(key);
    const lock = readJson(file, 'write lock');
    if (lock.token !== token) throw new Error(`Refusing to remove a changed session-memory lock: ${file}`);
    unlinkSync(file);
  };
}

export function acquireSessionLedgerWriteLock(projectRoot) {
  return acquireLock(projectRoot);
}

function parseEventFile(file) {
  const events = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!['user_message', 'assistant_message', 'tool_call', 'tool_result'].includes(event?.kind)) throw new Error('unsupported event kind');
      events.push(event);
    } catch (error) {
      throw new Error(`Invalid canonical event file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

function validateGroup(logicalId, revisions) {
  const ids = new Set(revisions.map((revision) => revision.revision_id));
  if (ids.size !== revisions.length) throw new Error(`Logical session ${logicalId} contains duplicate revision IDs.`);
  const owner = revisions[0]?.owner ?? null;
  const ownerActorId = revisions[0]?.owner_actor_id ?? null;
  for (const revision of revisions) {
    if (revision.logical_id !== logicalId) throw new Error(`Revision ${revision.revision_id} is stored under the wrong logical session.`);
    if ((revision.owner ?? null) !== owner || (revision.owner_actor_id ?? null) !== ownerActorId) {
      throw new Error(`Logical session ${logicalId} changes immutable ownership.`);
    }
    if (!Array.isArray(revision.parents) || new Set(revision.parents).size !== revision.parents.length) {
      throw new Error(`Revision ${revision.revision_id} has invalid parents.`);
    }
    for (const parent of revision.parents) {
      if (parent === revision.revision_id || !ids.has(parent)) throw new Error(`Revision ${revision.revision_id} has a missing or self parent ${parent}.`);
    }
  }
  const byId = new Map(revisions.map((revision) => [revision.revision_id, revision]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Logical session ${logicalId} contains a revision cycle.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id).parents) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return { owner, ownerActorId };
}

function newest(revisions) {
  return [...revisions].sort((a, b) => String(b.saved_at || b.ended_at || '').localeCompare(String(a.saved_at || a.ended_at || '')))[0] || null;
}

export function revisionHeads(revisions) {
  const parents = new Set(revisions.flatMap((revision) => revision.parents || []));
  return revisions.filter((revision) => !parents.has(revision.revision_id));
}

function groupRevisions(revisions, sourceSchema) {
  const groups = new Map();
  for (const revision of revisions) {
    if (!groups.has(revision.logical_id)) groups.set(revision.logical_id, []);
    groups.get(revision.logical_id).push({ ...revision, source_schema: sourceSchema });
  }
  return groups;
}

function loadV4Groups(projectRoot) {
  const root = path.join(projectRoot, 'session-history', V4_DIR, 'sessions');
  const revisions = walk(root, (name, full) => name.endsWith('.json') && full.includes(`${path.sep}revisions${path.sep}`)).map((file) => {
    const revision = readJson(file, 'schema-4 revision');
    const pathRevision = path.basename(file, '.json');
    const pathLogical = path.basename(path.dirname(path.dirname(file)));
    if (revision.schema !== 4 || revision.revision_id !== pathRevision || revision.logical_id !== pathLogical) {
      throw new Error(`Invalid schema-4 revision path or identity: ${file}`);
    }
    const eventFile = safeHistoryFile(
      projectRoot,
      revision.events_ref,
      new RegExp(`^v4/sessions/${pathLogical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/events/${pathRevision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.jsonl$`, 'i')
    );
    if (!eventFile) throw new Error(`Revision ${revision.revision_id} has a missing or unsafe events_ref.`);
    const events = parseEventFile(eventFile);
    if (revision.content_hash_version !== CONTENT_HASH_VERSION
      || revision.event_count !== events.length
      || revision.content_hash !== contentHashForEvents(events)) {
      throw new Error(`Schema-4 integrity check failed for revision ${revision.revision_id}.`);
    }
    return { ...revision, events };
  });
  return groupRevisions(revisions, 4);
}

function loadV3Groups(projectRoot) {
  const root = path.join(projectRoot, 'session-history', 'v3');
  const files = walk(path.join(root, 'sessions'), (name, full) => name.endsWith('.json') && full.includes(`${path.sep}revisions${path.sep}`));
  if (files.length === 0) return new Map();
  const project = readJson(path.join(root, 'project.json'), 'schema-3 project');
  if (project.schema !== 3 || !project.project_id) throw new Error(`Invalid schema-3 project record in ${root}.`);
  const revisions = files.map((file) => {
    const revision = readJson(file, 'schema-3 revision');
    const pathRevision = path.basename(file, '.json');
    const pathLogical = path.basename(path.dirname(path.dirname(file)));
    if (revision.schema !== 3
      || revision.project_id !== project.project_id
      || revision.revision_id !== pathRevision
      || revision.logical_id !== pathLogical) {
      throw new Error(`Invalid schema-3 revision path, identity, or project: ${file}`);
    }
    const transcript = safeHistoryFile(
      projectRoot,
      revision.transcript_ref,
      /^v3\/sessions\/[^/]+\/transcripts\/[^/]+\.jsonl$/i
    );
    if (!transcript) throw new Error(`Schema-3 revision ${revision.revision_id} has a missing or unsafe transcript_ref.`);
    const lines = readFileSync(transcript, 'utf8').split(/\r?\n/);
    const legacyEvents = canonicalEvents(lines, revision.tool, { legacyToolValues: true, allowMalformedRows: true });
    if (revision.content_hash_version !== V3_CONTENT_HASH_VERSION
      || revision.event_count !== legacyEvents.length
      || revision.content_hash !== contentHashForEvents(legacyEvents)) {
      throw new Error(`Schema-3 transcript integrity check failed for revision ${revision.revision_id}.`);
    }
    const events = canonicalEvents(lines, revision.tool, { allowMalformedRows: true });
    return {
      ...revision,
      legacy_content_hash: revision.content_hash,
      content_hash: contentHashForEvents(events),
      content_hash_version: CONTENT_HASH_VERSION,
      event_count: events.length,
      events,
    };
  });
  return groupRevisions(revisions, 3);
}

function storedSessions(projectRoot, includeV3 = true) {
  assertSessionHistoryContained(projectRoot);
  const v4 = loadV4Groups(projectRoot);
  const v3 = includeV3 ? loadV3Groups(projectRoot) : new Map();
  const groups = new Map(v3);
  for (const [logicalId, revisions] of v4) {
    groups.set(logicalId, [...(groups.get(logicalId) || []), ...revisions]);
  }
  const sessions = [];
  for (const [logicalId, revisions] of groups) {
    const ownership = validateGroup(logicalId, revisions);
    const heads = revisionHeads(revisions);
    const latest = newest(heads.length ? heads : revisions);
    sessions.push({
      logical_id: logicalId,
      latest_revision_id: latest?.revision_id || null,
      latest,
      heads,
      conflicted: heads.length > 1,
      revision_count: revisions.length,
      owner: ownership.owner,
      owner_actor_id: ownership.ownerActorId,
      contributors: [...new Set(revisions.map((revision) => revision.author).filter(Boolean))],
      revisions,
    });
  }
  return sessions;
}

export function loadLogicalSessions(projectRoot) {
  return storedSessions(projectRoot, true);
}

function legacyImportLabel(digest) {
  const tool = digest.tool === 'claude-cli'
    ? 'cli'
    : digest.tool === 'claude-desktop'
      ? 'desktop'
      : digest.tool;
  return `${tool || 'unknown'}${digest.author ? `@${digest.author}` : ''}${digest.role ? `:${digest.role}` : ''}`;
}

// One-time compatibility for native replicas created before markers were embedded.
// They are identified only when the native metadata says session-memory created them
// and their first visible prompt exactly matches one legacy source prompt.
export function legacyImportMarkerCandidates(projectRoot, events) {
  const currentUsers = (events || []).filter((event) => event.kind === 'user_message').map((event) => String(event.content));
  const currentAssistants = (events || []).filter((event) => event.kind === 'assistant_message').map((event) => String(event.content));
  if (currentUsers.length === 0) return [];
  const matches = [];
  const digestRoot = path.join(projectRoot, 'session-history', 'digests');
  for (const file of walk(digestRoot, (name) => name.endsWith('.json'))) {
    const digest = readJson(file, 'legacy session digest');
    const base = path.basename(file, '.json');
    let sourceEvents = [];
    let prompt = digest.first_prompt || digest.title || null;
    const transcript = safeHistoryFile(projectRoot, digest.transcript_ref, /^transcripts\/.*\.jsonl$/i);
    if (transcript) {
      sourceEvents = canonicalEvents(readFileSync(transcript, 'utf8').split(/\r?\n/), digest.tool, { allowMalformedRows: true });
      prompt = sourceEvents.find((event) => event.kind === 'user_message')?.content || prompt;
    }
    if (!prompt) continue;
    let sourceUsers = sourceEvents.filter((event) => event.kind === 'user_message').map((event) => String(event.content));
    if (sourceUsers.length === 0) sourceUsers = [String(prompt)];
    const sourceAssistants = sourceEvents.filter((event) => event.kind === 'assistant_message').map((event) => String(event.content));
    const fingerprint = `(${legacyImportLabel(digest)}) ${prompt}`;
    const firstCurrent = currentUsers[0].trimEnd();
    if (firstCurrent !== String(fingerprint).trimEnd() && firstCurrent !== sourceUsers[0].trimEnd()) continue;
    if (sourceUsers.length > currentUsers.length) continue;
    if (sourceUsers.some((text, index) => index > 0 && text.trimEnd() !== currentUsers[index]?.trimEnd())) continue;
    let assistantCursor = 0;
    const assistantsMatch = sourceAssistants.every((text) => {
      while (assistantCursor < currentAssistants.length && currentAssistants[assistantCursor] !== text) assistantCursor += 1;
      if (assistantCursor >= currentAssistants.length) return false;
      assistantCursor += 1;
      return true;
    });
    if (!assistantsMatch) continue;
    const owner = digest.owner || digest.author || null;
    matches.push({
      schema: 1,
      logical_id: legacyLogicalId(digest, base),
      revision_id: legacyRevisionId(digest, base),
      owner,
      owner_actor_id: digest.owner_actor_id || null,
      source_tool: digest.tool || null,
      source_id: digest.id || null,
      inferred_legacy: true,
      imported_turns: sourceUsers.length || (Number.isInteger(digest.turns) ? digest.turns : null),
    });
  }
  return [...new Map(matches.map((marker) => [marker.logical_id, marker])).values()];
}

export function inferLegacyImportMarker(projectRoot, events) {
  const matches = legacyImportMarkerCandidates(projectRoot, events);
  if (matches.length > 1) throw new Error(`Markerless session-memory import matches multiple legacy sessions: ${matches.map((marker) => marker.logical_id).join(', ')}.`);
  return matches[0] || null;
}

function legacyRevisionMatches(projectRoot, logicalId, revisionId = null, contentHash = null) {
  const digestRoot = path.join(projectRoot, 'session-history', 'digests');
  for (const file of walk(digestRoot, (name) => name.endsWith('.json'))) {
    const digest = readJson(file, 'legacy session digest');
    const base = path.basename(file, '.json');
    if (legacyLogicalId(digest, base) !== logicalId) continue;
    if (revisionId && legacyRevisionId(digest, base) !== revisionId) continue;
    if (contentHash) {
      const transcript = safeHistoryFile(projectRoot, digest.transcript_ref, /^transcripts\/.*\.jsonl$/i);
      let events = transcript
        ? canonicalEvents(readFileSync(transcript, 'utf8').split(/\r?\n/).map(redactJsonLine), digest.tool, { allowMalformedRows: true })
        : [];
      if (events.length === 0 && digest.first_prompt) events = [{ kind: 'user_message', content: digest.first_prompt }];
      if (contentHashForEvents(events) !== contentHash) continue;
    }
    return true;
  }
  return false;
}

function legacySourceMatch(projectRoot, tool, nativeSessionId) {
  const digestRoot = path.join(projectRoot, 'session-history', 'digests');
  const matches = new Map();
  for (const file of walk(digestRoot, (name) => name.endsWith('.json'))) {
    const digest = readJson(file, 'legacy session digest');
    if (String(digest.id || '') !== String(nativeSessionId || '')) continue;
    if (canonicalClient(digest.tool) !== canonicalClient(tool)) continue;
    const logicalId = legacyLogicalId(digest, path.basename(file, '.json'));
    const transcript = safeHistoryFile(projectRoot, digest.transcript_ref, /^transcripts\/.*\.jsonl$/i);
    const events = transcript
      ? canonicalEvents(readFileSync(transcript, 'utf8').split(/\r?\n/), digest.tool, { allowMalformedRows: true })
      : [];
    const match = {
      logicalId,
      owner: digest.owner || digest.author || null,
      ownerActorId: digest.owner_actor_id || null,
      contentHash: events.length ? contentHashForEvents(events) : null,
      revisionId: legacyRevisionId(digest, path.basename(file, '.json')),
      endedAt: digest.ended_at || '',
    };
    const previous = matches.get(logicalId);
    if (!previous || match.endedAt.localeCompare(previous.endedAt) > 0) matches.set(logicalId, match);
  }
  if (matches.size > 1) throw new Error(`Native session ${nativeSessionId} maps to multiple legacy logical sessions.`);
  return [...matches.values()][0] || null;
}

function existingSourceMatch(projectRoot, tool, nativeSessionId) {
  const matches = new Map();
  for (const session of storedSessions(projectRoot, true)) {
    if (session.revisions.some((revision) => (
      String(revision.native_session_id || '') === String(nativeSessionId || '')
      && canonicalClient(revision.tool) === canonicalClient(tool)
    ))) {
      matches.set(session.logical_id, {
        logicalId: session.logical_id,
        owner: session.owner,
        ownerActorId: session.owner_actor_id,
      });
    }
  }
  if (matches.size > 1) throw new Error(`Native session ${nativeSessionId} maps to multiple logical sessions.`);
  return [...matches.values()][0] || legacySourceMatch(projectRoot, tool, nativeSessionId);
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now ?? Date.now();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('The session-memory clock returned an invalid date.');
  return date.toISOString();
}

export function saveSessionRevision({
  digest,
  transcriptLines,
  projectRoot,
  marker = null,
  env = process.env,
  now,
} = {}) {
  const release = acquireLock(projectRoot);
  try {
    assertSessionHistoryContained(projectRoot);
    const tool = digest.tool;
    const nativeSessionId = digest.native_session_id || digest.id;
    if (!nativeSessionId) throw new Error('A native session ID is required.');

    const events = canonicalEvents(transcriptLines, tool);
    let normalizedMarker = normalizeSessionMarker(marker);
    if (!normalizedMarker && digest.origin === 'session-memory') {
      normalizedMarker = inferLegacyImportMarker(projectRoot, events);
      if (!normalizedMarker) {
        throw new Error('This markerless legacy import cannot be identified safely; read the project session again before saving it.');
      }
    }

    if (events.length === 0) return { status: 'empty', logical_id: normalizedMarker?.logical_id || null, revision_id: null };
    const contentHash = contentHashForEvents(events);
    const sourceMatch = normalizedMarker?.logical_id ? null : existingSourceMatch(projectRoot, tool, nativeSessionId);
    const logicalId = safeToken(
      normalizedMarker?.logical_id || sourceMatch?.logicalId || logicalIdForNative(tool, nativeSessionId),
      'session'
    );
    const allSessions = storedSessions(projectRoot, true);
    const existingSession = allSessions.find((session) => session.logical_id === logicalId) || null;
    const markedRevision = existingSession?.revisions.find((revision) => (
      revision.revision_id === normalizedMarker?.revision_id
      && revision.content_hash === normalizedMarker?.content_hash
    ));
    const markedLegacyRevision = normalizedMarker?.logical_id
      && legacyRevisionMatches(
        projectRoot,
        logicalId,
        normalizedMarker.revision_id || null,
        normalizedMarker.schema === 4 ? normalizedMarker.content_hash || null : null
      );
    if (normalizedMarker?.schema === 4
      && normalizedMarker.content_hash === contentHash
      && normalizedMarker.revision_id
      && (markedRevision || markedLegacyRevision)) {
      return { status: 'unchanged-import', logical_id: logicalId, revision_id: normalizedMarker.revision_id };
    }
    if (normalizedMarker?.inferred_legacy
      && Number.isInteger(normalizedMarker.imported_turns)
      && events.filter((event) => event.kind === 'user_message').length <= normalizedMarker.imported_turns) {
      return { status: 'unchanged-import', logical_id: logicalId, revision_id: normalizedMarker.revision_id || null };
    }
    if (normalizedMarker?.schema !== 4
      && normalizedMarker?.logical_id
      && (normalizedMarker.inferred_legacy || existingSession || markedLegacyRevision)
      && !legacyImportHasContinuation(transcriptLines, tool, normalizedMarker)) {
      return { status: 'unchanged-import', logical_id: logicalId, revision_id: normalizedMarker.revision_id || null };
    }
    if (sourceMatch?.contentHash === contentHash) {
      return { status: 'unchanged', logical_id: logicalId, revision_id: sourceMatch.revisionId || null };
    }
    const identical = existingSession?.revisions.find((revision) => revision.content_hash === contentHash);
    if (identical) return { status: 'unchanged', logical_id: logicalId, revision_id: identical.revision_id };

    const identity = resolveSessionIdentity({ env, cwd: projectRoot });
    const owner = existingSession?.owner || normalizedMarker?.owner || sourceMatch?.owner || identity.author;
    const ownerActorId = existingSession
      ? existingSession.owner_actor_id
      : normalizedMarker && Object.hasOwn(normalizedMarker, 'owner_actor_id')
        ? normalizedMarker.owner_actor_id
        : sourceMatch && Object.hasOwn(sourceMatch, 'ownerActorId')
          ? sourceMatch.ownerActorId
          : owner === identity.author
            ? identity.actor_id
            : null;
    if (existingSession && normalizedMarker?.owner && normalizedMarker.owner !== owner) {
      throw new Error(`Marker ownership conflicts with logical session ${logicalId}.`);
    }
    if (existingSession && normalizedMarker?.owner_actor_id && normalizedMarker.owner_actor_id !== ownerActorId) {
      throw new Error(`Marker actor ownership conflicts with logical session ${logicalId}.`);
    }

    const storedRevisions = existingSession?.revisions || [];
    const prefix = storedRevisions
      .filter((revision) => eventsStartWith(events, revision.events))
      .sort((a, b) => b.events.length - a.events.length)[0] || null;
    if (storedRevisions.length > 0 && !prefix) {
      throw new Error(`Session ${logicalId} does not extend any saved revision; read the intended revision before saving.`);
    }

    const revisionId = `rev-${sha256(`${logicalId}\u0000${contentHash}`).slice(0, 32)}`;
    const savedAt = nowIso(now);
    const sessionDir = path.join(projectRoot, 'session-history', V4_DIR, 'sessions', logicalId);
    const eventsPath = path.join(sessionDir, 'events', `${revisionId}.jsonl`);
    const revisionPath = path.join(sessionDir, 'revisions', `${revisionId}.json`);
    const eventsRef = path.relative(projectRoot, eventsPath).replace(/\\/g, '/');
    const revision = {
      schema: 4,
      logical_id: logicalId,
      revision_id: revisionId,
      parents: prefix ? [prefix.revision_id] : [],
      owner,
      owner_actor_id: ownerActorId,
      author: identity.author,
      actor_id: identity.actor_id,
      role: identity.role,
      device_id: identity.device_id,
      tool,
      native_session_id: nativeSessionId,
      content_hash: contentHash,
      content_hash_version: CONTENT_HASH_VERSION,
      event_count: events.length,
      saved_at: savedAt,
      started_at: digest.started_at || null,
      ended_at: digest.ended_at || savedAt,
      first_prompt: digest.first_prompt || null,
      title: digest.title || null,
      machine: digest.machine || null,
      cwd: digest.cwd || null,
      git: digest.git || null,
      turns: digest.turns ?? null,
      summary: digest.summary || '',
      files_touched: digest.files_touched || [],
      tools_used: digest.tools_used || {},
      next_steps: digest.next_steps || [],
      events_ref: eventsRef,
    };
    atomicWrite(projectRoot, eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    atomicWrite(projectRoot, revisionPath, `${JSON.stringify(revision, null, 2)}\n`);
    return {
      status: 'saved',
      logical_id: logicalId,
      revision_id: revisionId,
      revision_path: revisionPath,
      events_path: eventsPath,
      revision,
    };
  } finally {
    release();
  }
}
