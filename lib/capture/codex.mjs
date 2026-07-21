import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact, redactJsonLine } from '../util/redact.mjs';
import { osName, splitLines } from '../util/transcript.mjs';
import { cleanRealUserText, firstRealInputText } from '../util/user-text.mjs';
import {
  normalizeSessionMarker,
  saveSessionRevision,
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
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

function pathKey(value) {
  if (!value) return null;
  let resolved = path.resolve(value);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Keep the resolved path when a session points at a checkout that no longer exists.
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function checkoutKey(cwd) {
  const g = gitInfo(cwd);
  return pathKey(g.toplevel || cwd);
}

function rolloutMeta(file) {
  const lines = splitLines(readFileSync(file, 'utf8'));
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'session_meta' && row.payload) return row.payload;
    } catch {
      // Ignore partial or malformed records in an actively written rollout.
    }
  }
  return null;
}

function rolloutCwd(file) {
  return rolloutMeta(file)?.cwd || null;
}

export function findCurrentCodexRollout({ cwd, sessionsDir, env = process.env } = {}) {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  const dir = sessionsDir || path.join(codexHome, 'sessions');
  if (!existsSync(dir)) return null;
  const files = walk(dir, (name) => /^rollout-.*\.jsonl$/.test(name))
    .map((file) => ({ path: file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const threadId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (threadId) {
    const exact = files.find((candidate) => String(rolloutMeta(candidate.path)?.id || '') === String(threadId));
    if (exact) return { ...exact, exact: true };
    return null;
  }

  const target = checkoutKey(cwd || process.cwd());
  for (const candidate of files) {
    const sessionCwd = rolloutCwd(candidate.path);
    if (sessionCwd && checkoutKey(sessionCwd) === target) return { ...candidate, exact: false };
  }
  return null;
}

// Cursor values are mtime milliseconds. Old PowerShell installs stored .NET ticks
// (~6e17); treat any absurdly large value as stale so we rescan instead of skipping all.
function readCursor(cursorFile) {
  if (!existsSync(cursorFile)) return 0;
  try {
    const n = Number(readFileSync(cursorFile, 'utf8').trim());
    if (!Number.isFinite(n) || n > 1e15) return 0;
    return n;
  } catch {
    return 0;
  }
}

// Scan Codex CLI rollout sessions and route digests to each session's project repo.
export function scrapeCodex({
  all,
  current,
  cwd,
  rolloutPath,
  sessionsDir,
  cursorDir,
  projectRoot: expectedProjectRoot,
  env = process.env,
  uuidFactory,
  now,
} = {}) {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  const dir = sessionsDir || path.join(codexHome, 'sessions');
  if (!existsSync(dir)) return { written: 0, lines: [`no codex sessions dir: ${dir}`] };

  const cursorFile = path.join(cursorDir || path.join(os.homedir(), '.claude'), '.codex-scrape-cursor');
  const targeted = Boolean(rolloutPath || current);
  const cursor = all || targeted ? 0 : readCursor(cursorFile);

  let files;
  if (rolloutPath) {
    files = existsSync(rolloutPath) ? [{ f: rolloutPath, mtime: statSync(rolloutPath).mtimeMs }] : [];
  } else if (current) {
    const latest = findCurrentCodexRollout({ cwd, sessionsDir: dir, env });
    files = latest ? [{ f: latest.path, mtime: latest.mtime }] : [];
  } else {
    files = walk(dir, (name) => /^rollout-.*\.jsonl$/.test(name)).map((f) => ({ f, mtime: statSync(f).mtimeMs }));
  }
  files.sort((a, b) => a.mtime - b.mtime);

  let newCursor = cursor;
  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const byProject = {};
  const digestPaths = [];

  for (const { f: file, mtime } of files) {
    if (!all && !targeted && mtime <= cursor) continue;
    if (mtime > newCursor) newCursor = mtime;

    try {
    const lines = splitLines(readFileSync(file, 'utf8'));
    if (lines.length === 0) continue;

    const markerInfo = sessionMarker(lines, 'codex');
    let marker = normalizeSessionMarker(markerInfo.marker);

    let id = null;
    let cwd = null;
    let origin = null;
    let cliVer = null;
    let startedAt = null;
    let endedAt = null;
    let turns = 0;
    let firstPrompt = null;
    const eventPrompts = [];
    const responsePrompts = [];
    const touched = new Set();
    const tools = {};

    for (const ln of lines) {
      if (!ln || !ln.trim()) continue;
      let o;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      if (o.timestamp) {
        if (!startedAt) startedAt = o.timestamp;
        endedAt = o.timestamp;
      }
      if (o.type === 'session_meta' && o.payload) {
        id = o.payload.id;
        cwd = o.payload.cwd;
        origin = o.payload.originator;
        cliVer = o.payload.cli_version;
        continue;
      }
      if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
        const prompt = cleanRealUserText(o.payload.message);
        if (prompt) eventPrompts.push(prompt);
        continue;
      }
      if (o.type !== 'response_item' || !o.payload) continue;
      const p = o.payload;
      if (p.type === 'message') {
        if (p.role === 'user' && Array.isArray(p.content)) {
          const txt = firstRealInputText(p.content);
          if (txt) responsePrompts.push(txt);
        }
      } else if (p.type === 'function_call') {
        if (p.name) tools[p.name] = (tools[p.name] ?? 0) + 1;
      } else if (p.type === 'custom_tool_call') {
        if (p.name) tools[p.name] = (tools[p.name] ?? 0) + 1;
        if (p.name === 'apply_patch' && p.input) {
          for (const pl of String(p.input).split('\n')) {
            const m = pl.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
            if (m) touched.add(m[1].trim());
          }
        }
      }
    }
    const prompts = eventPrompts.length > 0 ? eventPrompts : responsePrompts;
    turns = prompts.length;
    firstPrompt = prompts[0] || null;
    if (!id) id = path.basename(file, path.extname(file));

    const g = gitInfo(cwd);
    if (!g.toplevel) {
      if (targeted) throw new Error(`Selected Codex session has no available Git checkout: ${file}`);
      skipped += 1;
      continue;
    }
    const projectRoot = g.toplevel;
    if (expectedProjectRoot && pathKey(projectRoot) !== pathKey(expectedProjectRoot)) {
      if (targeted) {
        throw new Error(`Selected Codex session belongs to ${projectRoot}, not ${expectedProjectRoot}.`);
      }
      skipped += 1;
      continue;
    }
    const project = path.basename(projectRoot);
    const redactedLines = lines.map(redactJsonLine);

    let rootResolved = projectRoot;
    try {
      rootResolved = realpathSync(projectRoot);
    } catch {
      // keep projectRoot
    }
    const rr = rootResolved.replace(/\\/g, '/').toLowerCase();
    const rel = [...touched].map((f) => {
      const fp = f.replace(/\\/g, '/');
      return fp.toLowerCase().startsWith(rr) ? fp.slice(rr.length).replace(/^\/+/, '') : fp;
    });
    let firstPromptTrunc = null;
    if (firstPrompt) firstPromptTrunc = redact(firstPrompt).slice(0, 200);

    const digest = {
      schema: 3,
      id,
      native_session_id: id,
      tool: 'codex',
      origin,
      machine: os.hostname(),
      os: osName(),
      project,
      cwd: cwd ? cwd.replace(/\\/g, '/') : null,
      git: { branch: g.branch, is_worktree: g.is_worktree, worktree: g.worktree, head: g.head, dirty: g.dirty },
      started_at: startedAt,
      ended_at: endedAt,
      turns,
      first_prompt: firstPromptTrunc,
      summary: '',
      files_touched: rel,
      tools_used: tools,
      next_steps: [],
      cli_version: cliVer,
      transcript_ref: null,
    };
    const result = saveSessionRevision({
      digest,
      transcriptLines: redactedLines,
      projectRoot,
      marker,
      env,
      uuidFactory,
      now,
    });
    if (result.status === 'saved') {
      digestPaths.push(`${result.logical_id}@${result.revision_id}: ${result.revision_path}`);
      written += 1;
      byProject[project] = (byProject[project] ?? 0) + 1;
    } else {
      unchanged += 1;
    }
    } catch (error) {
      if (targeted) throw error;
      failed += 1;
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!all && !targeted && newCursor > 0) writeFileSync(cursorFile, String(newCursor), 'utf8');

  const out = [`codex-scrape: saved ${written} revision(s), skipped ${unchanged} unchanged, ${skipped} unavailable/other-project, ${failed} failed.`];
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) out.push(`  ${k}: ${v}`);
  for (const digestPath of digestPaths) out.push(`  ${digestPath}`);
  for (const failure of failures) out.push(`  ERROR ${failure}`);
  return { written, unchanged, failed, lines: out };
}
