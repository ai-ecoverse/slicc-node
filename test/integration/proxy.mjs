import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/slicc-node.js', import.meta.url));

export async function slicc(args = []) {
  const child = spawn(process.execPath, [bin, '--no-open', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const launch = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[1];
      if (line) resolve(new URL(line));
    });
    child.once('exit', (code) => reject(new Error(`slicc-node exited with ${code}\n${err}`)));
  });
  const fragment = new URLSearchParams(launch.hash.slice(1));
  return {
    launch,
    url: fragment.get('proxy'),
    key: fragment.get('key'),
    stderr: () => err,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      }),
  };
}

export function hop(
  proxy,
  { method = 'POST', path = '/api/fetch-proxy', headers = {}, body } = {}
) {
  const target = new URL(path, proxy.url);
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function rawHead(url, method = 'GET', headers = []) {
  return JSON.stringify({ url, method, headers });
}

export function unframe(body) {
  const length = body.readUInt32BE(0);
  return {
    head: JSON.parse(body.subarray(4, 4 + length).toString()),
    body: body.subarray(4 + length),
  };
}
