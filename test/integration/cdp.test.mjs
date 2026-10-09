import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  CDP_SUPERSEDED_CLOSE_CODE,
  CDP_SUPERSEDED_CLOSE_REASON,
  CDP_UPSTREAM_RESET_CLOSE_CODE,
  CDP_UPSTREAM_RESET_CLOSE_REASON,
  startProxy,
} from '../../src/index.js';
import { seven } from './page.mjs';
import { hop } from './proxy.mjs';

async function fakeBrowser(socketURL) {
  const hits = { n: 0 };
  const upgrades = { n: 0 };
  const server = createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404);
      res.end();
      return;
    }
    hits.n += 1;
    const { port } = server.address();
    const advertised =
      socketURL === 'wss'
        ? `wss://127.0.0.1:${port}/devtools/browser/test`
        : (socketURL ?? `ws://127.0.0.1:${port}/devtools/browser/test`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: advertised }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades.n += 1;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    upgrades,
    wss,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function cdpSocket(proxy, { origin = seven, protocols, host, path = '/cdp', headers } = {}) {
  const url = new URL(path, proxy.url.replace('http:', 'ws:'));
  const offered = protocols === undefined ? ['slicc.cdp.v1', `slicc.key.${proxy.key}`] : protocols;
  const ws = new WebSocket(url, offered, {
    ...(origin ? { origin } : {}),
    headers: { ...(host ? { Host: host } : {}), ...headers },
  });
  ws.on('error', () => {});
  return ws;
}

function denied(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', () => reject(new Error('cdp opened')));
    ws.once('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    ws.once('error', () => {});
  });
}

async function open(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await once(ws, 'open');
}

test('a /cdp upgrade without the origin or the key is refused', async () => {
  const off = await startProxy({ kernelPort: null });
  const absent = await denied(cdpSocket(off));
  assert.equal(absent.status, 404);
  assert.deepEqual(JSON.parse(absent.body), { error: 'not found' });
  assert.equal(absent.headers['x-proxy-error'], '1');
  assert.equal(absent.headers['access-control-allow-origin'], undefined);
  const plain = await hop(off, {
    headers: { Origin: seven, 'X-Bridge-Token': off.key, 'X-Slicc-Raw-Probe': '1' },
  });
  assert.equal(JSON.parse(plain.body).cdp, undefined);
  await off.close();

  const browser = await fakeBrowser();
  const proxy = await startProxy({ kernelPort: null, cdp: browser.url });
  const cases = [
    [{ origin: 'https://evil.test' }, 403, 'origin not allowed'],
    [{ origin: null }, 403, 'origin not allowed'],
    [{ protocols: ['slicc.cdp.v1', 'slicc.key.wrong'] }, 403, 'proxy key missing or wrong'],
    [{ protocols: ['slicc.cdp.v1'] }, 403, 'proxy key missing or wrong'],
    [{ protocols: [`slicc.key.${proxy.key}`] }, 400, 'subprotocol slicc.cdp.v1 missing'],
    [{ protocols: [] }, 400, 'subprotocol slicc.cdp.v1 missing'],
    [
      { protocols: ['slicc.cdp.v1'], headers: { 'X-Bridge-Token': proxy.key } },
      403,
      'proxy key missing or wrong',
    ],
    [{ protocols: [], path: `/cdp?key=${proxy.key}` }, 400, 'subprotocol slicc.cdp.v1 missing'],
    [{ host: `8400.kernel.localhost:${new URL(proxy.url).port}` }, 403, 'host not allowed'],
    [{ path: '/elsewhere' }, 404, 'not found'],
  ];
  for (const [options, status, error] of cases) {
    const res = await denied(cdpSocket(proxy, options));
    assert.equal(res.status, status, JSON.stringify(options));
    assert.deepEqual(JSON.parse(res.body), { error });
    assert.equal(res.headers['x-proxy-error'], '1');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const queried = cdpSocket(proxy, { path: '/cdp?key=wrong' });
  await open(queried);
  assert.equal(queried.protocol, 'slicc.cdp.v1');
  assert.equal(queried.protocol.includes(proxy.key), false);
  queried.close();
  const page = await hop(proxy, { method: 'GET', path: '/cdp' });
  assert.equal(page.status, 404);
  assert.deepEqual(JSON.parse(page.body), { error: 'not found' });
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  const announced = await hop(proxy, {
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key, 'X-Slicc-Raw-Probe': '1' },
  });
  const probe = JSON.parse(announced.body);
  assert.equal(probe.cdp, 1);
  assert.equal(probe.rawFetch, 1);
  assert.equal(probe.requestBodyStreaming, false);
  assert.equal(typeof probe.maxRequestBodyBytes, 'number');
  assert.equal(probe.hostfs, undefined);
  assert.equal(probe.kernelTunnel, undefined);
  assert.equal(probe.kernelPort, undefined);
  await proxy.close();
  await browser.close();
});

