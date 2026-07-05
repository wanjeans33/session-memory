import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, HELP } from './args.mjs';
import { getPaths } from './paths.mjs';
import { run, commandVersion } from './util/run.mjs';
import { git } from './util/git.mjs';
import { installNative } from './commands/install.mjs';
import { sync } from './commands/sync.mjs';
import { save } from './commands/save.mjs';
import { read } from './commands/read.mjs';
import { repoStatus } from './commands/repo-status.mjs';
import { buildStatus } from './commands/build-status.mjs';

const MIN_NODE_MAJOR = 20;

function requireNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required; found ${process.versions.node}.`);
  }
}

const REPOSITORY_MARKERS = ['.git', 'bin/session-memory.mjs', 'lib/main.mjs', 'skills/session-memory/SKILL.md', 'CLAUDE.md'];

function looksLikeRepository(dir) {
  return REPOSITORY_MARKERS.every((entry) => existsSync(path.join(dir, entry)));
}

async function requireRepository(repositoryDir) {
  const missing = REPOSITORY_MARKERS.filter((entry) => !existsSync(path.join(repositoryDir, entry)));
  if (missing.length > 0) {
    throw new Error(`${repositoryDir} is not a supported session-memory repository; missing ${missing.join(', ')}.`);
  }
}

// Root of the checkout this CLI is running from (lib/main.mjs -> repo root). When the CLI
// was installed as an npm package this is the package dir, which fails looksLikeRepository.
function selfRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function readState(paths) {
  try {
    return JSON.parse(await readFile(paths.configFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${paths.configFile}: ${error.message}`);
  }
}

async function writeState(paths, repositoryDir, { dryRun }) {
  const data = JSON.stringify({ repositoryDir, installedAt: new Date().toISOString() }, null, 2) + '\n';
  console.log(`Write installation state: ${paths.configFile}`);
  if (dryRun) return;
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, data, 'utf8');
}

async function resolveRepositoryDir(options, paths) {
  if (options['repo-dir']) return path.resolve(options['repo-dir']);
  const state = await readState(paths);
  if (state?.repositoryDir) return state.repositoryDir;
  const self = selfRoot();
  if (looksLikeRepository(self)) return self; // running from a fresh clone: use it directly
  throw new Error('No repository location is configured. Pass --repo-dir <path> or run init --repo-url <git-url>.');
}

function resolveProjectDir(options) {
  return path.resolve(options['project-dir'] || process.cwd());
}

async function install(repositoryDir, paths, options) {
  await requireRepository(repositoryDir);
  installNative(repositoryDir, paths, { projectDir: resolveProjectDir(options), skillsOnly: options['skills-only'], dryRun: options['dry-run'] });
  await writeState(paths, repositoryDir, { dryRun: options['dry-run'] });
}

async function init(options, paths) {
  if (!options['repo-url']) throw new Error('init requires --repo-url <git-url>.');
  const repositoryDir = path.resolve(options.dir || paths.repositoryDir);

  if (existsSync(repositoryDir)) {
    const entries = await stat(repositoryDir);
    if (!entries.isDirectory()) throw new Error(`${repositoryDir} exists and is not a directory.`);
    const files = await readdir(repositoryDir);
    if (files.length > 0) throw new Error(`${repositoryDir} already exists and is not empty. Use install --repo-dir <path> or choose --dir <path>.`);
  }

  console.log(`Clone private repository into: ${repositoryDir}`);
  if (!options['dry-run']) await mkdir(path.dirname(repositoryDir), { recursive: true });
  run('git', ['clone', options['repo-url'], repositoryDir], { dryRun: options['dry-run'] });

  try {
    await install(repositoryDir, paths, options);
  } catch (error) {
    console.error(`Installation failed. The clone remains at ${repositoryDir} for inspection.`);
    throw error;
  }
}

async function targetStatus(label, target, expected) {
  if (!existsSync(target)) return `${label}: missing (${target})`;
  try {
    const [actual, wanted] = await Promise.all([realpath(target), realpath(expected)]);
    return actual === wanted ? `${label}: ok` : `${label}: points to ${actual}; expected ${wanted}`;
  } catch {
    return `${label}: present but cannot resolve its target`;
  }
}

async function doctor(options, paths) {
  const repositoryDir = await resolveRepositoryDir(options, paths);
  const projectDir = resolveProjectDir(options);
  const results = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  results.push(`Node.js: ${process.versions.node}${nodeMajor >= MIN_NODE_MAJOR ? ' (ok)' : ` (requires ${MIN_NODE_MAJOR}+)`}`);

  const gitVersion = commandVersion('git');
  results.push(gitVersion ? `Git: ${gitVersion} (ok)` : 'Git: unavailable');
  results.push(existsSync(repositoryDir) ? `Repository: ${repositoryDir} (present)` : `Repository: missing (${repositoryDir})`);

  try {
    await requireRepository(repositoryDir);
    results.push('Repository layout: ok');
  } catch (error) {
    results.push(`Repository layout: ${error.message}`);
  }

  const skill = path.join(repositoryDir, 'skills', 'session-memory');
  results.push(existsSync(projectDir) ? `Target project: ${projectDir} (present)` : `Target project: missing (${projectDir})`);
  results.push(await targetStatus('Claude repo skill', path.join(projectDir, '.claude', 'skills', 'session-memory'), skill));
  results.push(await targetStatus('Codex repo skill', path.join(projectDir, '.agents', 'skills', 'session-memory'), skill));
  console.log(results.join('\n'));

  if (results.some((line) => line.includes('unavailable') || line.includes('missing') || line.includes('requires ') || line.includes('points to') || line.includes('cannot resolve'))) {
    process.exitCode = 1;
  }
}

async function update(options, paths) {
  const repositoryDir = await resolveRepositoryDir(options, paths);
  await requireRepository(repositoryDir);
  const status = git(repositoryDir, ['status', '--porcelain']);
  if (status === null) throw new Error('Could not inspect the repository status.');
  if (status.trim()) throw new Error(`Refusing to update a dirty repository: ${repositoryDir}`);
  run('git', ['pull', '--ff-only'], { dryRun: options['dry-run'], cwd: repositoryDir });
  await install(repositoryDir, paths, options);
}

export async function main(argv, env = process.env) {
  const { command, options } = parseArgs(argv);
  if (!command || options.help || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  requireNodeVersion();
  const paths = getPaths(env);
  switch (command) {
    case 'init':
      return init(options, paths);
    case 'install':
      return install(await resolveRepositoryDir(options, paths), paths, options);
    case 'doctor':
      return doctor(options, paths);
    case 'update':
      return update(options, paths);
    case 'sync':
      return sync(await resolveRepositoryDir(options, paths), { pullOnly: options['pull-only'], dryRun: options['dry-run'] });
    case 'save':
      return save({ all: options.all, commit: options.commit, cwd: options.cwd });
    case 'read':
      return read({
        list: options.list,
        import: options.import,
        ids: options.ids,
        targets: options.targets ?? 'cli',
        author: options.author,
        cwd: options.cwd,
        projectsDir: options['projects-dir'],
        desktopSessionsDir: options['desktop-sessions-dir'],
      });
    case 'repo-status':
      return repoStatus({ repo: options.repo });
    case 'build-status':
      return buildStatus({ repo: options.repo, days: options.days ? Number.parseInt(options.days, 10) : 0 });
    default:
      throw new Error(`Unknown command: ${command}.\n\n${HELP}`);
  }
}
