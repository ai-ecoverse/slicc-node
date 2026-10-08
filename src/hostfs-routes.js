import { constants, createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  attrOf,
  errnoOf,
  errnoStatus,
  etagOf,
  HostfsError,
  MAX_IO,
  MAX_OP_BODY,
  openFile,
  pathOp,
  probeCase,
  resolvePath,
  WRITING_OPS,
  wantsWrite,
  writeAll,
} from './hostfs.js';
import { addHandle, createGrants, createLock } from './hostfs-grants.js';
import { createWatchers } from './hostfs-watch.js';
import { fail, readJson } from './http.js';
import {
  HOSTFS_ERRNO_HEADER,
  HOSTFS_GRANT_PATH,
  HOSTFS_MOUNTS_PATH,
  HOSTFS_PATH,
  HOSTFS_REQUEST_HEADER,
  HOSTFS_TOKEN_HEADER,
  HOSTFS_WATCH_PATH,
  HOSTFS_WRITE_PATH,
} from './protocol.js';

export const PING_INTERVAL = 15 * 1000;
const STREAM_BACKLOG = 1024 * 1024;
const TOKEN = HOSTFS_TOKEN_HEADER.toLowerCase();
const REQUEST = HOSTFS_REQUEST_HEADER.toLowerCase();
const NAME = /^[^/\\\0]+$/;

export const HOSTFS_KEY_PATHS = {
  [HOSTFS_GRANT_PATH]: ['POST', 'DELETE'],
  [HOSTFS_MOUNTS_PATH]: ['POST'],
};

export const HOSTFS_TOKEN_PATHS = {
  [HOSTFS_PATH]: ['POST'],
  [HOSTFS_WRITE_PATH]: ['PUT'],
  [HOSTFS_WATCH_PATH]: ['POST'],
};

export function parseMount(spec) {
  let rest = spec;
  let readonly = false;
  if (rest.endsWith(':ro')) {
    readonly = true;
    rest = rest.slice(0, -3);
  }
  let name = null;
  const at = rest.lastIndexOf(':');
  if (at > 0) {
    const tail = rest.slice(at + 1);
    if (tail !== '' && !/[\\/]/.test(tail)) {
      name = tail;
      rest = rest.slice(0, at);
    }
  }
  return { path: rest, name, readonly };
}

export async function loadFolders(specs, warn = () => {}) {
  const folders = [];
  for (const spec of specs) {
    const { path, name, readonly } = parseMount(spec);
    let root;
    try {
      root = await realpath(path);
      if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    } catch {
      warn(`--mount ${spec}: not an existing folder, skipping`);
      continue;
    }
    const folderName = name ?? basename(root);
    if (!NAME.test(folderName) || folderName === '.' || folderName === '..') {
      warn(`--mount ${spec}: invalid name, skipping`);
      continue;
    }
    if (folders.some((folder) => folder.name === folderName)) {
      warn(`--mount ${spec}: the name ${folderName} is taken, skipping`);
      continue;
    }
    folders.push({
      name: folderName,
      root,
      readonly,
      capabilities: {
        maxIo: MAX_IO,
        symlinks: process.platform !== 'win32',
        chmod: process.platform !== 'win32',
        caseInsensitive: await probeCase(root),
        normalization: process.platform === 'darwin' ? 'nfd-insensitive' : 'none',
      },
    });
  }
  return folders;
}

function json(res, status, cors, body) {
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function fsFail(res, cors, err) {
  const { errno, message } = errnoOf(err);
  res.writeHead(errnoStatus(errno), {
    ...cors,
    [HOSTFS_ERRNO_HEADER]: errno,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ errno, message }));
}

const isOffset = (value) => Number.isSafeInteger(value) && value >= 0;

function handleOf(grant, fh) {
  const entry = grant.handles.get(fh);
  if (!entry) throw new HostfsError('EBADF');
  return entry;
}

async function pinned(grant, entry) {
  if (entry.file) return { file: entry.file, owned: false };
  const target = await resolvePath(grant.folder.root, entry.path);
  const file = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return { file, owned: true };
}

async function release(grant, fh) {
  const entry = handleOf(grant, fh);
  grant.handles.delete(fh);
  if (!entry.file) return {};
  try {
    return { attr: attrOf(await entry.file.stat({ bigint: true })) };
  } finally {
    await entry.file.close();
  }
}

async function read(lock, grant, body, res, cors) {
  const { fh, offset, size, ifMatch } = body;
  if (!isOffset(offset) || !isOffset(size) || size > MAX_IO) throw new HostfsError('EINVAL');
  const entry = handleOf(grant, fh);
  const { file, owned } = await lock.shared(() => pinned(grant, entry));
  try {
    const stats = await file.stat({ bigint: true });
    const etag = etagOf(stats);
    if (!entry.file && ifMatch !== undefined && ifMatch !== etag) throw new HostfsError('ESTALE');
    const total = Number(stats.size);
    const end = Math.min(offset + size, total);
    const length = Math.max(0, end - offset);
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'Cache-Control': 'no-store',
      ETag: etag,
      'Content-Range': length > 0 ? `bytes ${offset}-${end - 1}/${total}` : `bytes */${total}`,
    });
    if (length === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(null, {
      fd: file,
      start: offset,
      end: end - 1,
      autoClose: false,
    });
    await pipeline(stream, res).catch(() => res.destroy());
  } finally {
    if (owned) await file.close();
  }
}

