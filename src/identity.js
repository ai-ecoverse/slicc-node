import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mintKey } from './security.js';

export const DEFAULT_PROXY_PORT = 17117;

const KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;

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

async function readKey(file, warn, platform) {
  const key = (await readFile(file, 'utf8')).trim();
  if (!KEY_FORMAT.test(key)) {
    warn(`${file} does not hold a proxy key; minting a new one`);
    return null;
  }
  if (platform !== 'win32' && ((await stat(file)).mode & 0o077) !== 0) {
    await chmod(file, 0o600);
    warn(`${file} was readable by others; it is 0600 now`);
  }
  return key;
}

async function staged(file) {
  const key = mintKey();
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${key}\n`, { mode: 0o600, flag: 'wx' });
  return { key, temporary };
}

async function createKey(file) {
  const { key, temporary } = await staged(file);
  try {
    await link(temporary, file);
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return null;
  } finally {
    await unlink(temporary);
  }
}

async function replaceKey(file) {
  const { key, temporary } = await staged(file);
  await rename(temporary, file);
  return key;
}

async function keepPrivate(dir, warn, platform) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32' || ((await stat(dir)).mode & 0o077) === 0) return;
  await chmod(dir, 0o700);
  warn(`${dir} was open to others; it is 0700 now`);
}

export async function persistentKey({
  dir = configDir(),
  rotate = false,
  warn = () => {},
  platform = process.platform,
} = {}) {
  await keepPrivate(dir, warn, platform);
  const file = join(dir, 'key');
  if (rotate) return replaceKey(file);
  const created = await createKey(file);
  if (created) return created;
  return (await readKey(file, warn, platform)) ?? replaceKey(file);
}
