import { createServer } from 'node:net';
import { ERROR_HEADER } from './protocol.js';

export const HEAD_LIMIT = 64 * 1024;
export const HEAD_TIMEOUT = 30 * 1000;

const KERNEL_HOST = /^([1-9][0-9]{0,4})\.kernel\.localhost(?::([0-9]+))?$/i;
const REQUEST_LINE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ [^\s]+ HTTP\/1\.[01]$/;
const STATUS_TEXT = {
  400: 'Bad Request',
  421: 'Misdirected Request',
  431: 'Request Header Fields Too Large',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
};

export function kernelPortOf(host, listenPort) {
  const match = KERNEL_HOST.exec(host);
  if (!match) return null;
  const port = Number(match[1]);
  if (port > 65535) return null;
  if (match[2] !== undefined && match[2] !== String(listenPort)) return null;
  return port;
}

export function parseHead(text) {
  const [line, ...fields] = text.split('\r\n');
  if (!REQUEST_LINE.test(line)) return null;
  const hosts = fields.filter((field) => /^host:/i.test(field));
  if (hosts.length !== 1) return null;
  return { method: line.slice(0, line.indexOf(' ')), host: hosts[0].slice(5).trim() };
}

function answer(socket, status, message) {
  const body = `${message}\n`;
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status]}`,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Cache-Control: no-store',
      `${ERROR_HEADER}: 1`,
      'Connection: close',
      '',
      body,
    ].join('\r\n')
  );
}

function dialFailure(err, port) {
  if (err.code === 'ETIMEDOUT') return [504, `kernel port ${port} did not answer`];
  if (err.code === 'ECONNREFUSED') return [502, `nothing listening on kernel port ${port}`];
  if (err.code === 'ECONNRESET') return [502, 'no seven page connected'];
  return [502, `kernel port ${port}: ${err.code}`];
}

async function forward(socket, buffered, end, options) {
  const head = parseHead(buffered.subarray(0, end).toString('latin1'));
  if (!head) {
    answer(socket, 400, 'malformed request head');
    return;
  }
  const port = kernelPortOf(head.host, options.port());
  if (port === null) {
    answer(socket, 421, 'only <port>.kernel.localhost is served here');
    return;
  }
  const stream = options.tunnels.open(port);
  if (!stream) {
    options.log(`kernel ${head.method} ${port} ← 502 no page`);
    answer(socket, 502, 'no seven page connected');
    return;
  }
  let piped = false;
  stream.on('error', () => {
    if (piped) socket.destroy();
  });
  socket.once('close', () => stream.destroy());
  try {
    await stream.opened;
  } catch (err) {
    const [status, message] = dialFailure(err, port);
    options.log(`kernel ${head.method} ${port} ← ${status}`);
    answer(socket, status, message);
    return;
  }
  options.log(`kernel ${head.method} ${port}`);
  piped = true;
  stream.write(buffered);
  socket.pipe(stream);
  stream.pipe(socket);
}

function connection(socket, options) {
  const chunks = [];
  let size = 0;
  socket.on('error', socket.destroy);
  socket.on('timeout', socket.destroy);
  socket.setTimeout(HEAD_TIMEOUT);
  const read = (chunk) => {
    chunks.push(chunk);
    size += chunk.byteLength;
    const buffered = Buffer.concat(chunks);
    const end = buffered.indexOf('\r\n\r\n');
    if (end === -1 && size <= HEAD_LIMIT) return;
    socket.off('data', read);
    socket.pause();
    socket.setTimeout(0);
    if (end === -1 || end > HEAD_LIMIT) answer(socket, 431, 'request head too large');
    else void forward(socket, buffered, end, options);
  };
  socket.on('data', read);
}

export async function listenKernel({ port, host, tunnels, log }) {
  let bound = 0;
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    connection(socket, { tunnels, log, port: () => bound });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  bound = server.address().port;
  return {
    port: bound,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