test('a text frame is relayed to the browser socket and back', async () => {
  const browser = await fakeBrowser();
  const lines = [];
  const proxy = await startProxy({
    kernelPort: null,
    cdp: browser.url,
    cdpReconnectDelay: 20,
    log: (line) => lines.push(line),
  });
  const connected = once(browser.wss, 'connection');
  const client = cdpSocket(proxy);
  await open(client);
  assert.equal(client.protocol, 'slicc.cdp.v1');
  assert.equal(client.protocol.includes(proxy.key), false);
  const [chrome] = await connected;
  const incoming = once(chrome, 'message');
  client.send('{"id":1,"method":"Browser.getVersion"}');
  const [got, binary] = await incoming;
  assert.equal(binary, false);
  assert.equal(got.toString(), '{"id":1,"method":"Browser.getVersion"}');
  const reply = once(client, 'message');
  chrome.send('{"id":1,"result":{"product":"Chrome"}}');
  const [back] = await reply;
  assert.equal(back.toString(), '{"id":1,"result":{"product":"Chrome"}}');

  const superseded = once(client, 'close');
  const second = cdpSocket(proxy);
  const [code, reason] = await superseded;
  assert.equal(code, CDP_SUPERSEDED_CLOSE_CODE);
  assert.equal(reason.toString(), CDP_SUPERSEDED_CLOSE_REASON);
  await open(second);
  const again = once(chrome, 'message');
  second.send('{"id":2,"method":"Browser.getVersion"}');
  const [next] = await again;
  assert.equal(next.toString(), '{"id":2,"method":"Browser.getVersion"}');

  const seen = browser.hits.n;
  const reset = once(second, 'close');
  const redial = once(browser.wss, 'connection');
  chrome.close();
  const [resetCode, resetReason] = await reset;
  assert.equal(resetCode, CDP_UPSTREAM_RESET_CLOSE_CODE);
  assert.equal(resetReason.toString(), CDP_UPSTREAM_RESET_CLOSE_REASON);
  assert.ok(browser.hits.n > seen);
  const [fresh] = await redial;
  assert.equal(fresh.readyState, WebSocket.OPEN);
  await proxy.close();
  await browser.close();
  assert.ok(lines.some((line) => line.startsWith('cdp browser reconnecting')));
});

test('a wss debugger URL is refused before a dial', async () => {
  const browser = await fakeBrowser('wss');
  const socketURL = `wss://127.0.0.1:${new URL(browser.url).port}/devtools/browser/test`;
  const lines = [];
  const proxy = await startProxy({
    kernelPort: null,
    cdp: browser.url,
    log: (line) => lines.push(line),
  });
  try {
    const client = cdpSocket(proxy);
    const closed = once(client, 'close');
    await open(client);
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(browser.hits.n, 1);
    assert.equal(browser.upgrades.n, 0);
    assert.ok(
      lines.some((line) =>
        line.includes(
          `webSocketDebuggerUrl ${socketURL} is not supported; only ws:// debugging URLs are supported`
        )
      )
    );
  } finally {
    await proxy.close();
    await browser.close();
  }
});
