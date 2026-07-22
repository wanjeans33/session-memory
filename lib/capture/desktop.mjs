import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact, redactJsonLine } from '../util/redact.mjs';
import { osName, parseClaudeTranscript, relFiles, splitLines } from '../util/transcript.mjs';
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
    // Preserve a lexical key when the recorded checkout no longer exists.
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function defaultDesktopSessionsDir(env, platform) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude-code-sessions');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude-code-sessions');
}

function toIso(ms) {
  if (!ms || ms <= 0) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Enrich Claude Desktop sessions (metadata in local_*.json + transcript in ~/.claude/projects).
export function scrapeDesktop({ all, sessionsDir, projectsDir, projectRoot: expectedProjectRoot, env = process.env, platform = process.platform, uuidFactory, now } = {}) {
  const dir = sessionsDir || defaultDesktopSessionsDir(env, platform);
  const projDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(dir)) return { written: 0, lines: [`no Desktop sessions dir: ${dir}`] };

  const cursorFile = path.join(os.homedir(), '.claude', '.desktop-scrape-cursor');
  let cursor = 0;
  if (!all && existsSync(cursorFile)) {
    const n = Number(readFileSync(cursorFile, 'utf8').trim());
    cursor = Number.isFinite(n) && n <= 1e15 ? n : 0;
  }

  const metaFiles = walk(dir, (name) => /^local_.*\.json$/.test(name)).map((f) => ({ f, mtime: statSync(f).mtimeMs }));
  metaFiles.sort((a, b) => a.mtime - b.mtime);

  let newCursor = cursor;
  let written = 0;
  let skipped = 0;
  let unchanged = 0;
  let failed = 0;
  const failures = [];
  const byProject = {};

  for (const { f: mf, mtime } of metaFiles) {
    if (!all && mtime <= cursor) continue;
    if (mtime > newCursor) newCursor = mtime;

    try {
    let text;
    try {
      text = readFileSync(mf, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read Desktop session descriptor ${mf}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let m;
    try {
      m = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid Desktop session descriptor ${mf}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const cliId = m.cliSessionId ?? null;
    if (!cliId) continue;
    const cwd = m.worktreePath || m.cwd || null;
    if (!cwd) continue;
    const mBranch = m.branch ?? null;
    const mTitle = m.title ?? null;

    const g = gitInfo(cwd);
    if (!g.toplevel) {
      skipped += 1;
      continue;
    }
    const projectRoot = g.toplevel;
    if (expectedProjectRoot && pathKey(projectRoot) !== pathKey(expectedProjectRoot)) {
      skipped += 1;
      continue;
    }
    const project = path.basename(projectRoot);

    const trMatches = walk(projDir, (name) => name === `${cliId}.jsonl`);
    const tr = trMatches[0] || null;
    let turns = m.completedTurns ?? 0;
    let firstPrompt = mTitle;
    let started = toIso(Number(m.createdAt));
    let ended = toIso(Number(m.lastActivityAt));
    let version = null;
    let rel = [];
    let tools = {};
    let redacted = null;

    if (tr) {
      const lines = splitLines(readFileSync(tr, 'utf8'));
      const p = parseClaudeTranscript(lines);
      rel = relFiles(p.files, projectRoot);
      tools = p.tools;
      if (p.turns > 0) turns = p.turns;
      if (p.first_prompt) firstPrompt = p.first_prompt;
      if (p.started_at) started = p.started_at;
      if (p.ended_at) ended = p.ended_at;
      if (p.branch && p.branch !== 'HEAD') g.branch = p.branch;
      version = p.version;
      redacted = lines.map(redactJsonLine);
    }
    if (mBranch && mBranch !== 'HEAD') g.branch = mBranch;

    if (!redacted) {
      skipped += 1;
      continue;
    }
    const markerInfo = sessionMarker(redacted, 'claude-desktop');
    const marker = normalizeSessionMarker(markerInfo.marker);

    let firstPromptTrunc = null;
    if (firstPrompt) firstPromptTrunc = redact(String(firstPrompt)).slice(0, 200);

    const digest = {
      schema: 3,
      id: cliId,
      native_session_id: cliId,
      tool: 'claude-desktop',
      origin: 'desktop',
      machine: os.hostname(),
      os: osName(),
      project,
      cwd: cwd.replace(/\\/g, '/'),
      git: { branch: g.branch, is_worktree: g.is_worktree, worktree: g.worktree, head: g.head, dirty: g.dirty },
      started_at: started,
      ended_at: ended,
      turns,
      first_prompt: firstPromptTrunc,
      title: mTitle,
      summary: '',
      files_touched: rel,
      tools_used: tools,
      next_steps: [],
      cli_version: version,
      transcript_ref: null,
    };
    const result = saveSessionRevision({
      digest,
      transcriptLines: redacted,
      projectRoot,
      marker,
      env,
      uuidFactory,
      now,
    });
    if (result.status === 'saved') {
      written += 1;
      byProject[project] = (byProject[project] ?? 0) + 1;
    } else {
      unchanged += 1;
    }
    } catch (error) {
      failed += 1;
      failures.push(`${mf}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!all) writeFileSync(cursorFile, String(newCursor), 'utf8');

  const out = [`desktop-scrape: saved ${written} revision(s), skipped ${unchanged} unchanged, ${skipped} unavailable/non-git, ${failed} failed.`];
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) out.push(`  ${k}: ${v}`);
  for (const failure of failures) out.push(`  ERROR ${failure}`);
  return { written, unchanged, failed, lines: out };
}
