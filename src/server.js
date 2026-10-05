import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  decodeRequestHead,
  ERROR_HEADER,
  encodeResponseFrame,
  FETCH_PROXY_PATH,
  hasBody,
  isDecodedPartial,
  KEY_HEADER,
  MAX_HEADER_BYTES,
  MAX_REQUEST_BODY,
  RAW_CONTENT_TYPE,
  RAW_PROBE_HEADER,
  RAW_PROTOCOL_VERSION,
  RAW_REQUEST_HEADER,
  responseHeaders,
  upstreamRequestHeaders,
} from './protocol.js';
import {
  corsHeaders,
  isAllowedOrigin,
  isLoopbackHost,
  mintKey,
  normalizeOrigin,
  preflightHeaders,
  validKey,
} from './security.js';

const RAW_REQUEST = RAW_REQUEST_HEADER.toLowerCase();
const RAW_PROBE = RAW_PROBE_HEADER.toLowerCase();
const KEY = KEY_HEADER.toLowerCase();

class TooLarge extends Error {}

function fail(res, status, error, headers = {}) {
  res.writeHead(status, { ...headers, [ERROR_HEADER]: '1', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

async function readBody(req, limit) {
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

function headerList(upstream) {
  const list = [];
  upstream.headers.forEach((value, name) => {
    if (name !== 'set-cookie') list.push([name, value]);
  });
  for (const cookie of upstream.headers.getSetCookie()) list.push(['set-cookie', cookie]);
  return list;
}

function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function relay(req, res, cors, options) {
  const head = decodeRequestHead(String(req.headers[RAW_REQUEST]));
  if (!head || !isHttpUrl(head.url)) {
    fail(res, 400, `malformed ${RAW_REQUEST_HEADER} header`, cors);
    return;
  }
  let body;
  try {
    body = await readBody(req, options.maxRequestBody);
  } catch (err) {
    if (!(err instanceof TooLarge)) throw err;
    fail(res, 413, `request body exceeds ${options.maxRequestBody} bytes`, {
      ...cors,
      Connection: 'close',
    });
    return;
  }
  const method = head.method.toUpperCase();
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  let upstream;
  try {
    upstream = await options.fetch(head.url, {
      method: head.method,
      headers: upstreamRequestHeaders(head.headers),
      redirect: 'manual',
      signal: abort.signal,
      ...(body.byteLength > 0 && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    });
  } catch (err) {
    options.log(`${head.method} ${head.url} ← 502`);
    fail(res, 502, `fetch failed: ${err.cause?.message ?? err.message}`, cors);
    return;
  }
  options.log(`${head.method} ${head.url} ← ${upstream.status}`);
  const list = headerList(upstream);
  if (isDecodedPartial(upstream.status, list)) {
    await upstream.body?.cancel();
    fail(res, 502, 'upstream answered a range request with an encoded partial body', cors);
    return;
  }
  res.writeHead(200, { ...cors, 'Content-Type': RAW_CONTENT_TYPE, 'Cache-Control': 'no-store' });
  res.write(
    encodeResponseFrame({
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(head.method, upstream.status, list),
      url: head.url,
    })
  );
  if (!upstream.body || !hasBody(head.method, upstream.status)) {
    await upstream.body?.cancel();
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function handler(options) {
  return (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!isLoopbackHost(req.headers.host, options.port())) {
      fail(res, 403, 'host not allowed');
      return;
    }
    if (path !== FETCH_PROXY_PATH) {
      fail(res, 404, 'not found');
      return;
    }
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, options.origins)) {
      fail(res, 403, 'origin not allowed');
      return;
    }
    if (req.method === 'OPTIONS') {
      const pna = req.headers['access-control-request-private-network'] === 'true';
      res.writeHead(204, preflightHeaders(origin, pna));
      res.end();
      return;
    }
    const cors = corsHeaders(origin);
    if (req.method !== 'POST') {
      fail(res, 405, 'method not allowed', { ...cors, Allow: 'POST, OPTIONS' });
      return;
    }
    if (!validKey(req.headers[KEY], options.key)) {
      fail(res, 403, 'proxy key missing or wrong', cors);
      return;
    }
    if (req.headers[RAW_REQUEST] === undefined) {
      if (req.headers[RAW_PROBE] === undefined) {
        fail(res, 400, `missing ${RAW_REQUEST_HEADER} header`, cors);
        return;
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          rawFetch: RAW_PROTOCOL_VERSION,
          requestBodyStreaming: false,
          maxRequestBodyBytes: options.maxRequestBody,
        })
      );
      return;
    }
    relay(req, res, cors, options).catch((err) => {
      if (res.headersSent) res.destroy();
      else fail(res, 500, err.message, cors);
    });
  };
}

export async function startProxy(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const key = options.key ?? mintKey();
  const origins = (options.origins ?? []).map(normalizeOrigin).filter(Boolean);
  let port = 0;
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    handler({
      key,
      origins,
      port: () => port,
      fetch: options.fetch ?? globalThis.fetch,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
      log: options.log ?? (() => {}),
    })
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  port = server.address().port;
  const name = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${name}:${port}`,
    key,
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
