import { createServer, STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import {
  createHostfs,
  HOSTFS_KEY_PATHS,
  HOSTFS_TOKEN_PATHS,
  loadFolders,
} from './hostfs-routes.js';
import { fail, readBody, TooLarge } from './http.js';
import { listenKernel } from './kernel.js';
import { callbackPage, createOAuthStates, refusedPage, validNonce } from './oauth.js';
import {
  decodeRequestHead,
  ERROR_HEADER,
  encodeResponseFrame,
  FETCH_PROXY_PATH,
  HOSTFS_PROTOCOL_VERSION,
  hasBody,
  isDecodedPartial,
  KERNEL_PORT,
  KERNEL_TUNNEL_PATH,
  KERNEL_TUNNEL_PROTOCOL,
  KERNEL_TUNNEL_VERSION,
  KEY_HEADER,
  MAX_HEADER_BYTES,
  MAX_REQUEST_BODY,
  OAUTH_CALLBACK_PATH,
  OAUTH_REDIRECT_LIMIT,
  OAUTH_RESULT_PATH,
  OAUTH_STATE_PATH,
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
import { createTunnels, offeredKey } from './tunnel.js';

const RAW_REQUEST = RAW_REQUEST_HEADER.toLowerCase();
const RAW_PROBE = RAW_PROBE_HEADER.toLowerCase();
const KEY = KEY_HEADER.toLowerCase();

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

function page(res, status, { headers, body }) {
  res.writeHead(status, headers);
  res.end(body);
}

function callback(req, res, url, states, port) {
  if (req.method === 'POST') {
    void deliver(req, res, states, port);
    return;
  }
  if (req.method !== 'GET') {
    fail(res, 405, 'method not allowed', { Allow: 'GET, POST' });
    return;
  }
  const nonce = url.searchParams.get('nonce');
  if (validNonce(nonce) && states.visit(nonce)) page(res, 200, callbackPage);
  else page(res, 403, refusedPage);
}

function sameProxy(origin, port) {
  if (typeof origin !== 'string' || !URL.canParse(origin)) return false;
  const { protocol, host } = new URL(origin);
  return protocol === 'http:' && isLoopbackHost(host, port);
}

async function deliver(req, res, states, port) {
  if (!sameProxy(req.headers.origin, port)) {
    fail(res, 403, 'origin not allowed');
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req, OAUTH_REDIRECT_LIMIT)).toString());
  } catch {
    body = null;
  }
  const { nonce, redirectUrl } = body ?? {};
  const matches =
    validNonce(nonce) &&
    typeof redirectUrl === 'string' &&
    URL.canParse(redirectUrl) &&
    new URL(redirectUrl).searchParams.get('nonce') === nonce;
  res.writeHead(matches && states.deliver(nonce, redirectUrl) ? 204 : 403, {
    'Cache-Control': 'no-store',
  });
  res.end();
}

function collect(res, url, cors, states, origin) {
  const found = states.collect(url.searchParams.get('nonce'), origin);
  if (!found) {
    fail(res, 404, 'sign-in unknown or expired', cors);
    return;
  }
  if (found.pending) {
    res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ redirectUrl: found.redirectUrl }));
}

async function expectState(req, res, cors, states) {
  let nonce;
  try {
    nonce = JSON.parse((await readBody(req, 1024)).toString()).nonce;
  } catch {
    nonce = undefined;
  }
  if (!validNonce(nonce)) {
    fail(res, 400, 'nonce missing or malformed', cors);
    return;
  }
  states.expect(nonce, req.headers.origin);
  res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
  res.end();
}

function oauth(req, res, url, cors, states) {
  const nonce = url.searchParams.get('nonce');
  if (url.pathname === OAUTH_RESULT_PATH) {
    collect(res, url, cors, states, req.headers.origin);
  } else if (req.method === 'DELETE') {
    states.drop(nonce, req.headers.origin);
    res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
    res.end();
  } else {
    void expectState(req, res, cors, states);
  }
}

const gated = {
  [FETCH_PROXY_PATH]: ['POST'],
  [OAUTH_STATE_PATH]: ['POST', 'DELETE'],
  [OAUTH_RESULT_PATH]: ['GET'],
  ...HOSTFS_KEY_PATHS,
  ...HOSTFS_TOKEN_PATHS,
};

