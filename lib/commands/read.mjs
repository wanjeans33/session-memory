import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { gitInfo } from '../util/git.mjs';
import { encodeProject, splitLines } from '../util/transcript.mjs';
import { buildClaudeSession, buildCodexSession } from '../util/native-import.mjs';
import { sessionSourceKey } from '../util/session-source.mjs';
import { normalizeHandle } from '../util/author.mjs';
import { redactJsonLine } from '../util/redact.mjs';
import {
  acquireSessionLedgerWriteLock,
  canonicalContentHash,
  canonicalEvents,
  contentHashForEvents,
  legacyImportMarkerCandidates,
  legacyImportHasContinuation,
  legacyLogicalId,
  legacyRevisionId,
  loadLogicalSessionsDetailed,
  logicalIdForNative,
  normalizeSessionMarker,
  resolveSessionIdentity,
  sessionMarker,
} from '../util/session-ledger.mjs';

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

function canonicalClient(tool) {
  return tool === 'claude-desktop' ? 'claude-cli' : tool;
}

function label(tool) {
  if (tool === 'claude-cli') return 'cli';
  if (tool === 'claude-desktop') return 'desktop';
  return tool || 'unknown';
}

function sourceLabel(digest) {
  const who = digest.author ? `@${digest.author}` : '';
  const role = digest.role ? `:${digest.role}` : '';
  return `${label(digest.tool)}${who}${role}`;
}

