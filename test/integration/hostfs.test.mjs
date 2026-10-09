import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startProxy } from '../../src/index.js';
import { hop, slicc } from './proxy.mjs';

const seven = 'https://seven.sliccy.ai';
let base;
let folder;
let outside;
let proxy;

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slicc-hostfs-')));
  folder = join(base, 'project');
  outside = join(base, 'secret');
  await mkdir(folder);
  await mkdir(outside);
  await mkdir(join(base, 'docs'));
  await writeFile(join(outside, 'key.txt'), 'top secret');
  await writeFile(join(folder, 'hello.txt'), 'hello');
  await symlink(outside, join(folder, 'escape'));
  await symlink(join(outside, 'key.txt'), join(folder, 'key-link'));
  await symlink('hello.txt', join(folder, 'inner-link'));
  proxy = await startProxy({
    mounts: [folder, `${join(base, 'docs')}:docs:ro`, join(base, 'missing')],
    hostfsIdle: 400,
    kernelPort: null,
  });
});

after(async () => {
  await proxy.close();
  await rm(base, { recursive: true, force: true });
});

const keyed = (path, body, headers = {}) =>
  hop(proxy, {
    path,
    method: headers.method ?? 'POST',
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key, ...headers },
    body: JSON.stringify(body),
  });

async function grant(mount, readonly, origin = seven) {
  const res = await keyed('/api/hostfs/grant', { mount, readonly }, { Origin: origin });
  assert.equal(res.status, 200, res.body.toString());
  return JSON.parse(res.body);
}

function op(token, body, headers = {}) {
  return hop(proxy, {
    path: '/api/hostfs',
    headers: { Origin: seven, 'X-Hostfs-Token': token, ...headers },
    body: JSON.stringify(body),
  });
}

async function ok(token, body) {
  const res = await op(token, body);
  assert.equal(res.status, 200, `${body.op} ${res.body}`);
  return res.headers['content-type'] === 'application/json' ? JSON.parse(res.body) : res;
}

async function errno(token, body, expected, status) {
  const res = await op(token, body);
  assert.equal(res.headers['x-hostfs-errno'], expected, `${JSON.stringify(body)} ${res.body}`);
  if (status) assert.equal(res.status, status);
  assert.equal(JSON.parse(res.body).errno, expected);
  assert.ok(!res.body.toString().includes(base), 'no host paths in errors');
  return res;
}

const put = (token, fh, offset, body) =>
  hop(proxy, {
    method: 'PUT',
    path: '/api/hostfs/write',
    headers: {
      Origin: seven,
      'X-Hostfs-Token': token,
      'X-Hostfs-Request': JSON.stringify({ fh, offset }),
    },
    body,
  });

