import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, createServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { startProxy } from '../../src/index.js';
import { FRAME } from '../../src/protocol.js';
import { page, refusal, seven, tunnelSocket } from './page.mjs';
import { hop, slicc } from './proxy.mjs';

const big = Buffer.alloc(3 * 1024 * 1024, 7);
let proxy;
let upstream;
let echo;
let lines;
let hmr;

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

before(async () => {
  lines = [];
  proxy = await startProxy({ kernelPort: 0, log: (line) => lines.push(line) });
  upstream = createServer(async (req, res) => {
    if (req.url === '/big') {
      res.end(big);
      return;
    }
    let size = 0;
    try {
      for await (const chunk of req) size += chunk.byteLength;
    } catch {
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, size }));
  });
  hmr = new WebSocketServer({ server: upstream });
  hmr.on('connection', (ws) => ws.on('message', (data) => ws.send(`echo ${data}`)));
  echo = await listen(upstream);
});

after(async () => {
  for (const client of hmr.clients) client.terminate();
  upstream.closeAllConnections();
  upstream.close();
  await proxy.close();
});

function get(path, { host = '8400.kernel.localhost', method = 'GET', body, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxy.kernelPort,
        path,
        method,
        agent,
        setHost: false,
        headers: { Host: host, ...(body ? { 'Content-Length': body.byteLength } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function raw(bytes) {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.kernelPort, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
    socket.write(bytes);
  });
}

const probe = () =>
  hop(proxy, { headers: { Origin: seven, 'X-Bridge-Token': proxy.key, 'X-Slicc-Raw-Probe': '1' } });

test('the probe announces the kernel tunnel and its port', async () => {
  const res = await probe();
  const body = JSON.parse(res.body);
  assert.equal(body.kernelTunnel, 1);
  assert.equal(body.kernelPort, proxy.kernelPort);
});

test('the listener serves only <port>.kernel.localhost', async () => {
  for (const host of [
    `127.0.0.1:${proxy.kernelPort}`,
    'localhost',
    'kernel.localhost',
    '0.kernel.localhost',
    '08400.kernel.localhost',
    '65536.kernel.localhost',
    '8400.kernel.localhost.',
    '8400.kernel.localhost.evil.test',
    'evil.test',
    `8400.kernel.localhost:${proxy.kernelPort + 1}`,
  ]) {
    const res = await get('/', { host });
    assert.equal(res.status, 421, host);
    assert.equal(res.headers['x-proxy-error'], '1');
  }
  assert.match(await raw('GARBAGE\r\n\r\n'), /^HTTP\/1\.1 400 /);
  assert.match(
    await raw('GET / HTTP/1.1\r\nHost: 1.kernel.localhost\r\nHost: 2.kernel.localhost\r\n\r\n'),
    /^HTTP\/1\.1 400 /
  );
  assert.match(await raw(`GET / HTTP/1.1\r\nX-Big: ${'a'.repeat(70 * 1024)}`), /^HTTP\/1\.1 431 /);
});

test('without a seven page the listener answers 502', async () => {
  const res = await get('/');
  assert.equal(res.status, 502);
  assert.equal(res.body.toString(), 'no seven page connected\n');
});

test('the tunnel endpoint takes only an allowed origin with the key', async () => {
  const cases = [
    [{ origin: 'https://evil.test' }, 403, 'origin not allowed'],
    [{ origin: null }, 403, 'origin not allowed'],
    [
      { protocols: ['slicc.kernel-tunnel.v1', 'slicc.key.wrong'] },
      403,
      'proxy key missing or wrong',
    ],
    [{ protocols: ['slicc.kernel-tunnel.v1'] }, 403, 'proxy key missing or wrong'],
    [{ protocols: [`slicc.key.${proxy.key}`] }, 400, 'subprotocol slicc.kernel-tunnel.v1 missing'],
    [{ host: `8400.kernel.localhost:${new URL(proxy.url).port}` }, 403, 'host not allowed'],
  ];
  for (const [options, status, error] of cases) {
    const res = await refusal(tunnelSocket(proxy, options));
    assert.equal(res.status, status, JSON.stringify(options));
    assert.deepEqual(JSON.parse(res.body), { error });
  }
  const other = new WebSocket(new URL('/elsewhere', proxy.url.replace('http:', 'ws:')), {
    origin: seven,
  });
  assert.equal((await refusal(other)).status, 404);
  const ok = await page(proxy);
  assert.equal(ok.ws.protocol, 'slicc.kernel-tunnel.v1');
  await ok.close();
});

test('requests reach the kernel port, keep-alive and bodies included', async () => {
  const tab = await page(proxy, { ports: { 8400: echo } });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const first = await get('/a?b=1', { agent });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), {
    url: '/a?b=1',
    host: '8400.kernel.localhost',
    size: 0,
  });
  const upload = Buffer.alloc(1024 * 1024, 1);
  const second = await get('/upload', { agent, method: 'POST', body: upload });
  assert.equal(JSON.parse(second.body).size, upload.byteLength);
  assert.deepEqual(tab.seen.opens, [8400]);
  const download = await get('/big', { agent });
  assert.equal(download.body.byteLength, big.byteLength);
  assert.ok(download.body.equals(big));
  agent.destroy();
  await tab.close();
});

