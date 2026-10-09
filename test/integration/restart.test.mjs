import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_PROXY_PORT } from '../../src/index.js';
import { hop, rawHead, slicc, unframe } from './proxy.mjs';

const seven = 'https://seven.sliccy.ai';
let base;
let config;
let folder;
let upstream;
let target;

const freePort = async () => {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
};

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slicc-restart-')));
  config = join(base, 'config');
  folder = join(base, 'project');
  await mkdir(folder);
  await writeFile(join(folder, 'hello.txt'), 'hello');
  upstream = createServer((_req, res) => res.end('upstream'));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  target = `http://127.0.0.1:${upstream.address().port}/`;
});

after(async () => {
  upstream.close();
  await rm(base, { recursive: true, force: true });
});

const keyed = (proxy, key, path, body) =>
  hop(proxy, {
    path,
    headers: { Origin: seven, 'X-Bridge-Token': key },
    body: JSON.stringify(body),
  });

const fetched = async (proxy, key) => {
  const res = await hop(proxy, {
    headers: { Origin: seven, 'X-Bridge-Token': key, 'X-Slicc-Raw-Request': rawHead(target) },
  });
  return res.status === 200 ? unframe(res.body).body.toString() : res.status;
};

const stat_ = (proxy, token) =>
  hop(proxy, {
    path: '/api/hostfs',
    headers: { Origin: seven, 'X-Hostfs-Token': token },
    body: JSON.stringify({ op: 'stat', path: 'hello.txt' }),
  });

test('a restarted proxy keeps its key and port, so the page reconnects', async () => {
  const port = String(await freePort());
  const args = ['--port', port, '--mount', `${folder}:project`];
  const first = await slicc(args, { config });
  const page = { url: first.url, key: first.key };
  assert.equal(await fetched(first, page.key), 'upstream');
  const { token } = JSON.parse(
    (await keyed(first, page.key, '/api/hostfs/grant', { mount: 'project' })).body
  );
  assert.equal((await stat_(first, token)).status, 200);
  await first.stop();

  const second = await slicc(args, { config });
  try {
    assert.equal(second.url, page.url);
    assert.equal(second.key, page.key);
    assert.equal(await fetched(page, page.key), 'upstream');
    assert.equal((await stat_(page, token)).status, 403);
    const regrant = await keyed(page, page.key, '/api/hostfs/grant', { mount: 'project' });
    assert.equal(regrant.status, 200);
    assert.equal((await stat_(page, JSON.parse(regrant.body).token)).status, 200);
  } finally {
    await second.stop();
  }
  const file = join(config, 'slicc-node', 'key');
  assert.equal((await readFile(file, 'utf8')).trim(), page.key);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(config, 'slicc-node'))).mode & 0o777, 0o700);
  }
});

test('--rotate-key replaces the key, --ephemeral leaves it alone', async () => {
  const port = String(await freePort());
  const kept = await slicc(['--port', port], { config });
  await kept.stop();
  const rotated = await slicc(['--port', port, '--rotate-key'], { config });
  await rotated.stop();
  assert.notEqual(rotated.key, kept.key);
  assert.equal(await fetched(kept, kept.key).catch(() => 'gone'), 'gone');
  const file = join(config, 'slicc-node', 'key');
  assert.equal((await readFile(file, 'utf8')).trim(), rotated.key);
  const ephemeral = await slicc(['--ephemeral'], { config });
  await ephemeral.stop();
  assert.notEqual(ephemeral.key, rotated.key);
  assert.notEqual(new URL(ephemeral.url).port, String(DEFAULT_PROXY_PORT));
  assert.equal((await readFile(file, 'utf8')).trim(), rotated.key);
});

test('a broken or loose key file is repaired', async () => {
  const dir = join(base, 'broken');
  const file = join(dir, 'slicc-node', 'key');
  await mkdir(join(dir, 'slicc-node'), { recursive: true });
  await writeFile(file, 'not a key\n');
  const port = String(await freePort());
  const fresh = await slicc(['--port', port], { config: dir });
  await fresh.stop();
  assert.match(fresh.stderr(), /does not hold a proxy key; minting a new one/);
  assert.equal((await readFile(file, 'utf8')).trim(), fresh.key);
  if (process.platform === 'win32') return;
  await chmod(file, 0o644);
  const tightened = await slicc(['--port', port], { config: dir });
  await tightened.stop();
  assert.equal(tightened.key, fresh.key);
  assert.match(tightened.stderr(), /was readable by others; it is 0600 now/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
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
    await assert.rejects(slicc(['--ephemeral', '--rotate-key'], { config }), /exited with 2/);
  } finally {
    blocker.close();
  }
});
