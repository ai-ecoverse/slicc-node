import { rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PROXY_PORT = 17117;

export function configDir({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'slicc-node');
  if (platform === 'win32')
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'slicc-node');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'slicc-node');
  return join(home, '.config', 'slicc-node');
}

export async function forgetStoredKey({ dir = configDir() } = {}) {
  await rm(join(dir, 'key'), { force: true });
  await rmdir(dir).catch(() => {});
}
