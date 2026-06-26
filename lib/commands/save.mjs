import { scrapeClaude } from '../capture/claude.mjs';
import { scrapeCodex } from '../capture/codex.mjs';
import { scrapeDesktop } from '../capture/desktop.mjs';
import { gitInfo } from '../util/git.mjs';
import { commitSessionHistory } from '../util/digest.mjs';

// Store sessions in the target project's session-history/. Manual command.
//   --all      scan every client on this machine (Claude CLI/Desktop + Codex)
//   (default)  capture only the current session (latest in cwd's project dir)
//   --commit   commit the project's session-history/ afterwards (meaningful with the default)
export function save({ all = false, commit = false, cwd } = {}) {
  const base = cwd || process.cwd();

  if (all) {
    console.log('save --all: scanning every client…');
    for (const { lines } of [scrapeClaude({ all: true }), scrapeCodex({ all: true }), scrapeDesktop({ all: true })]) {
      for (const line of lines) console.log(line);
    }
    console.log('save --all complete.');
    return;
  }

  for (const line of scrapeClaude({ current: true, cwd: base }).lines) console.log(line);
  if (commit) {
    const g = gitInfo(base);
    if (g.main_root) {
      const ok = commitSessionHistory(g.main_root, 'chore(session-history): save current session');
      console.log(ok ? 'Committed session-history.' : 'Nothing to commit.');
    }
  }
}
