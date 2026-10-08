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
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/relay')) {
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

test('the callback answers a registered nonce once, posting only to its origin', async () => {
  await expect({ nonce: nonce('once') });
  const first = await callback(`?nonce=${nonce('once')}`);
  assert.equal(first.status, 200);
  assert.match(
    first.body.toString(),
    /postMessage\(\{ type: 'oauth-callback', redirectUrl: location\.href \}, "https:\/\/seven\.sliccy\.ai"\)/
  );
  assert.match(
    first.headers['content-security-policy'],
    /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'$/
  );
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal((await callback(`?nonce=${nonce('once')}`)).status, 403);
  assert.equal((await callback(`?nonce=${nonce('unknown')}`)).status, 403);
  assert.equal((await callback('')).status, 403);
  assert.equal((await hop(proxy, { method: 'POST', path: '/auth/callback' })).status, 405);
  assert.doesNotMatch(proxy.stderr(), /n{20}|token/);
});

test('a fake IMS redirect carrying a dummy token reaches the registered opener only', async () => {
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
  const received = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return tab.evaluate(() => window.got.splice(0));
  };

  assert.equal(await register(nonce('good')), 204);
  await login(nonce('good'));
  const good = await received();
  assert.equal(good.length, 1);
  assert.equal(good[0].origin, proxy.url.replace('127.0.0.1', 'localhost'));
  assert.equal(good[0].popup, true);
  assert.match(good[0].data.redirectUrl, /#access_token=dummy-token/);

  await login(nonce('stranger'));
  assert.deepEqual(await received(), []);

  await expect({ nonce: nonce('elsewhere') });
  await login(nonce('elsewhere'));
  assert.deepEqual(await received(), []);
  await tab.close();
});
