import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  statfs,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { getSystemErrorMessage } from 'node:util';

export const MAX_IO = 16 * 1024 * 1024;
export const MAX_OP_BODY = 1024 * 1024;

const STATUS = {
  ENOENT: 404,
  EACCES: 403,
  EPERM: 403,
  EROFS: 403,
  EEXIST: 409,
  ENOTEMPTY: 409,
  EISDIR: 409,
  ENOTDIR: 409,
  EBUSY: 409,
  ESTALE: 409,
  EINVAL: 400,
  ENAMETOOLONG: 400,
  ELOOP: 400,
  EBADF: 410,
  ENOSPC: 507,
  EFBIG: 507,
};
const ERRNO = /^E[A-Z0-9]+$/;
const OPEN_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;

const MESSAGES = {
  EACCES: 'path escapes the folder',
  EBADF: 'bad file handle',
  EBUSY: 'the folder root cannot be moved or removed',
  EINVAL: 'invalid argument',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EROFS: 'read-only folder',
  ESTALE: 'file changed since it was opened',
};

export class HostfsError extends Error {
  constructor(code, message = MESSAGES[code] ?? 'input/output error') {
    super(message);
    this.code = code;
  }
}

export function errnoOf(err) {
  if (err instanceof HostfsError) return { errno: err.code, message: err.message };
  const code = typeof err?.code === 'string' && ERRNO.test(err.code) ? err.code : 'EIO';
  const message = Number.isInteger(err?.errno)
    ? getSystemErrorMessage(err.errno)
    : 'input/output error';
  return { errno: code, message };
}

export function errnoStatus(errno) {
  return STATUS[errno] ?? 500;
}

function within(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function segments(rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HostfsError('EINVAL');
  if (rel.startsWith('/')) throw new HostfsError('EACCES', 'absolute path');
  if (process.platform === 'win32' && /[\\:]/.test(rel)) throw new HostfsError('EACCES');
  const parts = rel.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new HostfsError('EACCES');
  return parts;
}

export async function resolvePath(root, rel) {
  const parts = segments(rel);
  if (parts.length === 0) return { path: root, root: true };
  const parent = await realpath(join(root, ...parts.slice(0, -1)));
  if (!within(root, parent)) throw new HostfsError('EACCES');
  return { path: join(parent, parts.at(-1)), root: false };
}

export function etagOf(stats) {
  return `"${stats.size}-${stats.mtimeNs}-${stats.ino}"`;
}

export function attrOf(stats) {
  let kind = 'file';
  if (stats.isDirectory()) kind = 'directory';
  else if (stats.isSymbolicLink()) kind = 'symlink';
  return {
    kind,
    size: Number(stats.size),
    mtime: Number(stats.mtimeNs) / 1e6,
    mode: Number(stats.mode) & 0o7777,
    ino: Number(stats.ino),
    etag: etagOf(stats),
  };
}

const look = (path) => lstat(path, { bigint: true });

async function list(path) {
  const own = await look(path);
  if (!own.isDirectory()) throw new HostfsError('ENOTDIR');
  const names = await readdir(path);
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, attr: attrOf(await look(join(path, name))) };
      } catch {
        return null;
      }
    })
  );
  return { entries: entries.filter(Boolean) };
}

async function removeFile(target) {
  if (target.root) throw new HostfsError('EBUSY');
  if ((await look(target.path)).isDirectory()) throw new HostfsError('EISDIR');
  await unlink(target.path);
  return {};
}

async function removeDirectory(target) {
  if (target.root) throw new HostfsError('EBUSY');
  await rmdir(target.path);
  return {};
}

async function move(from, to) {
  if (from.root || to.root) throw new HostfsError('EBUSY');
  try {
    await rename(from.path, to.path);
  } catch (err) {
    if (err.code === 'EEXIST') throw new HostfsError('ENOTEMPTY');
    throw err;
  }
  return {};
}

function validMode(mode) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;
}

async function setattr(path, { mode, mtime }) {
  if (mode !== undefined && !validMode(mode)) throw new HostfsError('EINVAL');
  if (mtime !== undefined && !Number.isFinite(mtime)) throw new HostfsError('EINVAL');
  const stats = await look(path);
  if (mode !== undefined) {
    if (stats.isSymbolicLink()) throw new HostfsError('EINVAL', 'cannot chmod a symlink');
    await chmod(path, mode);
  }
  if (mtime !== undefined) await lutimes(path, Number(stats.atimeMs) / 1000, mtime / 1000);
  return {};
}

export const WRITING_OPS = new Set(['mkdir', 'rmdir', 'unlink', 'rename', 'symlink', 'setattr']);

export async function pathOp(root, body) {
  const target = () => resolvePath(root, body.path ?? '');
  switch (body.op) {
    case 'stat':
      return attrOf(await look((await target()).path));
    case 'list':
      return list((await target()).path);
    case 'mkdir':
      await mkdir((await target()).path);
      return {};
    case 'rmdir':
      return removeDirectory(await target());
    case 'unlink':
      return removeFile(await target());
    case 'rename':
      return move(await resolvePath(root, body.from), await resolvePath(root, body.to));
    case 'symlink':
      if (typeof body.target !== 'string' || body.target.includes('\0'))
        throw new HostfsError('EINVAL');
      await symlink(body.target, (await target()).path);
      return {};
    case 'readlink':
      return { target: await readlink((await target()).path) };
    case 'setattr':
      return setattr((await target()).path, body);
    case 'statfs': {
      const { bsize, blocks, bfree, bavail } = await statfs(root);
      return { bsize, blocks, bfree, bavail };
    }
    default:
      throw new HostfsError('EINVAL', 'unknown op');
  }
}

export function wantsWrite(body) {
  return Boolean(body.write || body.create || body.truncate || body.exclusive);
}

export async function openFile(root, body) {
  const target = await resolvePath(root, body.path ?? '');
  if (target.root) throw new HostfsError('EISDIR');
  const writing = wantsWrite(body);
  if (body.mode !== undefined && !validMode(body.mode)) throw new HostfsError('EINVAL');
  let flags = OPEN_FLAGS | (writing ? constants.O_RDWR : constants.O_RDONLY);
  if (body.create) flags |= constants.O_CREAT;
  if (body.create && body.exclusive) flags |= constants.O_EXCL;
  if (body.truncate) flags |= constants.O_TRUNC;
  const handle = await open(target.path, flags, body.mode ?? 0o666);
  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.isDirectory()) throw new HostfsError('EISDIR');
    if (!stats.isFile()) throw new HostfsError('EINVAL', 'not a regular file');
    return { handle, stats };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export async function writeAll(handle, chunk, position) {
  let done = 0;
  while (done < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      done,
      chunk.byteLength - done,
      position + done
    );
    done += bytesWritten;
  }
}

export async function probeCase(root) {
  const parts = root.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const name = parts[i];
    const swapped = [...name]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    if (swapped === name) continue;
    const other = [...parts.slice(0, i), swapped, ...parts.slice(i + 1)].join(sep);
    try {
      const [a, b] = await Promise.all([look(root), look(other)]);
      return a.ino === b.ino && a.dev === b.dev;
    } catch {
      return false;
    }
  }
  return process.platform === 'darwin' || process.platform === 'win32';
}