function pathKey(value) {
  if (!value) return null;
  let resolved = path.resolve(value);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A recorded checkout can have moved; use its lexical key.
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function prepareNativeDirectory(root, dir) {
  const lexicalRoot = path.resolve(root);
  const lexicalDir = path.resolve(dir);
  if (!isContained(lexicalRoot, lexicalDir)) throw new Error(`Refusing native session path outside configured store: ${lexicalDir}`);
  mkdirSync(lexicalRoot, { recursive: true });
  const realRoot = realpathSync(lexicalRoot);
  let cursor = lexicalRoot;
  for (const part of path.relative(lexicalRoot, lexicalDir).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing native session path through a link: ${cursor}`);
    if (!isContained(realRoot, realpathSync(cursor))) throw new Error(`Refusing native session path outside configured store: ${cursor}`);
  }
  return { lexicalRoot, realRoot };
}

function atomicNativeWrite(root, file, content, expectedContent) {
  const target = path.resolve(file);
  const { lexicalRoot, realRoot } = prepareNativeDirectory(root, path.dirname(target));
  if (!isContained(lexicalRoot, target)) throw new Error(`Refusing native session write outside configured store: ${target}`);
  if (existsSync(target)) {
    if (expectedContent === undefined) throw new Error(`Refusing to overwrite an unexpected native session: ${target}`);
    if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to replace a native session link: ${target}`);
    if (!isContained(realRoot, realpathSync(target))) throw new Error(`Refusing native session file outside configured store: ${target}`);
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    if (expectedContent === undefined) {
      if (existsSync(target)) throw new Error(`Native session appeared while importing: ${target}`);
    } else if (!existsSync(target) || readFileSync(target, 'utf8') !== expectedContent) {
      throw new Error(`Native session changed while importing; refusing to overwrite it: ${target}`);
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function safeLegacyTranscript(root, transcriptRef) {
  if (!transcriptRef || path.isAbsolute(transcriptRef) || !String(transcriptRef).toLowerCase().endsWith('.jsonl')) return null;
  const history = path.resolve(root, 'session-history');
  const file = path.resolve(root, transcriptRef);
  const relative = path.relative(history, file).replace(/\\/g, '/');
  if (!relative.startsWith('transcripts/') || !isContained(history, file) || !existsSync(file)) return null;
  if (lstatSync(file).isSymbolicLink()) return null;
  if (!isContained(realpathSync(history), realpathSync(file))) return null;
  return file;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function firstPrompt(events, fallback = null) {
  return events.find((event) => event.kind === 'user_message')?.content || fallback;
}

function candidateFromSession(session) {
  const digest = session.latest;
  return {
    base: session.logical_id,
    logicalId: session.logical_id,
    revisionId: session.latest_revision_id,
    digest,
    owner: session.owner,
    ownerActorId: session.owner_actor_id,
    revisions: session.revisions,
    heads: session.heads.map((head) => head.revision_id),
    conflicted: session.conflicted,
    contentHash: digest.content_hash,
    events: digest.events,
    realPrompt: firstPrompt(digest.events, digest.first_prompt || digest.title),
    sourceKey: session.logical_id,
    unavailable: null,
  };
}

function selectRevision(candidate, revisionId) {
  const revision = candidate.revisions.find((item) => item.revision_id === revisionId);
  if (!revision) return null;
  return {
    ...candidate,
    revisionId: revision.revision_id,
    digest: revision,
    contentHash: revision.content_hash,
    events: revision.events,
    realPrompt: firstPrompt(revision.events, revision.first_prompt || revision.title),
    heads: [revision.revision_id],
    conflicted: false,
  };
}

function loadCandidates(root) {
  const byLogicalId = new Map();
  const stored = loadLogicalSessionsDetailed(root);
  const errors = stored.errors.map((entry) => `Unreadable session ${entry.logical_id}: ${entry.message}`);
  for (const session of stored.sessions) byLogicalId.set(session.logical_id, candidateFromSession(session));

  const digestRoot = path.join(root, 'session-history', 'digests');
  for (const file of walk(digestRoot, (name) => name.endsWith('.json'))) {
    let digest;
    try {
      digest = readJson(file, 'legacy session digest');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const base = path.basename(file, '.json');
    const logicalId = legacyLogicalId(digest, base);
    if (byLogicalId.get(logicalId)?.digest?.source_schema >= 3) continue;

    const transcript = safeLegacyTranscript(root, digest.transcript_ref);
    let events = [];
    let unavailable = null;
    if (transcript) {
      events = canonicalEvents(splitLines(readFileSync(transcript, 'utf8')).map(redactJsonLine), digest.tool, { allowMalformedRows: true });
    } else if (digest.transcript_ref) {
      unavailable = 'missing or unsafe transcript_ref';
    }
    if (events.length === 0 && digest.first_prompt) events = [{ kind: 'user_message', content: digest.first_prompt }];
    if (events.length === 0 && !unavailable) unavailable = 'no importable events';
    const sourceKey = sessionSourceKey(digest, base);
    const revisionId = legacyRevisionId(digest, base);
    const contentHash = contentHashForEvents(events);
    const owner = digest.owner || digest.author || null;
    const ownerActorId = digest.owner_actor_id || null;
    const revision = {
      ...digest,
      source_schema: digest.schema || 1,
      logical_id: logicalId,
      revision_id: revisionId,
      parents: [],
      owner,
      owner_actor_id: ownerActorId,
      content_hash: contentHash,
      event_count: events.length,
      events,
    };
    const candidate = {
      base,
      logicalId,
      revisionId,
      digest: revision,
      owner,
      ownerActorId,
      revisions: [revision],
      heads: [],
      conflicted: false,
      contentHash,
      events,
      realPrompt: firstPrompt(events, digest.first_prompt || digest.title),
      sourceKey,
      unavailable,
    };
    const previous = byLogicalId.get(logicalId);
    if (!previous || String(digest.ended_at || '').localeCompare(String(previous.digest.ended_at || '')) > 0) {
      byLogicalId.set(logicalId, candidate);
    }
  }
  const candidates = [...byLogicalId.values()].sort((a, b) => String(b.digest.ended_at || b.digest.saved_at || '').localeCompare(String(a.digest.ended_at || a.digest.saved_at || '')));
  return { candidates, errors };
}

function sourceMatches(candidate, tool, nativeId) {
  return candidate.revisions.some((revision) => (
    String(revision.native_session_id || revision.id || '') === String(nativeId || '')
    && canonicalClient(revision.tool) === canonicalClient(tool)
  ));
}

function identifyLogicalId(marker, tool, nativeId, candidates) {
  if (marker?.logical_id) return marker.logical_id;
  const sourceMatchesList = candidates.filter((candidate) => sourceMatches(candidate, tool, nativeId));
  if (sourceMatchesList.length > 1) throw new Error(`Native session ${nativeId} matches multiple logical sessions.`);
  return sourceMatchesList[0]?.logicalId || logicalIdForNative(tool, nativeId);
}

function addDetail(index, logicalId, detail) {
  if (!index.has(logicalId)) index.set(logicalId, []);
  index.get(logicalId).push(detail);
}

function scanClaude(projectDir, candidates) {
  const index = new Map();
  for (const file of walk(projectDir, (name) => name.endsWith('.jsonl'))) {
    const raw = readFileSync(file, 'utf8');
    const lines = splitLines(raw);
    const markerInfo = sessionMarker(lines, 'claude-cli');
    const marker = normalizeSessionMarker(markerInfo.marker);
    const id = markerInfo.native_session_id || path.basename(file, '.jsonl');
    const logicalId = identifyLogicalId(marker, 'claude-cli', id, candidates);
    if (!candidates.some((candidate) => candidate.logicalId === logicalId)) continue;
    addDetail(index, logicalId, {
      id,
      file,
      raw,
      lines,
      marker,
      tool: 'claude-cli',
      contentHash: canonicalContentHash(lines.map(redactJsonLine), 'claude-cli'),
    });
  }
  return index;
}

function codexMeta(lines) {
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'session_meta') return row.payload || {};
    } catch {
      continue;
    }
  }
  return {};
}

function scanCodex(codexDir, checkout, candidates, warnings = []) {
  const index = new Map();
  for (const file of walk(codexDir, (name) => /^rollout-.*\.jsonl$/.test(name))) {
    const raw = readFileSync(file, 'utf8');
    const lines = splitLines(raw);
    const meta = codexMeta(lines);
    let marker = normalizeSessionMarker(meta.session_memory);
    const id = meta.id || meta.session_id || path.basename(file, '.jsonl');
    if (meta.cwd) {
      const nativeRoot = gitInfo(meta.cwd).toplevel || meta.cwd;
      if (pathKey(nativeRoot) !== pathKey(checkout)) continue;
    }
    if (!marker && meta.originator === 'session-memory') {
      const matches = legacyImportMarkerCandidates(checkout, canonicalEvents(lines, 'codex'));
      if (matches.length !== 1) {
        warnings.push(`Ignored markerless session-memory replica ${id}: matched ${matches.length} legacy sessions; read will create a marked replica if needed.`);
        continue;
      }
      [marker] = matches;
    }
    const logicalId = identifyLogicalId(marker, 'codex', id, candidates);
    if (!candidates.some((candidate) => candidate.logicalId === logicalId)) continue;
    addDetail(index, logicalId, {
      id,
      file,
      raw,
      lines,
      marker,
      tool: 'codex',
      contentHash: canonicalContentHash(lines.map(redactJsonLine), 'codex'),
    });
  }
  return index;
}

function detailState(detail, candidate) {
  const exact = detail.contentHash === candidate.contentHash;
  const storedHashes = new Set(candidate.revisions.map((revision) => revision.content_hash));
  let clean = exact || storedHashes.has(detail.contentHash);
  if (!clean && detail.marker?.inferred_legacy && Number.isInteger(detail.marker.imported_turns)) {
    const userTurns = canonicalEvents(detail.lines, detail.tool).filter((event) => event.kind === 'user_message').length;
    clean = userTurns <= detail.marker.imported_turns;
  } else if (!clean && detail.marker?.logical_id && detail.marker.schema !== 4) {
    clean = !legacyImportHasContinuation(detail.lines, detail.tool, detail.marker);
  }
  return { exact, clean };
}

function chooseReplica(details, candidate) {
  for (const detail of details || []) if (detailState(detail, candidate).exact) return { detail, state: 'exact' };
  for (const detail of details || []) if (detailState(detail, candidate).clean) return { detail, state: 'clean' };
  return details?.[0] ? { detail: details[0], state: 'dirty' } : { detail: null, state: 'missing' };
}

function markerFor(candidate) {
  const d = candidate.digest;
  return {
    schema: 4,
    logical_id: candidate.logicalId,
    revision_id: candidate.revisionId,
    content_hash: candidate.contentHash,
    owner: candidate.owner || null,
    owner_actor_id: candidate.ownerActorId || null,
    source_tool: d.tool || null,
    source_id: d.native_session_id || d.id || null,
    source_author: d.author || null,
    source_role: d.role || null,
  };
}

function defaultCodexSessionsDir(env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function defaultDesktopSessionsDir(env, platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return path.join(os.homedir(), '.config', 'Claude', 'claude-code-sessions');
}

function codexRolloutPath(root, importedAt, id) {
  const year = String(importedAt.getUTCFullYear()).padStart(4, '0');
  const month = String(importedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(importedAt.getUTCDate()).padStart(2, '0');
  return path.join(root, year, month, day, `rollout-${importedAt.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
}

function descriptorScope(desktopRoot) {
  const files = walk(desktopRoot, (name) => /^local_.*\.json$/.test(name))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? path.dirname(files[0].file) : null;
}

function desktopDescriptors(scope) {
  const byCliId = new Map();
  if (!scope) return byCliId;
  for (const file of walk(scope, (name) => /^local_.*\.json$/.test(name))) {
    const descriptor = readJson(file, 'Desktop session descriptor');
    if (descriptor.cliSessionId) byCliId.set(descriptor.cliSessionId, { file, descriptor });
  }
  return byCliId;
}

function normalizeExplicitFilter(value, flag) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = normalizeHandle(value);
  if (!normalized) throw new Error(`${flag} must contain a Unicode letter or number.`);
  return normalized;
}

function parseTargets(targets) {
  const aliases = new Map([
    ['claude', 'cli'],
    ['claude-code', 'cli'],
    ['claude-desktop', 'desktop'],
  ]);
  const values = [...new Set(String(targets || 'cli').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => aliases.get(item) || item))];
  const unsupported = values.filter((item) => !['cli', 'desktop', 'codex'].includes(item));
  if (values.length === 0 || unsupported.length) throw new Error(`Unsupported --targets value: ${unsupported.join(', ') || '(empty)'}.`);
  return values;
}

export function read({
  import: doImport = false,
  ids,
  revision,
  all = false,
  pending = false,
  targets = 'cli',
  author,
  actor,
  scope = 'team',
  role,
  cwd,
  projectsDir,
  desktopSessionsDir,
  codexSessionsDir,
  env = process.env,
  platform = process.platform,
  uuidFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  const base = cwd || process.cwd();
  const git = gitInfo(base);
  const root = git.toplevel || base;
  const checkout = path.resolve(root);
  const history = path.join(root, 'session-history');
  if (!existsSync(history)) {
    console.log('This project has no session history (save elsewhere first, then update this checkout).');
    return;
  }
  if (!['mine', 'team'].includes(scope)) throw new Error('Unsupported --scope value. Use mine or team.');
  if (revision && (all || String(ids || '').split(',').map((item) => item.trim()).filter(Boolean).length !== 1)) {
    throw new Error('read --revision requires exactly one logical session in --ids and cannot use --all.');
  }

  const release = doImport ? acquireSessionLedgerWriteLock(root) : null;
  try {
  const identity = resolveSessionIdentity({ env, cwd: root });
  const sourceAuthor = normalizeExplicitFilter(author, '--source-author');
  const ownerActorId = normalizeExplicitFilter(actor, '--owner');
  const sourceRole = normalizeExplicitFilter(role, '--source-role');
  const loaded = loadCandidates(root);
  for (const message of loaded.errors) console.warn(`session-memory: ${message}`);
  let candidates = loaded.candidates;
  if (revision) candidates = candidates.map((candidate) => selectRevision(candidate, revision)).filter(Boolean);
  if (sourceAuthor) candidates = candidates.filter((candidate) => candidate.digest.author === sourceAuthor);
  if (ownerActorId) candidates = candidates.filter((candidate) => (
    candidate.ownerActorId ? candidate.ownerActorId === ownerActorId : candidate.owner === ownerActorId
  ));
  if (sourceRole) candidates = candidates.filter((candidate) => candidate.digest.role === sourceRole);
  if (scope === 'mine') {
    candidates = candidates.filter((candidate) => (
      candidate.ownerActorId ? candidate.ownerActorId === identity.actor_id : candidate.owner === identity.author
    ));
  }

  const claudeRoot = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const claudeProject = path.join(claudeRoot, encodeProject(checkout));
  const codexRoot = codexSessionsDir ? path.resolve(codexSessionsDir) : defaultCodexSessionsDir(env);
  const warnings = [];
  const claudeIndex = scanClaude(claudeProject, candidates);
  const codexIndex = scanCodex(codexRoot, checkout, candidates, warnings);
  for (const warning of warnings) console.warn(`session-memory: ${warning}`);

  if (!doImport) {
    let rows = candidates.map((candidate) => ({
      base: candidate.base,
      logical_id: candidate.logicalId,
      revision_id: candidate.revisionId,
      owner: candidate.owner,
      author: candidate.digest.author ?? null,
      role: candidate.digest.role ?? null,
      tool: candidate.digest.tool,
      machine: candidate.digest.machine ?? null,
      ended_at: candidate.digest.ended_at || candidate.digest.saved_at || null,
      title: candidate.realPrompt,
      codex_imports: (codexIndex.get(candidate.logicalId) || []).map((detail) => detail.id),
      claude_imports: (claudeIndex.get(candidate.logicalId) || []).map((detail) => detail.id),
      pending_codex: !codexIndex.has(candidate.logicalId),
      conflicted: candidate.conflicted,
      heads: candidate.heads,
      unavailable: candidate.unavailable,
    }));
    if (pending) rows = rows.filter((row) => row.pending_codex);
    console.log(JSON.stringify(rows, null, 2));
    return rows;
  }

  const wantedTargets = parseTargets(targets);
  if (all && ids) throw new Error('Use either --all or --ids for read --import, not both.');
  const requested = String(ids || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!all && requested.length === 0) {
    console.log('Pass --ids <logical-id,...> or --all to choose sessions (use --list first).');
    return;
  }

  let missing = 0;
  const selected = [];
  if (all) selected.push(...candidates);
  else {
    const seen = new Set();
    for (const id of requested) {
      const matches = candidates.filter((candidate) => candidate.logicalId === id || candidate.base === id);
      if (matches.length !== 1) {
        console.log(`Skipped (${matches.length ? 'ambiguous' : 'not found'}): ${id}`);
        missing += 1;
      } else if (!seen.has(matches[0].logicalId)) {
        selected.push(matches[0]);
        seen.add(matches[0].logicalId);
      }
    }
  }

  const counts = { created: 0, updated: 0, skipped: 0, blocked: 0, missing };
    const importedAt = new Date(typeof now === 'function' ? now() : now);
    if (Number.isNaN(importedAt.getTime())) throw new Error('The import clock returned an invalid date.');
    const wantsClaude = wantedTargets.includes('cli') || wantedTargets.includes('desktop');
    const wantsDesktop = wantedTargets.includes('desktop');
    const desktopRoot = desktopSessionsDir || defaultDesktopSessionsDir(env, platform);
    const desktopScope = wantsDesktop ? descriptorScope(desktopRoot) : null;
    const descriptors = desktopDescriptors(desktopScope);

    for (const candidate of selected) {
      if (candidate.unavailable) {
        console.log(`Skipped ${candidate.logicalId}: ${candidate.unavailable}.`);
        counts.missing += 1;
        continue;
      }
      if (candidate.conflicted) {
        console.log(`Skipped ${candidate.logicalId}: multiple heads (${candidate.heads.join(', ')}); use --revision.`);
        counts.blocked += 1;
        continue;
      }
      const marker = markerFor(candidate);
      const branch = candidate.digest.git?.branch || '';

      let claudeId = null;
      if (wantsClaude) {
        const choice = chooseReplica(claudeIndex.get(candidate.logicalId), candidate);
        claudeId = choice.detail?.id || uuidFactory();
        if (choice.state === 'dirty') {
          console.log(`Claude: blocked (local replica ${claudeId} has unsaved continuation)`);
          counts.blocked += 1;
          claudeId = null;
        } else if (choice.state === 'exact') {
          console.log(`Claude: skipped (already at ${candidate.revisionId}; ${claudeId})`);
          counts.skipped += 1;
        } else {
          const lines = buildClaudeSession({ events: candidate.events, id: claudeId, cwd: checkout, branch, marker, importedAt, uuidFactory });
          const file = choice.detail?.file || path.join(claudeProject, `${claudeId}.jsonl`);
          const raw = `${lines.join('\n')}\n`;
          atomicNativeWrite(claudeRoot, file, raw, choice.detail?.raw);
          const detail = { id: claudeId, file, raw, lines, marker, tool: 'claude-cli', contentHash: candidate.contentHash };
          addDetail(claudeIndex, candidate.logicalId, detail);
          console.log(`Claude: ${choice.state === 'clean' ? 'updated' : 'created'} ${claudeId} (${file})`);
          counts[choice.state === 'clean' ? 'updated' : 'created'] += 1;
        }

        if (wantsDesktop && claudeId) {
          if (!desktopScope) {
            console.log('Desktop: unavailable (no local descriptor directory to identify the account scope)');
            counts.missing += 1;
          } else if (descriptors.has(claudeId)) {
            console.log(`Desktop: skipped (already linked to ${claudeId})`);
            counts.skipped += 1;
          } else {
            const descriptorId = `local_${uuidFactory()}`;
            const descriptor = {
              sessionId: descriptorId,
              cliSessionId: claudeId,
              cwd: checkout,
              originCwd: checkout,
              worktreePath: '',
              branch,
              title: `(${sourceLabel(candidate.digest)}) ${candidate.realPrompt || '(untitled)'}`,
              titleSource: 'auto',
              createdAt: importedAt.getTime(),
              lastActivityAt: importedAt.getTime(),
              model: 'claude-opus-4-8',
              isArchived: false,
              permissionMode: 'auto',
              completedTurns: candidate.events.filter((event) => event.kind === 'user_message').length,
            };
            const file = path.join(desktopScope, `${descriptorId}.json`);
            atomicNativeWrite(desktopRoot, file, `${JSON.stringify(descriptor, null, 2)}\n`);
            descriptors.set(claudeId, { file, descriptor });
            console.log(`Desktop: created ${descriptorId} (${file})`);
            counts.created += 1;
          }
        }
      }

      if (wantedTargets.includes('codex')) {
        const choice = chooseReplica(codexIndex.get(candidate.logicalId), candidate);
        const id = choice.detail?.id || uuidFactory();
        if (choice.state === 'dirty') {
          console.log(`Codex: blocked (local replica ${id} has unsaved continuation)`);
          counts.blocked += 1;
        } else if (choice.state === 'exact') {
          console.log(`Codex: skipped (already at ${candidate.revisionId}; ${id})`);
          counts.skipped += 1;
        } else {
          const lines = buildCodexSession({ events: candidate.events, id, cwd: checkout, branch, marker, importedAt, uuidFactory });
          const file = choice.detail?.file || codexRolloutPath(codexRoot, importedAt, id);
          const raw = `${lines.join('\n')}\n`;
          atomicNativeWrite(codexRoot, file, raw, choice.detail?.raw);
          const detail = { id, file, raw, lines, marker, tool: 'codex', contentHash: candidate.contentHash };
          addDetail(codexIndex, candidate.logicalId, detail);
          console.log(`Codex: ${choice.state === 'clean' ? 'updated' : 'created'} ${id} (${file})`);
          counts[choice.state === 'clean' ? 'updated' : 'created'] += 1;
        }
      }
    }
  console.log(`read: created ${counts.created}, updated ${counts.updated}, already current ${counts.skipped}, blocked ${counts.blocked}, missing ${counts.missing}.`);
  return counts;
  } finally {
    if (release) release();
  }
}
