import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact } from '../util/redact.mjs';
import { osName, parseClaudeTranscript, relFiles, splitLines } from '../util/transcript.mjs';
import { writeSessionDigest } from '../util/digest.mjs';

function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
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
export function scrapeDesktop({ all, force, sessionsDir, projectsDir, env = process.env, platform = process.platform } = {}) {
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
  let deduped = 0;
  const byProject = {};

  for (const { f: mf, mtime } of metaFiles) {
    if (!all && mtime <= cursor) continue;
    if (mtime > newCursor) newCursor = mtime;

    let m;
    try {
      m = JSON.parse(readFileSync(mf, 'utf8'));
    } catch {
      continue;
    }
    const cliId = m.cliSessionId ?? null;
    if (!cliId) continue;
    const cwd = m.worktreePath || m.cwd || null;
    if (!cwd) continue;
    const mBranch = m.branch ?? null;
    const mTitle = m.title ?? null;

    const g = gitInfo(cwd);
    if (!g.main_root) {
      skipped += 1;
      continue;
    }
    const projectRoot = g.main_root;
    const project = path.basename(projectRoot);

    const idClean = String(cliId).replace(/[^A-Za-z0-9]/g, '');
    const shortId = idClean.slice(0, 8);
    const digestsDir = path.join(projectRoot, 'session-history', 'digests');
    let hasCliDigest = false;
    if (existsSync(digestsDir)) {
      hasCliDigest = readdirSync(digestsDir).some((n) => n.endsWith(`-claude-cli-${shortId}.json`));
    }
    if (!force && hasCliDigest) {
      deduped += 1;
      continue;
    }

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
      redacted = lines.map(redact);
    }
    if (mBranch && mBranch !== 'HEAD') g.branch = mBranch;

    let firstPromptTrunc = null;
    if (firstPrompt) firstPromptTrunc = redact(String(firstPrompt)).slice(0, 200);

    const digest = {
      schema: 1,
      id: cliId,
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
    writeSessionDigest({ digest, redactedLines: redacted, projectRoot });
    written += 1;
    byProject[project] = (byProject[project] ?? 0) + 1;
  }

  writeFileSync(cursorFile, String(newCursor), 'utf8');

  const out = [`desktop-scrape: wrote ${written}, deduped ${deduped} (already captured via CLI), skipped ${skipped} (non-git).`];
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) out.push(`  ${k}: ${v}`);
  return { written, lines: out };
}
