import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hop, slicc } from './proxy.mjs';

const seven = 'https://seven.sliccy.ai';
let proxy;
before(async () => {
  proxy = await slicc(['--origin', 'http://localhost:8787/']);
});
after(() => proxy.stop());

const probe = (headers) => hop(proxy, { headers: { 'X-Slicc-Raw-Probe': '1', ...headers } });

test('the launch URL carries the proxy and a fresh key in the fragment only', async () => {
  assert.equal(proxy.launch.origin, seven);
  assert.equal(proxy.launch.pathname, '/');
  assert.equal(proxy.launch.search, '');
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(proxy.key, /^[A-Za-z0-9_-]{43}$/);
  const other = await slicc();
  await other.stop();
  assert.notEqual(other.key, proxy.key);
});

test('an allowed origin with the key gets the probe reply and CORS', async () => {
  const res = await probe({ Origin: seven, 'X-Bridge-Token': proxy.key });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], seven);
  assert.equal(res.headers['access-control-expose-headers'], 'X-Proxy-Error');
  assert.deepEqual(JSON.parse(res.body), {
    rawFetch: 1,
    requestBodyStreaming: false,
    maxRequestBodyBytes: 268435456,
  });
});

test('a missing or wrong key is refused, readable by the page', async () => {
  for (const headers of [
    {},
    { 'X-Bridge-Token': 'wrong' },
    { 'X-Bridge-Token': `${proxy.key}x` },
  ]) {
    const res = await probe({ Origin: seven, ...headers });
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-proxy-error'], '1');
    assert.equal(res.headers['access-control-allow-origin'], seven);
    assert.deepEqual(JSON.parse(res.body), { error: 'proxy key missing or wrong' });
  }
  const res = await hop(proxy, {
    path: `/api/fetch-proxy?key=${proxy.key}`,
    headers: { Origin: seven, 'X-Slicc-Raw-Probe': '1' },
  });
  assert.equal(res.status, 403);
});

test('branch hosts and added origins are allowed, other origins refused without CORS', async () => {
  for (const origin of ['https://my-branch.sliccy.ai', 'http://localhost:8787']) {
    const res = await probe({ Origin: origin, 'X-Bridge-Token': proxy.key });
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers['access-control-allow-origin'], origin);
  }
  for (const origin of [
    undefined,
    'null',
    'https://www.sliccy.ai',
    'https://sliccy.ai',
    'http://seven.sliccy.ai',
    'https://seven.sliccy.ai.evil.test',
    'https://a.b.sliccy.ai',
    'https://seven.sliccy.ai:8443',
    'https://evil.test',
  ]) {
    const res = await probe({ ...(origin ? { Origin: origin } : {}), 'X-Bridge-Token': proxy.key });
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
    assert.deepEqual(JSON.parse(res.body), { error: 'origin not allowed' });
  }
});

test('the preflight allows the transport headers and the private network', async () => {
  const res = await hop(proxy, {
    method: 'OPTIONS',
    headers: {
      Origin: seven,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-bridge-token, x-slicc-raw-request',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], seven);
  assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(
    res.headers['access-control-allow-headers'],
    'Content-Type, X-Bridge-Token, X-Slicc-Raw-Request, X-Slicc-Raw-Probe'
  );
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
  const plain = await hop(proxy, {
    method: 'OPTIONS',
    headers: { Origin: seven, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(plain.status, 204);
  assert.equal(plain.headers['access-control-allow-private-network'], undefined);
  const refused = await hop(proxy, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['access-control-allow-origin'], undefined);
});

test('a foreign Host header, another path or another method is refused', async () => {
  const port = new URL(proxy.url).port;
  const rebound = await probe({
    Host: `evil.test:${port}`,
    Origin: seven,
    'X-Bridge-Token': proxy.key,
  });
  assert.equal(rebound.status, 403);
  assert.deepEqual(JSON.parse(rebound.body), { error: 'host not allowed' });
  const named = await probe({
    Host: `localhost:${port}`,
    Origin: seven,
    'X-Bridge-Token': proxy.key,
  });
  assert.equal(named.status, 200);
  const path = await hop(proxy, {
    path: '/api/other',
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key },
  });
  assert.equal(path.status, 404);
  const get = await hop(proxy, {
    method: 'GET',
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key },
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST, OPTIONS');
});