test('WebSocket upgrades pass through as raw bytes', async () => {
  const tab = await page(proxy, { ports: { 5173: echo } });
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.kernelPort}/hmr`, {
    headers: { Host: '5173.kernel.localhost' },
  });
  await once(ws, 'open');
  ws.send('hello');
  const [reply] = await once(ws, 'message');
  assert.equal(reply.toString(), 'echo hello');
  ws.close();
  await once(ws, 'close');
  await tab.close();
});

test('a port with nothing listening, a failed dial and a silent page answer 502 or 504', async () => {
  const tab = await page(proxy, { ports: { 9000: 'hang', reason: 'EHOSTDOWN\r\nX: y' } });
  const refused = await page(proxy);
  const res = await get('/', { host: '8401.kernel.localhost' });
  assert.equal(res.status, 502);
  assert.equal(res.body.toString(), 'nothing listening on kernel port 8401\n');
  await refused.close();
  const other = await get('/', { host: '8402.kernel.localhost' });
  assert.equal(other.status, 502);
  assert.equal(other.body.toString(), 'kernel port 8402: EHOSTDOWNX: y\n');
  await tab.close();
});

test('the newest page wins and an older one takes over when it leaves', async () => {
  const older = await page(proxy, { ports: { 8400: echo } });
  const newer = await page(proxy, { ports: { 8400: echo } });
  assert.equal((await get('/')).status, 200);
  assert.deepEqual(newer.seen.opens, [8400]);
  assert.deepEqual(older.seen.opens, []);
  await newer.close();
  assert.equal((await get('/')).status, 200);
  assert.deepEqual(older.seen.opens, [8400]);
  await older.close();
  assert.ok(lines.some((line) => line.startsWith(`kernel tunnel from ${seven}`)));
});

test('the listener never sends more than the window before the page credits', async () => {
  const tab = await page(proxy, { ports: { 8400: echo }, credit: false });
  const req = request({
    host: '127.0.0.1',
    port: proxy.kernelPort,
    path: '/upload',
    method: 'POST',
    setHost: false,
    headers: { Host: '8400.kernel.localhost', 'Content-Length': big.byteLength },
  });
  req.on('error', () => {});
  req.end(big);
  await sleep(300);
  const [sent] = tab.seen.received.values();
  assert.ok(sent > 0 && sent <= 256 * 1024, String(sent));
  req.destroy();
  await tab.close();
});

test('a page that breaks the protocol loses its tunnel and its streams', async () => {
  const tab = await page(proxy, { ports: { 8400: 'hang' } });
  const pending = get('/');
  await sleep(100);
  tab.ws.send('text');
  const [code] = await once(tab.ws, 'close');
  assert.equal(code, 1003);
  assert.equal((await pending).status, 502);
  const bad = await page(proxy);
  bad.send(FRAME.CREDIT, 1, Buffer.alloc(4));
  assert.equal((await once(bad.ws, 'close'))[0], 1002);
});

test('a page reset tears down a live connection', async () => {
  const tab = await page(proxy, { ports: { 5173: echo } });
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.kernelPort}/hmr`, {
    headers: { Host: '5173.kernel.localhost' },
  });
  await once(ws, 'open');
  const [id] = tab.seen.received.keys();
  tab.send(FRAME.RESET, id, Buffer.from('gone'));
  await once(ws, 'close');
  await tab.close();
});

test('an unanswered open times out with 504', async () => {
  const quick = await startProxy({ kernelPort: 0, kernelOpenTimeout: 200 });
  const tab = await page(quick, { ports: { 8400: 'hang' } });
  const res = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: quick.kernelPort,
        setHost: false,
        headers: { Host: '8400.kernel.localhost' },
      },
      (answer) => {
        answer.resume();
        answer.on('end', () => resolve(answer));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 504);
  await tab.close();
  await quick.close();
});

test('the CLI turns the listener off or warns when the port is taken', async () => {
  const blocker = createTcpServer();
  const taken = await listen(blocker);
  const busy = await slicc(['--kernel-port', String(taken)]);
  const off = await slicc(['--kernel-port', '0', '--no-kernel']);
  const on = await slicc(['--kernel-port', '0']);
  try {
    await sleep(100);
    assert.match(
      busy.stderr(),
      /kernel services are off: cannot listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\); try --kernel-port/
    );
    for (const cli of [busy, off]) {
      const res = await hop(cli, {
        headers: { Origin: seven, 'X-Bridge-Token': cli.key, 'X-Slicc-Raw-Probe': '1' },
      });
      assert.equal(JSON.parse(res.body).kernelTunnel, undefined);
    }
    assert.match(on.stderr(), /kernel services on http:\/\/<port>\.kernel\.localhost:\d+\//);
  } finally {
    await Promise.all([busy.stop(), off.stop(), on.stop()]);
    blocker.close();
  }
});