test('the probe announces hostfs, and mounts lists names without host paths', async () => {
  const probe = await hop(proxy, {
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key, 'X-Slicc-Raw-Probe': '1' },
  });
  assert.equal(JSON.parse(probe.body).hostfs, 1);
  const mounts = await keyed('/api/hostfs/mounts', {});
  assert.deepEqual(JSON.parse(mounts.body), [
    { name: 'project', readonly: false },
    { name: 'docs', readonly: true },
  ]);
  assert.ok(!mounts.body.toString().includes(base));
  const preflight = await hop(proxy, {
    method: 'OPTIONS',
    path: '/api/hostfs/write',
    headers: { Origin: seven, 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-methods'], /PUT/);
  assert.match(
    preflight.headers['access-control-allow-headers'],
    /X-Hostfs-Token, X-Hostfs-Request/
  );
  assert.match(
    preflight.headers['access-control-expose-headers'],
    /X-Hostfs-Errno, ETag, Content-Range/
  );
});

test('a grant needs the key and an allowed origin, and names an exported folder', async () => {
  const granted = await grant('project');
  assert.match(granted.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(granted.readonly, false);
  assert.equal(granted.capabilities.maxIo, 16 * 1024 * 1024);
  assert.equal(typeof granted.capabilities.caseInsensitive, 'boolean');
  assert.equal(granted.capabilities.ranges, true);
  const noKey = await keyed('/api/hostfs/grant', { mount: 'project' }, { 'X-Bridge-Token': 'x' });
  assert.equal(noKey.status, 403);
  assert.equal(noKey.headers['x-proxy-error'], '1');
  const evil = await keyed(
    '/api/hostfs/grant',
    { mount: 'project' },
    { Origin: 'https://evil.test' }
  );
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const unknown = await keyed('/api/hostfs/grant', { mount: 'missing' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers['x-hostfs-errno'], 'ENOENT');
  assert.equal((await grant('docs')).readonly, true);
});

test('a missing, unknown, revoked or foreign-origin token is a gate refusal', async () => {
  const { token } = await grant('project');
  const missing = await hop(proxy, {
    path: '/api/hostfs',
    headers: { Origin: seven },
    body: JSON.stringify({ op: 'stat', path: '' }),
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.headers['x-proxy-error'], '1');
  assert.equal((await op('x'.repeat(43), { op: 'stat', path: '' })).status, 403);
  const branch = await op(token, { op: 'stat', path: '' }, { Origin: 'https://branch.sliccy.ai' });
  assert.equal(branch.status, 403);
  assert.equal(branch.headers['x-proxy-error'], '1');
  const evil = await op(token, { op: 'stat', path: '' }, { Origin: 'https://evil.test' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const query = await hop(proxy, {
    path: `/api/hostfs?token=${token}`,
    headers: { Origin: seven },
    body: JSON.stringify({ op: 'stat', path: '' }),
  });
  assert.equal(query.status, 403);
  await ok(token, { op: 'stat', path: '' });
  const revoked = await keyed('/api/hostfs/grant', { token }, { method: 'DELETE' });
  assert.equal(revoked.status, 204);
  const after = await op(token, { op: 'stat', path: '' });
  assert.equal(after.status, 403);
  assert.equal(after.headers['x-proxy-error'], '1');
});

test('an idle token expires and closes its handles, but a watch stream keeps it alive', async () => {
  const idle = await grant('project');
  const { fh } = await ok(idle.token, { op: 'open', path: 'idle.txt', create: true, write: true });
  await sleep(700);
  assert.equal((await op(idle.token, { op: 'release', fh })).status, 403);
  const watched = await grant('project');
  const stream = await watch([watched.token]);
  await sleep(700);
  await ok(watched.token, { op: 'stat', path: '' });
  stream.close();
});

test('paths cannot leave the folder by .., absolute paths or symlinks', async () => {
  const { token } = await grant('project');
  for (const path of ['..', '../secret/key.txt', 'a/../../secret', '/etc/passwd', '/'])
    await errno(token, { op: 'stat', path }, 'EACCES', 403);
  await errno(token, { op: 'stat', path: 'escape/key.txt' }, 'EACCES', 403);
  await errno(token, { op: 'list', path: 'escape' }, 'ENOTDIR');
  await errno(token, { op: 'open', path: 'escape/key.txt' }, 'EACCES');
  await errno(token, { op: 'open', path: 'key-link' }, 'ELOOP', 400);
  await errno(token, { op: 'open', path: 'key-link', write: true, truncate: true }, 'ELOOP');
  await errno(token, { op: 'mkdir', path: 'escape/new' }, 'EACCES');
  await errno(token, { op: 'rename', from: 'hello.txt', to: '../stolen.txt' }, 'EACCES');
  await errno(token, { op: 'rename', from: 'escape/key.txt', to: 'mine.txt' }, 'EACCES');
  await ok(token, { op: 'symlink', target: '/', path: 'root-link' });
  await errno(token, { op: 'list', path: 'root-link/etc' }, 'EACCES');
  await errno(token, { op: 'setattr', path: 'key-link', mode: 0o777 }, 'EINVAL');
  await errno(token, { op: 'setattr', path: 'key-link', size: 0 }, 'EINVAL');
  assert.deepEqual(await ok(token, { op: 'readlink', path: 'inner-link' }), {
    target: 'hello.txt',
  });
  const link = await ok(token, { op: 'stat', path: 'inner-link' });
  assert.equal(link.kind, 'symlink');
  assert.equal(await readFile(join(outside, 'key.txt'), 'utf8'), 'top secret');
});

test('a read-only token cannot write, rename or remove', async () => {
  const { token } = await grant('project', true);
  await ok(token, { op: 'stat', path: 'hello.txt' });
  for (const body of [
    { op: 'mkdir', path: 'x' },
    { op: 'rmdir', path: 'x' },
    { op: 'unlink', path: 'hello.txt' },
    { op: 'rename', from: 'hello.txt', to: 'bye.txt' },
    { op: 'symlink', target: 'hello.txt', path: 'l' },
    { op: 'setattr', path: 'hello.txt', mode: 0o600 },
    { op: 'setattr', path: 'hello.txt', size: 0 },
    { op: 'open', path: 'hello.txt', write: true },
    { op: 'open', path: 'new.txt', create: true },
    { op: 'open', path: 'hello.txt', truncate: true },
  ])
    await errno(token, body, 'EROFS', 403);
  const { fh } = await ok(token, { op: 'open', path: 'hello.txt' });
  const res = await put(token, fh, 0, 'x');
  assert.equal(res.status, 403);
  assert.equal(res.headers['x-hostfs-errno'], 'EROFS');
  assert.equal(await readFile(join(folder, 'hello.txt'), 'utf8'), 'hello');
  const docs = await grant('docs', false);
  await errno(docs.token, { op: 'mkdir', path: 'x' }, 'EROFS');
  await errno(docs.token, { op: 'setattr', path: 'x', size: 0 }, 'EROFS');
});

test('setattr with size truncates and extends with zeros, like truncate(2)', async () => {
  const { token } = await grant('project');
  await writeFile(join(folder, 'sized.txt'), 'hello, world');
  await ok(token, { op: 'setattr', path: 'sized.txt', size: 5 });
  assert.equal(await readFile(join(folder, 'sized.txt'), 'utf8'), 'hello');
  await ok(token, { op: 'setattr', path: 'sized.txt', size: 9 });
  assert.deepEqual(
    await readFile(join(folder, 'sized.txt')),
    Buffer.concat([Buffer.from('hello'), Buffer.alloc(4)])
  );
  assert.equal((await ok(token, { op: 'stat', path: 'sized.txt' })).size, 9);
  await ok(token, { op: 'setattr', path: 'sized.txt', size: 0, mtime: 1_000_000_000_000 });
  const attr = await ok(token, { op: 'stat', path: 'sized.txt' });
  assert.equal(attr.size, 0);
  assert.equal(attr.mtime, 1_000_000_000_000);
  const { fh } = await ok(token, { op: 'open', path: 'sized.txt', write: true });
  await ok(token, { op: 'setattr', path: 'sized.txt', size: 3 });
  assert.equal((await put(token, fh, 3, 'abc')).status, 200);
  assert.deepEqual((await ok(token, { op: 'release', fh })).attr.size, 6);
  assert.deepEqual(await readFile(join(folder, 'sized.txt')), Buffer.from('\0\0\0abc'));
  await ok(token, { op: 'mkdir', path: 'sized-dir' });
  await errno(token, { op: 'setattr', path: 'sized-dir', size: 0 }, 'EISDIR', 409);
  await errno(token, { op: 'setattr', path: '', size: 0 }, 'EISDIR', 409);
  await errno(token, { op: 'setattr', path: 'gone.txt', size: 0 }, 'ENOENT', 404);
  for (const size of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1])
    await errno(token, { op: 'setattr', path: 'sized.txt', size }, 'EINVAL', 400);
  assert.equal((await ok(token, { op: 'stat', path: 'sized.txt' })).size, 6);
});

test('metadata operations answer with POSIX errnos', async () => {
  const { token } = await grant('project');
  await ok(token, { op: 'mkdir', path: 'dir' });
  await errno(token, { op: 'mkdir', path: 'dir' }, 'EEXIST', 409);
  await errno(token, { op: 'mkdir', path: 'no/such/dir' }, 'ENOENT', 404);
  await ok(token, { op: 'mkdir', path: 'dir/sub' });
  await errno(token, { op: 'rmdir', path: 'dir' }, 'ENOTEMPTY', 409);
  await errno(token, { op: 'unlink', path: 'dir' }, 'EISDIR', 409);
  await errno(token, { op: 'rmdir', path: 'hello.txt' }, 'ENOTDIR', 409);
  await errno(token, { op: 'unlink', path: '' }, 'EBUSY', 409);
  await errno(token, { op: 'rename', from: '', to: 'x' }, 'EBUSY', 409);
  await errno(token, { op: 'read', fh: 9999, offset: 0, size: 1 }, 'EBADF', 410);
  await errno(token, { op: 'nope' }, 'EINVAL', 400);
  await ok(token, { op: 'mkdir', path: 'full' });
  await ok(token, { op: 'mkdir', path: 'full/x' });
  await errno(token, { op: 'rename', from: 'dir', to: 'full' }, 'ENOTEMPTY', 409);
  await ok(token, { op: 'rmdir', path: 'dir/sub' });
  await ok(token, { op: 'rename', from: 'dir', to: 'moved' });
  const { entries } = await ok(token, { op: 'list', path: '' });
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('moved') && !names.includes('dir'));
  assert.equal(entries.find((entry) => entry.name === 'moved').attr.kind, 'directory');
  await ok(token, { op: 'setattr', path: 'hello.txt', mode: 0o600, mtime: 1_000_000_000_000 });
  const attr = await ok(token, { op: 'stat', path: 'hello.txt' });
  assert.equal(attr.mode, 0o600);
  assert.equal(attr.mtime, 1_000_000_000_000);
  const statfs = await ok(token, { op: 'statfs' });
  assert.ok(statfs.bsize > 0 && statfs.blocks > 0);
  const big = await op(token, { op: 'stat', path: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(big.headers['x-hostfs-errno'], 'EINVAL');
});

test('a case-only rename keeps the file', async () => {
  const { token, capabilities } = await grant('project');
  await writeFile(join(folder, 'Case.txt'), 'case');
  await ok(token, { op: 'rename', from: 'Case.txt', to: 'case.txt' });
  const { entries } = await ok(token, { op: 'list', path: '' });
  assert.ok(entries.some((entry) => entry.name === 'case.txt'));
  if (capabilities.caseInsensitive) assert.ok(!entries.some((entry) => entry.name === 'Case.txt'));
  assert.equal(await readFile(join(folder, 'case.txt'), 'utf8'), 'case');
});

test('chunked writes land in place, in any order, and keep hard links', async () => {
  const { token } = await grant('project');
  await writeFile(join(folder, 'linked.txt'), 'old content');
  await link(join(folder, 'linked.txt'), join(folder, 'other-name.txt'));
  const opened = await ok(token, { op: 'open', path: 'linked.txt', write: true, truncate: true });
  assert.equal(opened.attr.size, 0);
  assert.equal((await put(token, opened.fh, 6, 'world')).status, 200);
  assert.equal((await put(token, opened.fh, 0, 'hello ')).status, 200);
  const { attr } = await ok(token, { op: 'release', fh: opened.fh });
  assert.equal(attr.size, 11);
  assert.equal(await readFile(join(folder, 'other-name.txt'), 'utf8'), 'hello world');
  const stale = await put(token, opened.fh, 0, 'x');
  assert.equal(stale.status, 410);
  assert.equal(stale.headers['x-hostfs-errno'], 'EBADF');
  await errno(token, { op: 'open', path: 'linked.txt', create: true, exclusive: true }, 'EEXIST');
  await errno(token, { op: 'open', path: 'moved', write: true }, 'EISDIR');
  await errno(token, { op: 'open', path: 'nope/x', create: true, write: true }, 'ENOENT');
  const created = await ok(token, { op: 'open', path: 'fresh.txt', create: true, exclusive: true });
  await put(token, created.fh, 4, 'tail');
  await ok(token, { op: 'release', fh: created.fh });
  assert.deepEqual(await readFile(join(folder, 'fresh.txt')), Buffer.from('\0\0\0\0tail'));
  const again = await ok(token, { op: 'open', path: 'fresh.txt', write: true });
  const tooBig = await put(token, again.fh, 0, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal(tooBig.headers['x-hostfs-errno'], 'EINVAL');
  await ok(token, { op: 'release', fh: again.fh });
});

test('reads come in windows, carry the etag and refuse a changed file', async () => {
  const { token } = await grant('project');
  await writeFile(join(folder, 'data.bin'), 'abcdefghij');
  const { fh, attr } = await ok(token, { op: 'open', path: 'data.bin' });
  const window = await op(token, { op: 'read', fh, offset: 2, size: 4, ifMatch: attr.etag });
  assert.equal(window.status, 200);
  assert.equal(window.body.toString(), 'cdef');
  assert.equal(window.headers.etag, attr.etag);
  assert.equal(window.headers['content-range'], 'bytes 2-5/10');
  const tail = await op(token, { op: 'read', fh, offset: 8, size: 100, ifMatch: attr.etag });
  assert.equal(tail.body.toString(), 'ij');
  const past = await op(token, { op: 'read', fh, offset: 50, size: 10, ifMatch: attr.etag });
  assert.equal(past.status, 200);
  assert.equal(past.body.byteLength, 0);
  await errno(token, { op: 'read', fh, offset: 0, size: 16 * 1024 * 1024 + 1 }, 'EINVAL');
  await writeFile(join(folder, 'data.bin'), 'ABCDEFGHIJK');
  await errno(token, { op: 'read', fh, offset: 0, size: 4, ifMatch: attr.etag }, 'ESTALE', 409);
  assert.deepEqual(await ok(token, { op: 'release', fh }), {});
});

test('a large file goes up and down in maxIo chunks', async () => {
  const { token, capabilities } = await grant('project');
  const data = randomBytes(2 * capabilities.maxIo + 12345);
  const { fh } = await ok(token, { op: 'open', path: 'big.bin', create: true, truncate: true });
  for (let offset = 0; offset < data.byteLength; offset += capabilities.maxIo) {
    const res = await put(token, fh, offset, data.subarray(offset, offset + capabilities.maxIo));
    assert.equal(res.status, 200);
  }
  await ok(token, { op: 'release', fh });
  const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
  assert.equal(sha(await readFile(join(folder, 'big.bin'))), sha(data));
  const opened = await ok(token, { op: 'open', path: 'big.bin' });
  const parts = [];
  for (let offset = 0; offset < opened.attr.size; offset += capabilities.maxIo) {
    const res = await op(token, {
      op: 'read',
      fh: opened.fh,
      offset,
      size: capabilities.maxIo,
      ifMatch: opened.attr.etag,
    });
    parts.push(res.body);
  }
  assert.equal(sha(Buffer.concat(parts)), sha(data));
});

function watch(tokens) {
  const lines = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = request(
      new URL('/api/hostfs/watch', proxy.url),
      { method: 'POST', headers: { Origin: seven, 'X-Hostfs-Token': tokens.join(', ') } },
      (res) => {
        let buffered = '';
        res.on('data', (chunk) => {
          buffered += chunk;
          const parts = buffered.split('\n');
          buffered = parts.pop();
          for (const part of parts) lines.push(JSON.parse(part));
        });
        res.on('end', () => lines.push('end'));
        resolve(res);
      }
    );
    req.on('error', reject);
    req.end();
  });
  return {
    lines,
    ready,
    close: () => req.destroy(),
    until: async (match) => {
      for (let i = 0; i < 100; i++) {
        const found = lines.find(match);
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`no matching line in ${JSON.stringify(lines)}`);
    },
  };
}

test('the watch stream reports host changes per folder and ends on revoke', async () => {
  const project = await grant('project');
  const docs = await grant('docs');
  const stream = watch([project.token, docs.token]);
  const res = await stream.ready;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/x-ndjson');
  await sleep(200);
  await mkdir(join(folder, 'watched'), { recursive: true });
  await writeFile(join(folder, 'watched', 'a.txt'), 'a');
  const line = await stream.until(
    (entry) => entry.mount === 'project' && (entry.all || entry.paths?.includes('watched/a.txt'))
  );
  if (line.paths) assert.ok(line.paths.includes('watched'));
  await writeFile(join(base, 'docs', 'readme.md'), 'docs');
  await stream.until((entry) => entry.mount === 'docs');
  await keyed('/api/hostfs/grant', { token: docs.token }, { method: 'DELETE' });
  await stream.until((entry) => entry === 'end');
  const refused = watch([project.token, 'unknown']);
  assert.equal((await refused.ready).statusCode, 403);
});

test('slicc-node exports folders given with --mount', async () => {
  const cli = await slicc(['--mount', `${folder}:work:ro`, '--mount', join(base, 'gone')]);
  try {
    const mounts = await hop(cli, {
      path: '/api/hostfs/mounts',
      headers: { Origin: seven, 'X-Bridge-Token': cli.key },
    });
    assert.deepEqual(JSON.parse(mounts.body), [{ name: 'work', readonly: true }]);
    assert.match(cli.stderr(), /--mount .*gone: not an existing folder, skipping/);
  } finally {
    await cli.stop();
  }
});
