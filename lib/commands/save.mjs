import { findCurrentClaudeTranscript, scrapeClaude } from '../capture/claude.mjs';
import { findCurrentCodexRollout, scrapeCodex } from '../capture/codex.mjs';
import { scrapeDesktop } from '../capture/desktop.mjs';
import { gitInfo } from '../util/git.mjs';
import { commitSessionHistory } from '../util/digest.mjs';
import { run } from '../util/run.mjs';
import { acquireSessionLedgerWriteLock } from '../util/session-ledger.mjs';

// Store sessions in the target project's session-history/. Manual command.
//   --all      scan every client on this machine for sessions in the current project
//   (default)  capture only the current session (latest in cwd's project dir)
//   --commit   commit the project's session-history/ afterwards (meaningful with the default)
export function save({
  all = false,
  commit = false,
  publish = false,
  cwd,
  projectsDir,
  sessionsDir,
  env = process.env,
  uuidFactory,
  now,
} = {}) {
  const base = cwd || process.cwd();
  const currentProjectRoot = gitInfo(base).toplevel || base;

  if (all && (commit || publish)) {
    throw new Error('save --all is project-scoped but may capture several sessions; commit or publish them explicitly after reviewing session-history/.');
  }

  const releaseLedgerLock = acquireSessionLedgerWriteLock(currentProjectRoot);
  try {
    if (all) {
      const projectRoot = currentProjectRoot;
      console.log(`save --all: scanning every client for project ${projectRoot}`);
      const results = [
        scrapeClaude({ all: true, projectsDir, projectRoot, env, uuidFactory, now }),
        scrapeCodex({ all: true, sessionsDir, projectRoot, env, uuidFactory, now }),
        scrapeDesktop({ all: true, projectsDir, projectRoot, env, uuidFactory, now }),
      ];
      for (const { lines } of results) {
        for (const line of lines) console.log(line);
      }
      const failed = results.reduce((count, result) => count + (result.failed || 0), 0);
      if (failed > 0) throw new Error(`save --all failed for ${failed} session(s); see ERROR lines above.`);
      console.log('save --all complete.');
      return;
    }

    const claudeCurrent = findCurrentClaudeTranscript({ cwd: base, projectsDir });
    const codexCurrent = findCurrentCodexRollout({ cwd: base, sessionsDir, env });
    const requestedCodexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
    if (requestedCodexId && !codexCurrent) {
      throw new Error(`Exact Codex session not found: ${requestedCodexId}`);
    }
    const exactCodex = codexCurrent?.exact === true;
    const current = requestedCodexId || exactCodex
      ? { tool: 'codex', ...codexCurrent }
      : [
        { tool: 'claude', ...claudeCurrent },
        { tool: 'codex', ...codexCurrent },
      ].filter((candidate) => candidate.path).sort((a, b) => b.mtime - a.mtime)[0];

    if (!current) {
      console.log(`save: no current Claude or Codex session found for ${base}`);
    } else {
      console.log(`save: selected current ${current.tool} session: ${current.path}`);
      const result = current.tool === 'codex'
        ? scrapeCodex({
          rolloutPath: current.path,
          sessionsDir,
          projectRoot: currentProjectRoot,
          env,
          uuidFactory,
          now,
        })
        : scrapeClaude({
          transcriptPath: current.path,
          cwd: base,
          projectsDir,
          projectRoot: currentProjectRoot,
          env,
          uuidFactory,
          now,
        });
      for (const line of result.lines) console.log(line);
    }
    if (commit || publish) {
      const g = gitInfo(base);
      if (!g.toplevel) throw new Error(`Cannot ${publish ? 'publish' : 'commit'} session-history: ${base} is not a Git checkout.`);
      const ok = commitSessionHistory(g.toplevel, 'chore(session-history): save current session');
      console.log(ok ? 'Committed session-history.' : 'Nothing to commit.');
      if (publish) {
        run('git', ['push'], { cwd: g.toplevel });
        console.log('Published current branch; session-history is available after the other device pulls.');
      }
    }
  } finally {
    releaseLedgerLock();
  }
}
