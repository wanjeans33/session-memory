import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact, redactJsonLine } from '../util/redact.mjs';
import { encodeProject, osName, parseClaudeTranscript, relFiles, splitLines } from '../util/transcript.mjs';
import {
  normalizeSessionMarker,
  saveSessionRevision,
  sessionMarker,
} from '../util/session-ledger.mjs';

// Recursively collect files matching a predicate.
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
    else if (predicate(full)) out.push(full);
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

function saveOneTranscript(tp, { env = process.env, uuidFactory, now, projectRoot: expectedProjectRoot } = {}) {
  if (!existsSync(tp)) return null;
  const lines = splitLines(readFileSync(tp, 'utf8'));
  if (lines.length === 0) return null;

  const p = parseClaudeTranscript(lines);
  const id = p.id || path.basename(tp, path.extname(tp));
  const markerInfo = sessionMarker(lines, 'claude-cli');
  const cwd = p.cwd;
  const g = gitInfo(cwd);
  const projectRoot = g.toplevel || cwd || path.dirname(tp);
  if (expectedProjectRoot && pathKey(projectRoot) !== pathKey(expectedProjectRoot)) {
    return { status: 'other-project', source_path: tp };
  }
  const marker = normalizeSessionMarker(markerInfo.marker);
  const redacted = lines.map(redactJsonLine);
  if (p.branch && p.branch !== 'HEAD') g.branch = p.branch;
  const project = path.basename(projectRoot);
  const rel = relFiles(p.files, projectRoot);
  let firstPrompt = null;
  if (p.first_prompt) firstPrompt = redact(p.first_prompt).slice(0, 200);

  const digest = {
    schema: 3,
    id,
    native_session_id: id,
    tool: 'claude-cli',
    origin: null,
    machine: os.hostname(),
    os: osName(),
    project,
    cwd: cwd ? cwd.replace(/\\/g, '/') : null,
    git: { branch: g.branch, is_worktree: g.is_worktree, worktree: g.worktree, head: g.head, dirty: g.dirty },
    started_at: p.started_at,
    ended_at: p.ended_at,
    turns: p.turns,
    first_prompt: firstPrompt,
    summary: '',
    files_touched: rel,
    tools_used: p.tools,
    next_steps: [],
    cli_version: p.version,
    transcript_ref: null,
  };
  return saveSessionRevision({
    digest,
    transcriptLines: redacted,
    projectRoot,
    marker,
    env,
    uuidFactory,
    now,
  });
}

export function findCurrentClaudeTranscript({ cwd, projectsDir } = {}) {
  const dir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const base = cwd || process.cwd();
  const projDir = path.join(dir, encodeProject(base));
  if (!existsSync(projDir)) return null;

  let latest = null;
  for (const file of readdirSync(projDir).filter((name) => name.endsWith('.jsonl'))) {
    const full = path.join(projDir, file);
    const mtime = statSync(full).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { path: full, mtime };
  }
  return latest;
}

// Capture Claude Code sessions (CLI / Desktop share ~/.claude/projects/<encoded>/<id>.jsonl).
export function scrapeClaude({ current, all, transcriptPath, cwd, projectsDir, projectRoot, env = process.env, uuidFactory, now } = {}) {
  const dir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  let targets = [];

  if (transcriptPath) {
    targets = [transcriptPath];
  } else if (all) {
    if (existsSync(dir)) {
      targets = walk(dir, (f) => f.endsWith('.jsonl') && !/[\\/]memory[\\/]/.test(f));
    }
  } else {
    const latest = findCurrentClaudeTranscript({ cwd, projectsDir: dir });
    if (latest) targets = [latest.path];
  }

  let written = 0;
  let unchanged = 0;
  let otherProject = 0;
  let failed = 0;
  const paths = [];
  const failures = [];
  for (const t of targets) {
    try {
      const result = saveOneTranscript(t, { env, uuidFactory, now, projectRoot });
      if (result?.status === 'saved') {
        written += 1;
        paths.push(`${result.logical_id}@${result.revision_id}: ${result.revision_path}`);
      } else if (result?.status === 'unchanged' || result?.status === 'unchanged-import' || result?.status === 'empty') {
        unchanged += 1;
      } else if (result?.status === 'other-project') {
        otherProject += 1;
      }
    } catch (error) {
      if (transcriptPath || current) throw error;
      failed += 1;
      failures.push(`${t}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if ((transcriptPath || current) && otherProject > 0) {
    throw new Error(`Selected Claude session does not belong to project ${projectRoot || cwd || process.cwd()}.`);
  }
  return {
    written,
    unchanged,
    failed,
    lines: [
      `claude-scrape: saved ${written} revision(s), skipped ${unchanged} unchanged, ${otherProject} other-project, ${failed} failed.`,
      ...paths.map((p) => `  ${p}`),
      ...failures.map((failure) => `  ERROR ${failure}`),
    ],
  };
}
