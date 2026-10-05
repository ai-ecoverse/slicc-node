import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hop, rawHead, slicc, unframe } from './proxy.mjs';
import { upstream } from './upstream.mjs';

const seven = 'https://seven.sliccy.ai';
let proxy;
let origin;
before(async () => {
  origin = await upstream();
  proxy = await slicc();
});
after(async () => {
  await proxy.stop();
  await origin.close();
});

const raw = (head, body) =>
  hop(proxy, {
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key, 'X-Slicc-Raw-Request': head },
    body,
  });

test('a request reaches the origin with its own headers, and comes back framed', async () => {
  origin.seen.length = 0;
  const res = await raw(
    rawHead(`${origin.url}/hello`, 'GET', [
      ['User-Agent', 'curl/8.22.0'],
      ['Cookie', 'a=1'],
      ['cookie', 'b=2'],
      ['X-Custom', 'one'],
      ['Connection', 'x-drop'],
      ['X-Drop', 'gone'],
      ['Host', 'evil.test'],
      ['Proxy-Authorization', 'Basic cHJveHk6c2VjcmV0'],
    ])
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.slicc.raw-fetch');
  assert.equal(res.headers['access-control-allow-origin'], seven);
  const { head, body } = unframe(res.body);
  assert.equal(head.status, 200);
  assert.equal(head.statusText, 'OK');
  assert.equal(head.url, `${origin.url}/hello`);
  assert.deepEqual(
    head.headers.filter(([name]) =>
      ['content-type', 'content-length', 'x-upstream'].includes(name)
    ),
    [
      ['content-length', '5'],
      ['content-type', 'text/plain'],
      ['x-upstream', 'yes'],
    ]
  );
  assert.equal(body.toString(), 'hello');
  const [seen] = origin.seen;
  assert.equal(seen.headers['user-agent'], 'curl/8.22.0');
  assert.equal(seen.headers.cookie, 'a=1; b=2');
  assert.equal(seen.headers['x-custom'], 'one');
  assert.equal(seen.headers['x-drop'], undefined);
  assert.equal(seen.headers['proxy-authorization'], undefined);
  assert.equal(seen.headers.host, new URL(origin.url).host);
  assert.equal(seen.headers['accept-encoding'], 'gzip, deflate, br');
  assert.equal(seen.headers.origin, undefined);
  assert.equal(seen.headers['x-bridge-token'], undefined);
  assert.match(proxy.stderr(), new RegExp(`GET ${origin.url}/hello ← 200`));
});

test('a head with a large cookie fits', async () => {
  origin.seen.length = 0;
  const cookie = `big=${'x'.repeat(64 * 1024)}`;
  const res = await raw(rawHead(`${origin.url}/hello`, 'GET', [['Cookie', cookie]]));
  assert.equal(res.status, 200);
  assert.equal(origin.seen[0].headers.cookie, cookie);
});

test('a redirect is not followed and keeps every Set-Cookie', async () => {
  origin.seen.length = 0;
  const { head } = unframe((await raw(rawHead(`${origin.url}/moved`))).body);
  assert.equal(head.status, 302);
  assert.deepEqual(
    head.headers.filter(([name]) => name === 'location' || name === 'set-cookie'),
    [
      ['location', '/target'],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/'],
    ]
  );
  assert.deepEqual(
    origin.seen.map((s) => s.url),
    ['/moved']
  );
});

test('a gzip body is decoded and its encoding and length dropped', async () => {
  const { head, body } = unframe((await raw(rawHead(`${origin.url}/gzip`))).body);
  assert.equal(body.toString(), 'decoded by the proxy\n');
  assert.equal(
    head.headers.find(([name]) => name === 'content-encoding'),
    undefined
  );
  assert.equal(
    head.headers.find(([name]) => name === 'content-length'),
    undefined
  );
});

test('a range request asks for identity', async () => {
  origin.seen.length = 0;
  await raw(rawHead(`${origin.url}/hello`, 'GET', [['Range', 'bytes=0-1']]));
  assert.equal(origin.seen[0].headers['accept-encoding'], 'identity');
});

test('a request body is forwarded, HEAD has none and keeps its length', async () => {
  origin.seen.length = 0;
  await raw(
    rawHead(`${origin.url}/echo`, 'PUT', [
      ['Content-Type', 'text/plain'],
      ['Content-Length', '999'],
    ]),
    'payload'
  );
  assert.equal(origin.seen[0].method, 'PUT');
  assert.equal(origin.seen[0].body, 'payload');
  assert.equal(origin.seen[0].headers['content-length'], '7');
  const { head, body } = unframe((await raw(rawHead(`${origin.url}/hello`, 'HEAD'))).body);
  assert.equal(body.byteLength, 0);
  assert.deepEqual(
    head.headers.find(([name]) => name === 'content-length'),
    ['content-length', '5']
  );
});

test('a large body streams through', async () => {
  const { head, body } = unframe((await raw(rawHead(`${origin.url}/stream`))).body);
  assert.equal(head.status, 200);
  assert.equal(body.byteLength, 64 * 16 * 1024);
});

test('an unreachable origin is a 502, a malformed head a 400', async () => {
  const down = await raw(rawHead('http://127.0.0.1:1/'));
  assert.equal(down.status, 502);
  assert.equal(down.headers['x-proxy-error'], '1');
  assert.match(JSON.parse(down.body).error, /^fetch failed: /);
  for (const head of [
    '{',
    rawHead('file:///etc/passwd'),
    JSON.stringify({ url: 'http://a.test/', method: 'GET X', headers: [] }),
  ]) {
    const res = await raw(head);
    assert.equal(res.status, 400, head);
    assert.deepEqual(JSON.parse(res.body), { error: 'malformed X-Slicc-Raw-Request header' });
  }
  const none = await hop(proxy, { headers: { Origin: seven, 'X-Bridge-Token': proxy.key } });
  assert.equal(none.status, 400);
  assert.deepEqual(JSON.parse(none.body), { error: 'missing X-Slicc-Raw-Request header' });
});
