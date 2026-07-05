import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact } from '../util/redact.mjs';
import { encodeProject, osName, parseClaudeTranscript, relFiles, splitLines } from '../util/transcript.mjs';
import { writeSessionDigest } from '../util/digest.mjs';

// Recursively collect files matching a predicate.
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
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function saveOneTranscript(tp) {
  if (!existsSync(tp)) return null;
  const lines = splitLines(readFileSync(tp, 'utf8'));
  if (lines.length === 0) return null;

  const p = parseClaudeTranscript(lines);
  const id = p.id || path.basename(tp, path.extname(tp));
  const cwd = p.cwd;
  const g = gitInfo(cwd);
  const projectRoot = g.main_root || cwd || path.dirname(tp);
  if (p.branch && p.branch !== 'HEAD') g.branch = p.branch;
  const project = path.basename(projectRoot);
  const rel = relFiles(p.files, projectRoot);
  let firstPrompt = null;
  if (p.first_prompt) firstPrompt = redact(p.first_prompt).slice(0, 200);

  const digest = {
    schema: 2, // v2: author field + digests/<author>/ namespace (filled in writeSessionDigest)
    id,
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
  const redacted = lines.map(redact);
  return writeSessionDigest({ digest, redactedLines: redacted, projectRoot });
}

// Capture Claude Code sessions (CLI / Desktop share ~/.claude/projects/<encoded>/<id>.jsonl).
export function scrapeClaude({ current, all, transcriptPath, cwd, projectsDir } = {}) {
  const dir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  let targets = [];

  if (transcriptPath) {
    targets = [transcriptPath];
  } else if (all) {
    if (existsSync(dir)) {
      targets = walk(dir, (f) => f.endsWith('.jsonl') && !/[\\/]memory[\\/]/.test(f));
    }
  } else {
    const base = cwd || process.cwd();
    const projDir = path.join(dir, encodeProject(base));
    if (existsSync(projDir)) {
      const jsonls = readdirSync(projDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(projDir, f));
      let latest = null;
      let latestMtime = -1;
      for (const f of jsonls) {
        const mtime = statSync(f).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latest = f;
        }
      }
      if (latest) targets = [latest];
    }
  }

  let written = 0;
  for (const t of targets) {
    try {
      if (saveOneTranscript(t)) written += 1;
    } catch {
      // best-effort per transcript
    }
  }
  return { written, lines: [`claude-scrape: wrote ${written} digest(s).`] };
}
