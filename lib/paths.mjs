import os from 'node:os';
import path from 'node:path';

export function getPaths(env = process.env, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const home = env.HOME || env.USERPROFILE || os.homedir();

  if (platform === 'win32') {
    const dataDir = env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
    const configDir = env.APPDATA || pathApi.join(home, 'AppData', 'Roaming');
    return {
      home,
      repositoryDir: pathApi.join(dataDir, 'session-memory'),
      configFile: pathApi.join(configDir, 'session-memory', 'config.json'),
      claudeDir: pathApi.join(home, '.claude'),
      codexSkillsDir: pathApi.join(home, '.agents', 'skills'),
    };
  }

  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    home,
    repositoryDir: path.join(dataHome, 'session-memory'),
    configFile: path.join(configHome, 'session-memory', 'config.json'),
    claudeDir: path.join(home, '.claude'),
    codexSkillsDir: path.join(home, '.agents', 'skills'),
  };
}
