import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { gitInfo } from '../util/git.mjs';
import { encodeProject, splitLines } from '../util/transcript.mjs';

function label(tool) {
  if (tool === 'codex') return 'codex';
  if (tool === 'claude-desktop') return 'desktop';
  if (tool === 'claude-cli') return 'cli';
  return tool;
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

const toMs = (iso) => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

// Import sessions stored in this project's session-history/ into the current client's list
// (CLI --resume + Desktop sidebar), prefixing titles with a source label like "(codex) …".
export function read({ list = false, import: doImport = false, ids, targets = 'cli', cwd, projectsDir, desktopSessionsDir, env = process.env, platform = process.platform } = {}) {
  const base = cwd || process.cwd();
  const projDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
  const desktopDir = desktopSessionsDir || defaultDesktopSessionsDir(env, platform);

  const g = gitInfo(base);
  const root = g.main_root || base;
  const digestDir = path.join(root, 'session-history', 'digests');
  if (!existsSync(digestDir)) {
    console.log('This project has no session-history/digests (save elsewhere first, then git pull).');
    return;
  }

  // --list
  if (!doImport) {
    const rows = [];
    const names = readdirSync(digestDir).filter((n) => n.endsWith('.json')).sort().reverse();
    for (const name of names) {
      let d;
      try {
        d = JSON.parse(readFileSync(path.join(digestDir, name), 'utf8'));
      } catch {
        continue;
      }
      rows.push({ base: name.replace(/\.json$/, ''), tool: d.tool, machine: d.machine, ended_at: d.ended_at, title: d.title || d.first_prompt });
    }
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // --import
  const wantTargets = targets.split(',').map((t) => t.trim().toLowerCase());
  const wantBases = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (wantBases.length === 0) {
    console.log('Pass --ids <base,base,…> to choose what to import (use --list first).');
    return;
  }

  const targetProjDir = path.join(projDir, encodeProject(base));
  mkdirSync(targetProjDir, { recursive: true });

  let desktopScope = null;
  if (wantTargets.includes('desktop')) {
    const locals = walk(desktopDir, (n) => /^local_.*\.json$/.test(n)).map((f) => ({ f, mtime: statSync(f).mtimeMs }));
    locals.sort((a, b) => b.mtime - a.mtime);
    if (locals[0]) desktopScope = path.dirname(locals[0].f);
  }

  let done = 0;
  for (const baseName of wantBases) {
    const dp = path.join(digestDir, `${baseName}.json`);
    if (!existsSync(dp)) {
      console.log(`Skipped (not found): ${baseName}`);
      continue;
    }
    const d = JSON.parse(readFileSync(dp, 'utf8'));
    const lbl = label(d.tool);
    const newId = randomUUID();
    const title = d.title || d.first_prompt || '(untitled)';
    const taggedTitle = `(${lbl}) ${title}`;
    const branch = d.git && d.git.branch ? d.git.branch : '';

    let srcTs = null;
    if (d.transcript_ref) {
      const cand = path.join(root, d.transcript_ref);
      if (existsSync(cand)) srcTs = cand;
    }

    let outLines;
    if (srcTs && (d.tool === 'claude-cli' || d.tool === 'claude-desktop')) {
      const lines = splitLines(readFileSync(srcTs, 'utf8'));
      let tagged = false;
      outLines = lines.map((ln) => {
        if (!tagged && /"type"\s*:\s*"user"/.test(ln)) {
          try {
            const o = JSON.parse(ln);
            if (o.type === 'user' && o.message && o.message.role === 'user') {
              const c = o.message.content;
              if (typeof c === 'string') {
                o.message.content = `(${lbl}) ${c}`;
                tagged = true;
              } else if (Array.isArray(c)) {
                for (const it of c) {
                  if (!tagged && it && it.type === 'text') {
                    it.text = `(${lbl}) ${it.text}`;
                    tagged = true;
                  }
                }
              }
              return JSON.stringify(o);
            }
          } catch {
            // leave line as-is
          }
        }
        return ln;
      });
    } else {
      const u = {
        type: 'user',
        message: { role: 'user', content: `(${lbl}) ${d.first_prompt}` },
        timestamp: d.started_at,
        sessionId: newId,
        cwd: base.replace(/\\/g, '/'),
        gitBranch: branch,
        version: 'imported',
      };
      const note = `[Imported from ${d.tool} (${d.machine})] turns=${d.turns}. Redacted original transcript: ${d.transcript_ref}. Files changed: ${(d.files_touched || []).join(', ')}`;
      const a = {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: note }] },
        timestamp: d.ended_at,
        sessionId: newId,
      };
      outLines = [JSON.stringify(u), JSON.stringify(a)];
    }

    const jsonlPath = path.join(targetProjDir, `${newId}.jsonl`);
    writeFileSync(jsonlPath, outLines.join('\n') + '\n', 'utf8');
    let msg = `Imported ${baseName} → CLI: ${jsonlPath}`;

    if (wantTargets.includes('desktop') && desktopScope) {
      const descSessionId = `local_${randomUUID()}`;
      const desc = {
        sessionId: descSessionId,
        cliSessionId: newId,
        cwd: base,
        originCwd: base,
        worktreePath: '',
        branch,
        title: taggedTitle,
        titleSource: 'auto',
        createdAt: toMs(d.started_at),
        lastActivityAt: toMs(d.ended_at),
        model: 'claude-opus-4-8',
        isArchived: false,
        permissionMode: 'auto',
        completedTurns: d.turns,
      };
      const descPath = path.join(desktopScope, `local_${descSessionId.slice(6)}.json`);
      writeFileSync(descPath, JSON.stringify(desc, null, 2), 'utf8');
      msg += ` | Desktop: ${descPath}`;
    } else if (wantTargets.includes('desktop')) {
      msg += ' | Desktop: skipped (no existing local_*.json to infer the account directory)';
    }
    console.log(msg);
    done += 1;
  }
  console.log(`read: imported ${done}.`);
}
