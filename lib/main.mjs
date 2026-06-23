import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, HELP } from './args.mjs';
import { getPaths } from './paths.mjs';

const MIN_NODE_MAJOR = 20;

function run(command, args, { dryRun = false, cwd } = {}) {
  const rendered = [command, ...args].map((part) => JSON.stringify(part)).join(' ');
  console.log(`$ ${rendered}`);
  if (dryRun) return;

  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

function requireNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required; found ${process.versions.node}.`);
  }
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0];
}

async function requireRepository(repositoryDir) {
  const required = [
    '.git',
    'skills/session-memory/SKILL.md',
    'scripts/install-mac.sh',
    'scripts/install-windows.ps1',
  ];
  const missing = required.filter((entry) => !existsSync(path.join(repositoryDir, entry)));
  if (missing.length > 0) {
    throw new Error(`${repositoryDir} is not a supported session-memory repository; missing ${missing.join(', ')}.`);
  }
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
  throw new Error('No repository location is configured. Pass --repo-dir <path> or run init --repo-url <git-url>.');
}

function installerCommand(repositoryDir) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repositoryDir, 'scripts', 'install-windows.ps1')],
    };
  }
  return { command: 'bash', args: [path.join(repositoryDir, 'scripts', 'install-mac.sh')] };
}

async function install(repositoryDir, paths, options) {
  await requireRepository(repositoryDir);
  const { command, args } = installerCommand(repositoryDir);
  run(command, args, { dryRun: options['dry-run'], cwd: repositoryDir });
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

  if (options['dry-run']) {
    const { command, args } = installerCommand(repositoryDir);
    run(command, args, { dryRun: true, cwd: repositoryDir });
    await writeState(paths, repositoryDir, { dryRun: true });
    return;
  }

  try {
    await install(repositoryDir, paths, options);
  } catch (error) {
    if (!options['dry-run']) {
      console.error(`Installation failed. The clone remains at ${repositoryDir} for inspection.`);
    }
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
  const results = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  results.push(`Node.js: ${process.versions.node}${nodeMajor >= MIN_NODE_MAJOR ? ' (ok)' : ` (requires ${MIN_NODE_MAJOR}+)`}`);

  const gitVersion = commandVersion('git');
  results.push(gitVersion ? `Git: ${gitVersion} (ok)` : 'Git: unavailable');
  if (process.platform === 'win32') {
    const powerShellVersion = commandVersion('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    results.push(powerShellVersion ? `PowerShell: ${powerShellVersion} (ok)` : 'PowerShell: unavailable');
  } else {
    const bashVersion = commandVersion('bash');
    const jqVersion = commandVersion('jq');
    results.push(bashVersion ? `Bash: ${bashVersion} (ok)` : 'Bash: unavailable');
    results.push(jqVersion ? `jq: ${jqVersion} (ok)` : 'jq: unavailable (required to merge Claude settings and hooks)');
  }
  results.push(existsSync(repositoryDir) ? `Repository: ${repositoryDir} (present)` : `Repository: missing (${repositoryDir})`);

  try {
    await requireRepository(repositoryDir);
    results.push('Repository layout: ok');
  } catch (error) {
    results.push(`Repository layout: ${error.message}`);
  }

  const skill = path.join(repositoryDir, 'skills', 'session-memory');
  results.push(await targetStatus('Claude skill', path.join(paths.claudeDir, 'skills', 'session-memory'), skill));
  results.push(await targetStatus('Codex skill', path.join(paths.codexSkillsDir, 'session-memory'), skill));
  console.log(results.join('\n'));

  if (results.some((line) => line.includes('unavailable') || line.includes('missing') || line.includes('requires ') || line.includes('points to') || line.includes('cannot resolve'))) {
    process.exitCode = 1;
  }
}

async function update(options, paths) {
  const repositoryDir = await resolveRepositoryDir(options, paths);
  await requireRepository(repositoryDir);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repositoryDir, encoding: 'utf8' });
  if (status.status !== 0) throw new Error('Could not inspect the repository status.');
  if (status.stdout.trim()) throw new Error(`Refusing to update a dirty repository: ${repositoryDir}`);
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
    case 'init': return init(options, paths);
    case 'install': return install(await resolveRepositoryDir(options, paths), paths, options);
    case 'doctor': return doctor(options, paths);
    case 'update': return update(options, paths);
    default: throw new Error(`Unknown command: ${command}.\n\n${HELP}`);
  }
}
