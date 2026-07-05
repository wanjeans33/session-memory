import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitInfo } from '../util/git.mjs';
import { redact } from '../util/redact.mjs';
import { osName, splitLines } from '../util/transcript.mjs';
import { writeSessionDigest } from '../util/digest.mjs';

const INJECT_PREFIXES = ['# AGENTS.md', '<INSTRUCTIONS', '<permissions', '<user_instructions', '<environment_context', '<system', '<context'];

function isRealUser(t) {
  if (!t) return false;
  const s = t.replace(/^\s+/, '');
  return !INJECT_PREFIXES.some((p) => s.startsWith(p));
}

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
export function scrapeCodex({ all, sessionsDir, cursorDir } = {}) {
  const dir = sessionsDir || path.join(os.homedir(), '.codex', 'sessions');
  if (!existsSync(dir)) return { written: 0, lines: [`no codex sessions dir: ${dir}`] };

  const cursorFile = path.join(cursorDir || path.join(os.homedir(), '.claude'), '.codex-scrape-cursor');
  const cursor = all ? 0 : readCursor(cursorFile);

  const files = walk(dir, (name) => /^rollout-.*\.jsonl$/.test(name)).map((f) => ({ f, mtime: statSync(f).mtimeMs }));
  files.sort((a, b) => a.mtime - b.mtime);

  let newCursor = cursor;
  let written = 0;
  let skipped = 0;
  const byProject = {};

  for (const { f: file, mtime } of files) {
    if (!all && mtime <= cursor) continue;
    if (mtime > newCursor) newCursor = mtime;

    let lines;
    try {
      lines = splitLines(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (lines.length === 0) continue;

    let id = null;
    let cwd = null;
    let origin = null;
    let cliVer = null;
    let startedAt = null;
    let endedAt = null;
    let turns = 0;
    let firstPrompt = null;
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
      if (o.type !== 'response_item' || !o.payload) continue;
      const p = o.payload;
      if (p.type === 'message') {
        if (p.role === 'user' && Array.isArray(p.content)) {
          let txt = null;
          for (const it of p.content) {
            if (it && it.type === 'input_text' && it.text) {
              txt = it.text;
              break;
            }
          }
          if (isRealUser(txt)) {
            turns += 1;
            if (!firstPrompt) firstPrompt = txt;
          }
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
    if (!id) id = path.basename(file, path.extname(file));

    const g = gitInfo(cwd);
    if (!g.main_root) {
      skipped += 1;
      continue;
    }
    const projectRoot = g.main_root;
    const project = path.basename(projectRoot);

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
      schema: 2, // v2: author field + digests/<author>/ namespace (filled in writeSessionDigest)
      id,
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
    writeSessionDigest({ digest, redactedLines: lines.map(redact), projectRoot });
    written += 1;
    byProject[project] = (byProject[project] ?? 0) + 1;
  }

  if (!all || newCursor > 0) writeFileSync(cursorFile, String(newCursor), 'utf8');

  const out = [`codex-scrape: wrote ${written} digest(s), skipped ${skipped} (non-git).`];
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) out.push(`  ${k}: ${v}`);
  return { written, lines: out };
}