function probe(res, cors, options) {
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
      ...(options.hostfs.mounts().length > 0 ? { hostfs: HOSTFS_PROTOCOL_VERSION } : {}),
      ...(options.kernelPort() !== null
        ? { kernelTunnel: KERNEL_TUNNEL_VERSION, kernelPort: options.kernelPort() }
        : {}),
    })
  );
}

export function handler(options) {
  const states = options.states ?? createOAuthStates();
  const hostfs = options.hostfs ?? createHostfs();
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!isLoopbackHost(req.headers.host, options.port())) {
      fail(res, 403, 'host not allowed');
      return;
    }
    if (path === OAUTH_CALLBACK_PATH) {
      callback(req, res, url, states, options.port());
      return;
    }
    const methods = gated[path];
    if (!methods) {
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
    if (!methods.includes(req.method)) {
      fail(res, 405, 'method not allowed', { ...cors, Allow: `${methods.join(', ')}, OPTIONS` });
      return;
    }
    if (HOSTFS_TOKEN_PATHS[path]) {
      void hostfs.handle(req, res, path, cors);
      return;
    }
    if (!validKey(req.headers[KEY], options.key)) {
      fail(res, 403, 'proxy key missing or wrong', cors);
      return;
    }
    if (HOSTFS_KEY_PATHS[path]) {
      void hostfs.handle(req, res, path, cors);
      return;
    }
    if (path !== FETCH_PROXY_PATH) {
      oauth(req, res, url, cors, states);
      return;
    }
    if (req.headers[RAW_REQUEST] === undefined) {
      if (req.headers[RAW_PROBE] === undefined) {
        fail(res, 400, `missing ${RAW_REQUEST_HEADER} header`, cors);
        return;
      }
      probe(res, cors, { ...options, hostfs });
      return;
    }
    relay(req, res, cors, options).catch((err) => {
      if (res.headersSent) res.destroy();
      else fail(res, 500, err.message, cors);
    });
  };
}

function refuse(socket, status, error) {
  const body = JSON.stringify({ error });
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      `${ERROR_HEADER}: 1`,
      'Connection: close',
      '',
      body,
    ].join('\r\n')
  );
}

export function upgrader(options) {
  return (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!isLoopbackHost(req.headers.host, options.port())) {
      refuse(socket, 403, 'host not allowed');
      return;
    }
    if (path !== KERNEL_TUNNEL_PATH || options.kernelPort() === null) {
      refuse(socket, 404, 'not found');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, options.origins)) {
      refuse(socket, 403, 'origin not allowed');
      return;
    }
    const key = offeredKey(req.headers['sec-websocket-protocol']);
    if (key === null) {
      refuse(socket, 400, `subprotocol ${KERNEL_TUNNEL_PROTOCOL} missing`);
      return;
    }
    if (!validKey(key, options.key)) {
      refuse(socket, 403, 'proxy key missing or wrong');
      return;
    }
    options.tunnels.accept(req, socket, head);
  };
}

async function openKernel(options, host, tunnels, log) {
  const port = options.kernelPort === undefined ? KERNEL_PORT : options.kernelPort;
  if (port === null) return null;
  try {
    return await listenKernel({ port, host, tunnels, log });
  } catch (err) {
    (options.warn ?? log)(
      `kernel services are off: cannot listen on ${host}:${port} (${err.code}); try --kernel-port`
    );
    return null;
  }
}

export async function startProxy(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const key = options.key ?? mintKey();
  const origins = (options.origins ?? []).map(normalizeOrigin).filter(Boolean);
  const log = options.log ?? (() => {});
  const hostfs = createHostfs({
    folders: await loadFolders(options.mounts ?? [], options.warn ?? log),
    idle: options.hostfsIdle,
    log,
  });
  const tunnels = createTunnels({ log, openTimeout: options.kernelOpenTimeout });
  let port = 0;
  let kernelPort = null;
  const shared = { key, origins, port: () => port, kernelPort: () => kernelPort };
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    handler({
      ...shared,
      fetch: options.fetch ?? globalThis.fetch,
      maxRequestBody: options.maxRequestBody ?? MAX_REQUEST_BODY,
      log,
      hostfs,
    })
  );
  server.on('upgrade', upgrader({ ...shared, tunnels }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  port = server.address().port;
  const kernel = await openKernel(options, host, tunnels, log);
  kernelPort = kernel ? kernel.port : null;
  const name = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${name}:${port}`,
    key,
    server,
    kernelPort,
    close: () =>
      Promise.all([
        new Promise((resolve) => {
          hostfs.close();
          tunnels.close();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
        kernel?.close(),
      ]).then(() => {}),
  };
}