async function write(grant, req, res, cors) {
  if (grant.readonly) throw new HostfsError('EROFS');
  let head;
  try {
    head = JSON.parse(String(req.headers[REQUEST]));
  } catch {
    head = null;
  }
  if (!head || !isOffset(head.offset)) throw new HostfsError('EINVAL');
  const entry = handleOf(grant, head.fh);
  if (!entry.file) throw new HostfsError('EBADF');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_IO) throw new HostfsError('EINVAL');
  let position = head.offset;
  for await (const chunk of req) {
    if (position + chunk.byteLength - head.offset > MAX_IO) throw new HostfsError('EINVAL');
    await writeAll(entry.file, chunk, position);
    position += chunk.byteLength;
  }
  json(res, 200, cors, {});
}

function watch({ grants, watchers }, found, res, cors) {
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();
  const cleanups = [];
  const end = () => res.end();
  const line = (value) => {
    if (res.writableEnded) return;
    if (res.writableLength > STREAM_BACKLOG) res.destroy();
    else res.write(`${JSON.stringify(value)}\n`);
  };
  for (const grant of found) cleanups.push(grants.stream(grant, end));
  const roots = new Map(found.map((grant) => [grant.folder.root, grant.folder.name]));
  for (const [root, mount] of roots)
    cleanups.push(watchers.subscribe(root, (event) => line({ mount, ...event })));
  const ping = setInterval(() => line({ ping: 1 }), PING_INTERVAL);
  ping.unref();
  res.once('close', () => {
    clearInterval(ping);
    for (const cleanup of cleanups) cleanup();
  });
}

export function createHostfs({
  folders = [],
  idle,
  maxHandles,
  log = () => {},
  watchers = createWatchers(),
} = {}) {
  const grants = createGrants({ idle, maxHandles });
  const lock = createLock();
  const byName = new Map(folders.map((folder) => [folder.name, folder]));

  async function grant(req, res, cors) {
    const body = await readJson(req, 4096);
    if (req.method === 'DELETE') {
      if (grants.revoke(body?.token)) log('hostfs revoke');
      res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const folder = byName.get(body?.mount);
    if (!folder) throw new HostfsError('ENOENT', 'no such folder');
    if (body.readonly !== undefined && typeof body.readonly !== 'boolean')
      throw new HostfsError('EINVAL');
    const minted = grants.grant(folder, body.readonly === true, req.headers.origin);
    log(`hostfs grant ${folder.name} ${minted.grant.readonly ? 'ro' : 'rw'}`);
    json(res, 200, cors, {
      token: minted.token,
      mount: folder.name,
      readonly: minted.grant.readonly,
      capabilities: folder.capabilities,
    });
  }

  async function openOp(grant, body) {
    const writing = wantsWrite(body);
    const opened = await (writing ? lock.exclusive : lock.shared)(() =>
      openFile(grant.folder.root, body)
    );
    const entry = writing
      ? { file: opened.handle, path: body.path }
      : { path: body.path ?? '', etag: etagOf(opened.stats) };
    if (!writing) await opened.handle.close();
    const fh = addHandle(grant, entry);
    if (fh === null) {
      if (writing) await opened.handle.close();
      throw new HostfsError('EMFILE', 'too many open files');
    }
    if (writing) log(`hostfs open ${grant.folder.name}/${body.path}`);
    return { fh, attr: attrOf(opened.stats) };
  }

  async function operate(grant, req, res, cors) {
    const body = await readJson(req, MAX_OP_BODY);
    if (!body || typeof body.op !== 'string') throw new HostfsError('EINVAL');
    const writes = WRITING_OPS.has(body.op) || (body.op === 'open' && wantsWrite(body));
    if (writes && grant.readonly) throw new HostfsError('EROFS');
    if (body.op === 'read') return read(lock, grant, body, res, cors);
    let answer;
    if (body.op === 'open') answer = await openOp(grant, body);
    else if (body.op === 'release') answer = await release(grant, body.fh);
    else {
      answer = await (writes ? lock.exclusive : lock.shared)(() => pathOp(grant.folder.root, body));
      if (writes) log(`hostfs ${body.op} ${grant.folder.name}/${body.path ?? body.from ?? ''}`);
    }
    json(res, 200, cors, answer);
  }

  function tokens(req) {
    const header = req.headers[TOKEN];
    if (typeof header !== 'string') return [];
    return header
      .split(',')
      .map((token) => token.trim())
      .map((token) => grants.find(token, req.headers.origin));
  }

  const mounts = () => folders.map(({ name, readonly }) => ({ name, readonly }));

  return {
    mounts,
    handle(req, res, path, cors) {
      const reply = (promise) =>
        promise.catch((err) => {
          if (res.headersSent) res.destroy();
          else fsFail(res, cors, err);
        });
      if (path === HOSTFS_GRANT_PATH) return reply(grant(req, res, cors));
      if (path === HOSTFS_MOUNTS_PATH) return json(res, 200, cors, mounts());
      const found = tokens(req);
      if (
        found.length === 0 ||
        found.includes(null) ||
        (path !== HOSTFS_WATCH_PATH && found.length > 1)
      ) {
        req.resume();
        return fail(res, 403, 'hostfs token missing, unknown or revoked', cors);
      }
      if (path === HOSTFS_WATCH_PATH) return watch({ grants, watchers }, found, res, cors);
      if (path === HOSTFS_WRITE_PATH) {
        return reply(
          write(found[0], req, res, cors).catch((err) => {
            req.resume();
            throw err;
          })
        );
      }
      return reply(operate(found[0], req, res, cors));
    },
    close() {
      grants.clear();
      watchers.close();
    },
  };
}