function slowClient(port, host = '8400.kernel.localhost') {
  const socket = connect(port, '127.0.0.1');
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.write(`GET /big HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  socket.pause();
  return {
    socket,
    rest: () =>
      new Promise((resolve) => {
        socket.on('end', () => resolve(Buffer.concat(chunks)));
        socket.resume();
      }),
  };
}

test('a slow browser holds the page back, then gets every byte', async () => {
  const tab = await page(proxy, { ports: { 8400: echo } });
  const client = slowClient(proxy.kernelPort);
  await sleep(300);
  const [id] = tab.seen.ids;
  const sent = tab.seen.sent.get(id);
  assert.ok(sent < big.byteLength, String(sent));
  assert.ok(sent - tab.seen.credited.get(id) <= 256 * 1024);
  const body = await client.rest();
  assert.ok(body.subarray(body.indexOf('\r\n\r\n') + 4).equals(big));
  await tab.close();
});

test('a page that overruns the window loses the stream', async () => {
  const tab = await page(proxy, { ports: { 8400: echo }, greedy: true });
  const client = slowClient(proxy.kernelPort);
  const [id] = await (async () => {
    while (tab.seen.ids.length === 0) await sleep(10);
    return tab.seen.ids;
  })();
  while (!tab.seen.resets.has(id)) await sleep(10);
  assert.equal(tab.seen.resets.get(id), 'EPROTO');
  client.socket.resume();
  await once(client.socket, 'close');
  await tab.close();
});

test('frames out of order reset only their stream', async () => {
  const tab = await page(proxy, { ports: { 8400: 'hang' } });
  const cases = [
    [[FRAME.DATA, Buffer.from('x')], 'EPROTO'],
    [[FRAME.END], 'EPROTO'],
    [[FRAME.CREDIT, Buffer.from([0, 0, 0, 1])], 'EPROTO'],
    [[FRAME.RESET], 'reset'],
  ];
  for (const [index, [[type, payload], reason]] of cases.entries()) {
    const pending = get('/');
    while (tab.seen.ids.length === index) await sleep(5);
    const id = tab.seen.ids.at(-1);
    tab.send(type, id, payload);
    const res = await pending;
    assert.equal(res.status, 502);
    assert.equal(res.body.toString(), `kernel port 8400: ${reason}\n`);
  }
  tab.send(FRAME.DATA, 999999, Buffer.from('x'));
  await sleep(50);
  assert.equal(tab.ws.readyState, WebSocket.OPEN);
  await tab.close();
});

test('data after the page ended or empty data resets the stream', async () => {
  const tab = await page(proxy, { ports: { 5173: echo } });
  for (const frames of [
    [[FRAME.DATA, Buffer.alloc(0)]],
    [[FRAME.END], [FRAME.END]],
    [[FRAME.END], [FRAME.DATA, Buffer.from('x')]],
  ]) {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.kernelPort}/hmr`, {
      headers: { Host: '5173.kernel.localhost' },
    });
    ws.on('error', () => {});
    await once(ws, 'open');
    const id = tab.seen.ids.at(-1);
    for (const [type, payload] of frames) tab.send(type, id, payload);
    await once(ws, 'close');
    assert.equal(tab.seen.resets.get(id), 'EPROTO');
  }
  await tab.close();
});

test('malformed tunnel frames close the tunnel', async () => {
  for (const frame of [
    Buffer.from([3, 0, 0]),
    Buffer.from([9, 0, 0, 0, 1]),
    Buffer.from([1, 0, 0, 0, 1, 0, 80]),
  ]) {
    const tab = await page(proxy);
    tab.ws.send(frame);
    assert.equal((await once(tab.ws, 'close'))[0], 1002);
  }
  const tab = await page(proxy);
  tab.ws.on('error', () => {});
  tab.ws.send(Buffer.alloc(5 + 64 * 1024 + 1));
  assert.equal((await once(tab.ws, 'close'))[0], 1009);
});

test('a browser that drops a live connection resets the stream', async () => {
  const tab = await page(proxy, { ports: { 8400: echo } });
  const client = slowClient(proxy.kernelPort);
  while (tab.seen.sent.size === 0) await sleep(5);
  client.socket.resetAndDestroy();
  const [id] = tab.seen.ids;
  while (!tab.seen.resets.has(id)) await sleep(5);
  assert.equal(tab.seen.resets.get(id), 'closed');
  await tab.close();
});
