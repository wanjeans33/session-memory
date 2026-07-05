import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { encodeProject } from '../util/transcript.mjs';

const LEGACY_MEMORY_HOOK = /memory-sync[\\/]sync\./;
const LEGACY_CAPTURE_HOOK = /claude-session-end|claude-scrape|[\\/]session-history[\\/]capture[\\/]/;

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Connect this memory repository to Claude Code and Codex. Idempotent; safe to re-run.
// Replaces the former install-windows.ps1 / install-mac.sh with one cross-platform path.
// skillsOnly links the skills into the target project and nothing else — no memory
// junction, no CLAUDE.md import, no hooks — so a collaborator can enable per-project
// session sharing from a clone of the public repo without wiring up personal memory sync.
export function installNative(repositoryDir, paths, { projectDir = process.cwd(), skillsOnly = false, dryRun = false, platform = process.platform } = {}) {
  const repo = path.resolve(repositoryDir);
  const repoFwd = repo.replace(/\\/g, '/');
  const project = path.resolve(projectDir);
  const claudeDir = paths.claudeDir;
  const linkType = platform === 'win32' ? 'junction' : 'dir';

  const ensureDir = (p) => {
    if (!dryRun) mkdirSync(p, { recursive: true });
  };
  const removePath = (p) => {
    if (!dryRun) rmSync(p, { recursive: true, force: true });
  };
  const link = (target, linkPath) => {
    if (!dryRun) symlinkSync(target, linkPath, linkType);
  };

  console.log(`Repository: ${repo}`);
  console.log(`Target project for skills: ${project}`);

  if (!skillsOnly) {
    // 1) Memory junction/symlink: ~/.claude/projects/<encoded>/memory -> <repo>/memory
    const projMem = path.join(claudeDir, 'projects', encodeProject(repo), 'memory');
    const repoMem = path.join(repo, 'memory');
    ensureDir(path.dirname(projMem));
    ensureDir(repoMem);
    if (existsSync(projMem) || isLink(projMem)) {
      if (isLink(projMem)) {
        removePath(projMem);
      } else if (!dryRun) {
        try {
          cpSync(projMem, repoMem, { recursive: true, force: true });
        } catch {
          // best-effort migration
        }
        removePath(projMem);
      }
    }
    link(repoMem, projMem);
    console.log(`✓ Memory link: ${projMem} -> ${repoMem}`);
  }

  // 1b) Project-local skill links: Claude uses <repo>/.claude/skills;
  // Codex uses <repo>/.agents/skills. The source stays in the memory repo.
  const skillsSrc = path.join(repo, 'skills');
  if (existsSync(skillsSrc)) {
    const skillDsts = [path.join(project, '.claude', 'skills'), path.join(project, '.agents', 'skills')];
    const skills = readdirSync(skillsSrc, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const dst of skillDsts) {
      ensureDir(dst);
      for (const sk of skills) {
        const linkPath = path.join(dst, sk.name);
        assertInsideProject(linkPath, project);
        if (existsSync(linkPath) || isLink(linkPath)) removePath(linkPath);
        link(path.join(skillsSrc, sk.name), linkPath);
        console.log(`✓ Project skill link: ${linkPath} -> ${path.join(skillsSrc, sk.name)}`);
      }
      // Remove the legacy session-share link, renamed to session-memory.
      const legacy = path.join(dst, 'session-share');
      if (isLink(legacy)) {
        removePath(legacy);
        console.log('✓ Removed legacy skill link: session-share');
      }
    }

    // Clean up older global skill links created by previous installers, but only
    // when they point back to this memory repo's skills.
    const legacyGlobalDsts = [path.join(claudeDir, 'skills'), paths.codexSkillsDir];
    for (const dst of legacyGlobalDsts) {
      for (const sk of skills) {
        const legacyLink = path.join(dst, sk.name);
        if (!isLink(legacyLink)) continue;
        const expected = realpathSync(path.join(skillsSrc, sk.name));
        let actual = null;
        try {
          actual = realpathSync(legacyLink);
        } catch {
          actual = null;
        }
        if (actual && path.normalize(actual) === path.normalize(expected)) {
          removePath(legacyLink);
          console.log(`✓ Removed previous global skill link: ${legacyLink}`);
        }
      }
    }
  }

  if (skillsOnly) {
    console.log('• Skills-only install: memory sync, CLAUDE.md import, and hooks were not touched.');
    console.log('');
    console.log('Done. Start a new Claude Code or Codex session in the target project, then use /session-memory save|read|get.');
    return;
  }

  // 2) CLAUDE.md @import
  const userMd = path.join(claudeDir, 'CLAUDE.md');
  const importLine = `@${repoFwd}/CLAUDE.md`;
  const mdContent = existsSync(userMd) ? readFileSync(userMd, 'utf8') : '';
  if (!mdContent.includes(importLine)) {
    if (!dryRun) {
      ensureDir(claudeDir);
      writeFileSync(userMd, `${mdContent}\n# Cross-device shared memory (installed by claude-session-memory)\n${importLine}\n`, 'utf8');
    }
    console.log('✓ Added import to ~/.claude/CLAUDE.md');
  } else {
    console.log('• ~/.claude/CLAUDE.md already contains the import; skipped');
  }

  // 3)+4) settings.json merge and memory-sync hooks
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    if (!dryRun) copyFileSync(settingsPath, `${settingsPath}.bak`);
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim()) settings = JSON.parse(raw);
  }

  const sharedPath = path.join(repo, 'settings', 'settings.shared.json');
  if (existsSync(sharedPath)) {
    const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
    for (const [k, v] of Object.entries(shared)) {
      if (!(k in settings)) settings[k] = v;
    }
  }

  const node = process.execPath;
  const repoBin = path.join(repo, 'bin', 'session-memory.mjs');
  const startCmd = `"${node}" "${repoBin}" sync --pull-only`;
  const endCmd = `"${node}" "${repoBin}" sync`;

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  stripHooks(settings.hooks, 'SessionStart', LEGACY_MEMORY_HOOK);
  stripHooks(settings.hooks, 'SessionEnd', LEGACY_MEMORY_HOOK);
  stripHooks(settings.hooks, 'SessionEnd', LEGACY_CAPTURE_HOOK);
  addHook(settings.hooks, 'SessionStart', startCmd);
  addHook(settings.hooks, 'SessionEnd', endCmd);

  if (!dryRun) writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  console.log('✓ Merged settings.json and installed memory-sync hooks (backup: settings.json.bak)');
  console.log('• Session capture is manual: Claude uses /session-memory save; Codex uses $session-memory save');
  console.log('');
  console.log('Done. Start a new Claude Code or Codex session in the target project to load the skills.');
}

function assertInsideProject(candidate, project) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedProject = path.resolve(project);
  const normalize = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  const c = normalize(resolvedCandidate);
  const p = normalize(resolvedProject);
  if (c !== p && !c.startsWith(`${p}${path.sep}`)) {
    throw new Error(`Refusing to replace skill outside target project: ${candidate}`);
  }
}

function stripHooks(hooks, event, pattern) {
  if (!Array.isArray(hooks[event])) return;
  hooks[event] = hooks[event].filter((group) => {
    const cmds = Array.isArray(group.hooks) ? group.hooks.map((h) => h.command || '') : [];
    return !cmds.some((c) => pattern.test(c));
  });
}

function addHook(hooks, event, command) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const exists = hooks[event].some((group) => Array.isArray(group.hooks) && group.hooks.some((h) => h.command === command));
  if (!exists) hooks[event].push({ hooks: [{ type: 'command', command }] });
}
