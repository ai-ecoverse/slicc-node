import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';
import { slicc } from './proxy.mjs';

let site;
let origin;
let proxy;
let browser;
let folder;

before(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'slicc-lna-')));
  await writeFile(join(folder, 'hello.txt'), 'hello from the host');
  site = await serve({ roots: [['/', 'test/integration/lna/']], isolated: true });
  origin = new URL(site.url).origin;
  proxy = await slicc(['--origin', origin, '--mount', `${folder}:project`]);
  browser = await chromium.launch({
    channel: 'chromium',
    args: [`--ip-address-space-overrides=${new URL(site.url).host}=public`],
  });
});

after(async () => {
  await browser?.close();
  await proxy?.stop();
  await site?.close();
  await rm(folder, { recursive: true, force: true });
});

async function seven(permitted) {
  const context = await browser.newContext();
  if (permitted) await context.grantPermissions(['local-network-access'], { origin });
  const page = await context.newPage();
  await page.goto(site.url);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  return { page, close: () => context.close() };
}

const fromPage = (page, url, init) =>
  page.evaluate(
    async ([target, options]) => {
      try {
        const res = await fetch(target, options);
        return { status: res.status, text: await res.text() };
      } catch (error) {
        return { error: error.message };
      }
    },
    [url, init]
  );

const fromWorker = (page, message) => page.evaluate((m) => window.ask(m), message);

const probe = () => ({
  url: `${proxy.url}/api/fetch-proxy`,
  headers: { 'X-Bridge-Token': proxy.key, 'X-Slicc-Raw-Probe': '1' },
});

test('a public page without Local Network Access reaches loopback neither from the page nor from its worker', async () => {
  const { page, close } = await seven(false);
  try {
    const { url, headers } = probe();
    assert.ok((await fromPage(page, url, { method: 'POST', headers })).error);
    assert.ok((await fromWorker(page, probe())).error);
  } finally {
    await close();
  }
});

test("the page's Local Network Access permission covers its dedicated worker's hostfs traffic", async () => {
  const { page, close } = await seven(true);
  try {
    const { url, headers } = probe();
    const probed = await fromPage(page, url, { method: 'POST', headers });
    assert.equal(JSON.parse(probed.text).hostfs, 1);
    const granted = await fromPage(page, `${proxy.url}/api/hostfs/grant`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': proxy.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mount: 'project' }),
    });
    const { token } = JSON.parse(granted.text);
    const op = async (body) => {
      const res = await fromWorker(page, {
        url: `${proxy.url}/api/hostfs`,
        headers: { 'X-Hostfs-Token': token },
        body: JSON.stringify(body),
      });
      assert.equal(res.error, undefined);
      return res;
    };
    const stat = await op({ op: 'stat', path: 'hello.txt' });
    assert.equal(JSON.parse(stat.text).size, 19);
    const opened = JSON.parse((await op({ op: 'open', path: 'hello.txt' })).text);
    const read = await op({
      op: 'read',
      fh: opened.fh,
      offset: 11,
      size: 100,
      ifMatch: opened.attr.etag,
    });
    assert.equal(read.text, 'the host');
    const created = JSON.parse(
      (await op({ op: 'open', path: 'from-worker.txt', create: true, truncate: true })).text
    );
    const wrote = await fromWorker(page, {
      url: `${proxy.url}/api/hostfs/write`,
      method: 'PUT',
      headers: {
        'X-Hostfs-Token': token,
        'X-Hostfs-Request': JSON.stringify({ fh: created.fh, offset: 0 }),
      },
      body: 'written by the kernel',
    });
    assert.equal(wrote.status, 200);
    await op({ op: 'release', fh: created.fh });
    assert.equal(await readFile(join(folder, 'from-worker.txt'), 'utf8'), 'written by the kernel');
    const missing = await op({ op: 'stat', path: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(missing.errno, 'ENOENT');
    const watching = fromWorker(page, {
      url: `${proxy.url}/api/hostfs/watch`,
      headers: { 'X-Hostfs-Token': token },
      watch: true,
    });
    await sleep(300);
    await writeFile(join(folder, 'edited-on-host.txt'), 'edit');
    const watched = await watching;
    assert.equal(watched.status, 200);
    assert.equal(watched.event.mount, 'project');
  } finally {
    await close();
  }
});
