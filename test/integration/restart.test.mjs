import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_PROXY_PORT, persistentKey } from '../../src/index.js';
import { hop, rawHead, slicc, unframe } from './proxy.mjs';

const seven = 'https://seven.sliccy.ai';
const oldKey = 'fake-value-0001-fake-value-0001-fake-value-';
let base;
let config;
let upstream;
let target;

const freePort = async () => {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
};

const missing = (path) =>
  access(path).then(
    () => false,
    (err) => err.code === 'ENOENT'
  );

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slicc-restart-')));
  config = join(base, 'config');
  upstream = createServer((_req, res) => res.end('upstream'));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  target = `http://127.0.0.1:${upstream.address().port}/`;
});

after(async () => {
  upstream.close();
  await rm(base, { recursive: true, force: true });
});

const fetched = async (proxy, key) => {
  const res = await hop(proxy, {
    headers: { Origin: seven, 'X-Bridge-Token': key, 'X-Slicc-Raw-Request': rawHead(target) },
  });
  return res.status === 200 ? unframe(res.body).body.toString() : res.status;
};

test('every launch mints a fresh key, and a relaunch refuses the old one', async () => {
  const port = String(await freePort());
  const first = await slicc(['--port', port], { config });
  assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await fetched(first, first.key), 'upstream');
  assert.ok(await missing(join(config, 'slicc-node', 'key')));
  await first.stop();

  const second = await slicc(['--port', port], { config });
  try {
    assert.equal(second.url, first.url);
    assert.notEqual(second.key, first.key);
    assert.equal(await fetched(first, first.key), 403);
    assert.equal(await fetched(second, second.key), 'upstream');
    assert.ok(await missing(join(config, 'slicc-node', 'key')));
  } finally {
    await second.stop();
  }
  assert.ok(await missing(join(config, 'slicc-node', 'key')));
});

test('a key file left by an earlier version is deleted at startup and never used', async () => {
  const dir = join(base, 'legacy');
  const file = join(dir, 'slicc-node', 'key');
  await mkdir(join(dir, 'slicc-node'), { recursive: true });
  await writeFile(file, `${oldKey}\n`, { mode: 0o600 });
  const proxy = await slicc(['--port', String(await freePort())], { config: dir });
  try {
    assert.ok(await missing(file));
    assert.notEqual(proxy.key, oldKey);
    assert.equal(await fetched(proxy, oldKey), 403);
  } finally {
    await proxy.stop();
  }
});

test('--rotate-key and --ephemeral are accepted and change nothing', async () => {
  const port = String(await freePort());
  const proxy = await slicc(['--port', port, '--rotate-key', '--ephemeral'], { config });
  try {
    assert.equal(new URL(proxy.url).port, port);
    assert.equal(await fetched(proxy, proxy.key), 'upstream');
    assert.ok(await missing(join(config, 'slicc-node', 'key')));
  } finally {
    await proxy.stop();
  }
});

test('the default port is fixed, with a free port as fallback when it is taken', async () => {
  const blocker = createTcpServer();
  const blocked = await new Promise((resolve) => {
    blocker.once('error', () => resolve(false));
    blocker.listen(DEFAULT_PROXY_PORT, '127.0.0.1', () => resolve(true));
  });
  const fallback = await slicc([], { config });
  await fallback.stop();
  assert.notEqual(new URL(fallback.url).port, String(DEFAULT_PROXY_PORT));
  assert.match(fallback.stderr(), new RegExp(`port ${DEFAULT_PROXY_PORT} is taken`));
  if (!blocked) return;
  blocker.close();
  await once(blocker, 'close');
  const fixed = await slicc([], { config });
  await fixed.stop();
  assert.equal(new URL(fixed.url).port, String(DEFAULT_PROXY_PORT));
});

test('an explicit port that is taken stops slicc-node', async () => {
  const blocker = createTcpServer().listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  try {
    await assert.rejects(
      slicc(['--port', String(blocker.address().port)], { config }),
      /exited with 1[\s\S]*EADDRINUSE/
    );
  } finally {
    blocker.close();
  }
});

test('the deprecated persistentKey deletes an old key file and returns a fresh key', async () => {
  const dir = join(base, 'library', 'slicc-node');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'key'), `${oldKey}\n`, { mode: 0o600 });
  const one = await persistentKey({ dir });
  const two = await persistentKey({ dir });
  assert.match(one, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one, oldKey);
  assert.notEqual(one, two);
  assert.ok(await missing(join(dir, 'key')));
});
