import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { hop, slicc } from './proxy.mjs';

const seven = 'https://seven.sliccy.ai';
const nonce = (tag) => `${tag}-${'n'.repeat(20)}`;
let proxy;
let page;
let browser;
let opener;
before(async () => {
  page = createServer((req, res) => {
    const relay = req.url.startsWith('/relay');
    res.writeHead(200, {
      'Content-Type': 'text/html',
      ...(relay ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin' }),
    });
    if (relay) {
      const target = new URL(req.url, 'http://x').searchParams.get('to');
      res.end(`<script>location.replace(${JSON.stringify(target)});</script>`);
    } else {
      res.end(
        '<script>window.got = []; addEventListener("message", (event) => window.got.push({ origin: event.origin, data: event.data, popup: event.source === window.popup }));</script>'
      );
    }
  });
  await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
  opener = `http://127.0.0.1:${page.address().port}`;
  proxy = await slicc(['--origin', opener]);
  browser = await chromium.launch({ channel: 'chromium' });
});
after(async () => {
  await browser?.close();
  await proxy.stop();
  page.close();
});

const expect = (body, headers = {}) =>
  hop(proxy, {
    path: '/api/oauth-state',
    headers: {
      Origin: seven,
      'X-Bridge-Token': proxy.key,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const callback = (query) => hop(proxy, { method: 'GET', path: `/auth/callback${query}` });

test('a nonce registers only with an allowed origin and the key', async () => {
  assert.equal((await expect({ nonce: nonce('a') })).status, 204);
  assert.equal((await expect({ nonce: nonce('b') }, { 'X-Bridge-Token': 'wrong' })).status, 403);
  assert.equal(
    (await expect({ nonce: nonce('c') }, { Origin: 'https://evil.example' })).status,
    403
  );
  assert.equal((await expect({ nonce: 'short' })).status, 400);
  assert.equal((await expect('not json')).status, 400);
  assert.equal((await expect('x'.repeat(2000))).status, 400);
  const preflight = await hop(proxy, {
    method: 'OPTIONS',
    path: '/api/oauth-state',
    headers: { Origin: seven, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
});

test('the callback page hands the redirect back once, and only its registering origin collects it', async () => {
  await expect({ nonce: nonce('once') });
  const result = (value, origin = seven) =>
    hop(proxy, {
      method: 'GET',
      path: `/api/oauth-result?nonce=${value}`,
      headers: { Origin: origin, 'X-Bridge-Token': proxy.key },
    });
  assert.equal((await result(nonce('once'))).status, 204);
  const first = await callback(`?nonce=${nonce('once')}`);
  assert.equal(first.status, 200);
  assert.match(first.body.toString(), /fetch\('\/auth\/callback'/);
  assert.match(
    first.headers['content-security-policy'],
    /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'$/
  );
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal((await callback(`?nonce=${nonce('once')}`)).status, 403);
  assert.equal((await callback(`?nonce=${nonce('unknown')}`)).status, 403);
  assert.equal((await callback('')).status, 403);
  const port = new URL(proxy.url).port;
  const redirectUrl = `http://localhost:${port}/auth/callback?nonce=${nonce('once')}#access_token=dummy-token`;
  const deliver = (origin) =>
    hop(proxy, {
      path: '/auth/callback',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: nonce('once'), redirectUrl }),
    });
  assert.equal((await deliver(seven)).status, 403);
  assert.equal((await deliver(`http://localhost:${port}`)).status, 204);
  assert.equal((await result(nonce('once'), 'https://other.sliccy.ai')).status, 404);
  const got = await result(nonce('once'));
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.body.toString()).redirectUrl, redirectUrl);
  assert.equal((await result(nonce('once'))).status, 404);
  await expect({ nonce: nonce('dropped') });
  const drop = await hop(proxy, {
    method: 'DELETE',
    path: `/api/oauth-state?nonce=${nonce('dropped')}`,
    headers: { Origin: seven, 'X-Bridge-Token': proxy.key },
  });
  assert.equal(drop.status, 204);
  assert.equal((await result(nonce('dropped'))).status, 404);
  assert.doesNotMatch(proxy.stderr(), /n{20}|token/);
});

test('behind COOP, a fake IMS redirect reaches only the opener that registered it', async () => {
  const tab = await browser.newPage();
  await tab.goto(`${opener}/`);
  const register = (value) =>
    tab.evaluate(
      async ({ url, key, value }) =>
        (
          await fetch(`${url}/api/oauth-state`, {
            method: 'POST',
            headers: { 'X-Bridge-Token': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: value }),
          })
        ).status,
      { url: proxy.url, key: proxy.key, value }
    );
  const login = (value) =>
    tab.evaluate(
      ({ url, value }) => {
        const to = `${url.replace('127.0.0.1', 'localhost')}/auth/callback?nonce=${value}#access_token=dummy-token&state=x`;
        window.popup = window.open(`/relay?to=${encodeURIComponent(to)}`, 'ims', 'popup');
      },
      { url: proxy.url, value }
    );
  const collect = (value) =>
    tab.evaluate(
      async ({ url, key, value }) => {
        for (let i = 0; i < 20; i++) {
          const response = await fetch(`${url}/api/oauth-result?nonce=${value}`, {
            headers: { 'X-Bridge-Token': key },
          });
          if (response.status !== 204) {
            return { status: response.status, body: await response.text() };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { status: 204 };
      },
      { url: proxy.url, key: proxy.key, value }
    );

  assert.equal(await register(nonce('good')), 204);
  await login(nonce('good'));
  const good = await collect(nonce('good'));
  assert.equal(good.status, 200);
  assert.match(JSON.parse(good.body).redirectUrl, /#access_token=dummy-token/);
  assert.deepEqual(await tab.evaluate(() => window.got), []);

  await login(nonce('stranger'));
  assert.equal((await collect(nonce('stranger'))).status, 404);

  await expect({ nonce: nonce('elsewhere') });
  await login(nonce('elsewhere'));
  assert.equal((await collect(nonce('elsewhere'))).status, 404);
  await tab.close();
});
