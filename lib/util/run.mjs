import { spawnSync } from 'node:child_process';

// Echo and run a command, inheriting stdio. Throws on failure unless dryRun.
export function run(command, args, { dryRun = false, cwd } = {}) {
  const rendered = [command, ...args].map((part) => JSON.stringify(part)).join(' ');
  console.log(`$ ${rendered}`);
  if (dryRun) return;

  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

export function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0];
}
