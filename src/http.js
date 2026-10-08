import { ERROR_HEADER } from './protocol.js';

export class TooLarge extends Error {}

export function fail(res, status, error, headers = {}) {
  res.writeHead(status, { ...headers, [ERROR_HEADER]: '1', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  try {
    const value = JSON.parse((await readBody(req, limit)).toString());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
