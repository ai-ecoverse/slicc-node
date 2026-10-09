import { connect } from 'node:net';
import WebSocket from 'ws';
import { decodeTunnelFrame, encodeTunnelFrame, FRAME, TUNNEL_CHUNK } from '../../src/protocol.js';

export const seven = 'https://seven.sliccy.ai';

export function tunnelSocket(proxy, { origin = seven, protocols, host } = {}) {
  const url = new URL('/api/kernel-tunnel', proxy.url.replace('http:', 'ws:'));
  return new WebSocket(url, protocols ?? ['slicc.kernel-tunnel.v1', `slicc.key.${proxy.key}`], {
    ...(origin ? { origin } : {}),
    ...(host ? { headers: { Host: host } } : {}),
  });
}

export function refusal(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', () => reject(new Error('tunnel opened')));
    ws.once('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    ws.once('error', () => {});
  });
}

const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
};

export async function page(proxy, { ports = {}, credit = true, origin, greedy = false } = {}) {
  const ws = tunnelSocket(proxy, { origin });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const streams = new Map();
  const seen = {
    opens: [],
    ids: [],
    received: new Map(),
    sent: new Map(),
    credited: new Map(),
    resets: new Map(),
  };
  const send = (type, id, payload) => ws.send(encodeTunnelFrame(type, id, payload));
  const open = (id, port) => {
    seen.opens.push(port);
    seen.ids.push(id);
    if (!(port in ports)) {
      send(FRAME.RESET, id, Buffer.from(ports.reason ?? 'ECONNREFUSED'));
      return;
    }
    if (ports[port] === 'hang') return;
    const socket = connect({ port: ports[port], host: '127.0.0.1', allowHalfOpen: true });
    const entry = { socket, window: 256 * 1024 };
    streams.set(id, entry);
    seen.received.set(id, 0);
    seen.sent.set(id, 0);
    seen.credited.set(id, 0);
    socket.on('connect', () => send(FRAME.OPENED, id));
    socket.on('data', (chunk) => {
      for (let at = 0; at < chunk.byteLength; at += TUNNEL_CHUNK)
        send(FRAME.DATA, id, chunk.subarray(at, at + TUNNEL_CHUNK));
      seen.sent.set(id, seen.sent.get(id) + chunk.byteLength);
      entry.window -= chunk.byteLength;
      if (entry.window < TUNNEL_CHUNK && !greedy) socket.pause();
    });
    socket.on('end', () => send(FRAME.END, id));
    socket.on('error', () => send(FRAME.RESET, id, Buffer.from('ECONNRESET')));
  };
  ws.on('close', () => {
    for (const { socket } of streams.values()) socket.destroy();
  });
  ws.on('message', (data) => {
    const { type, id, payload } = decodeTunnelFrame(data);
    if (type === FRAME.OPEN) {
      open(id, payload.readUInt16BE(0));
      return;
    }
    if (type === FRAME.RESET) seen.resets.set(id, payload.toString());
    const stream = streams.get(id);
    if (!stream) return;
    if (type === FRAME.DATA) {
      seen.received.set(id, seen.received.get(id) + payload.byteLength);
      stream.socket.write(payload, () => {
        if (credit) send(FRAME.CREDIT, id, u32(payload.byteLength));
      });
    } else if (type === FRAME.CREDIT) {
      seen.credited.set(id, seen.credited.get(id) + payload.readUInt32BE(0));
      stream.window += payload.readUInt32BE(0);
      if (stream.window >= TUNNEL_CHUNK) stream.socket.resume();
    } else if (type === FRAME.END) {
      stream.socket.end();
    } else if (type === FRAME.RESET) {
      stream.socket.destroy();
    }
  });
  return {
    ws,
    seen,
    send,
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve();
        ws.once('close', resolve);
        ws.close();
      }),
  };
}
