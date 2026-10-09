import { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  FRAME,
  KERNEL_KEY_PROTOCOL,
  KERNEL_TUNNEL_PROTOCOL,
  TUNNEL_CHUNK,
  TUNNEL_WINDOW,
} from './protocol.js';

export const OPEN_TIMEOUT = 10 * 1000;
export const TUNNEL_PING = 15 * 1000;

const u16 = (value) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
};

const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
};

export function reasonOf(payload) {
  const text = payload.toString('utf8').replace(/[^\x20-\x7e]/g, '');
  return text.slice(0, 200) || 'reset';
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

class TunnelStream extends Duplex {
  constructor(tunnel, id, timeout) {
    super({ allowHalfOpen: true });
    this.tunnel = tunnel;
    this.id = id;
    this.window = TUNNEL_WINDOW;
    this.outstanding = 0;
    this.owed = 0;
    this.queue = null;
    this.sentEnd = false;
    this.gotEnd = false;
    this.quiet = false;
    this.isOpen = false;
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
    this.opened.catch(() => {});
    this.timer = setTimeout(() => this.destroy(failure('ETIMEDOUT')), timeout);
  }

  frame(type, payload) {
    this.tunnel.send(type, this.id, payload);
  }

  onOpened() {
    clearTimeout(this.timer);
    this.isOpen = true;
    this.resolveOpened();
  }

  onData(payload) {
    if (!this.isOpen || this.gotEnd || payload.byteLength === 0) {
      this.destroy(failure('EPROTO'));
      return;
    }
    this.outstanding += payload.byteLength;
    if (this.outstanding > TUNNEL_WINDOW) {
      this.destroy(failure('EPROTO'));
      return;
    }
    if (this.push(payload)) this.credit(payload.byteLength);
    else this.owed += payload.byteLength;
  }

  credit(bytes) {
    this.outstanding -= bytes;
    this.frame(FRAME.CREDIT, u32(bytes));
  }

  onCredit(bytes) {
    this.window += bytes;
    if (this.window > TUNNEL_WINDOW) {
      this.destroy(failure('EPROTO'));
      return;
    }
    this.flush();
  }

  onEnd() {
    if (!this.isOpen || this.gotEnd) {
      this.destroy(failure('EPROTO'));
      return;
    }
    this.gotEnd = true;
    this.push(null);
  }

  onReset(reason) {
    this.quiet = true;
    this.destroy(failure(reason));
  }

  flush() {
    const queued = this.queue;
    if (!queued) return;
    while (queued.chunk.byteLength > 0 && this.window > 0) {
      const size = Math.min(queued.chunk.byteLength, this.window, TUNNEL_CHUNK);
      this.frame(FRAME.DATA, queued.chunk.subarray(0, size));
      this.window -= size;
      queued.chunk = queued.chunk.subarray(size);
    }
    if (queued.chunk.byteLength > 0) return;
    this.queue = null;
    queued.callback();
  }

  _write(chunk, _encoding, callback) {
    this.queue = { chunk, callback };
    this.flush();
  }

  _final(callback) {
    this.sentEnd = true;
    this.frame(FRAME.END);
    callback();
  }

  _read() {
    if (this.owed === 0) return;
    const owed = this.owed;
    this.owed = 0;
    this.credit(owed);
  }

  _destroy(err, callback) {
    clearTimeout(this.timer);
    this.tunnel.streams.delete(this.id);
    if (!this.quiet && !(this.sentEnd && this.gotEnd))
      this.frame(FRAME.RESET, Buffer.from(err ? err.code : 'closed'));
    this.rejectOpened(err ?? failure('closed'));
    callback(err);
  }
}

class Tunnel {
  constructor(ws, origin) {
    this.ws = ws;
    this.origin = origin;
    this.streams = new Map();
    this.alive = true;
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('message', (data, binary) => this.receive(data, binary));
    ws.on('error', () => ws.terminate());
  }

  send(type, id, payload) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeTunnelFrame(type, id, payload));
  }

  open(id, port, timeout) {
    const stream = new TunnelStream(this, id, timeout);
    this.streams.set(id, stream);
    this.send(FRAME.OPEN, id, u16(port));
    return stream;
  }

  receive(data, binary) {
    if (!binary) {
      this.ws.close(1003, 'binary frames only');
      return;
    }
    const frame = decodeTunnelFrame(data);
    if (!frame || !this.valid(frame)) {
      this.ws.close(1002, 'malformed tunnel frame');
      return;
    }
    const stream = this.streams.get(frame.id);
    if (!stream) return;
    if (frame.type === FRAME.OPENED) stream.onOpened();
    else if (frame.type === FRAME.DATA) stream.onData(frame.payload);
    else if (frame.type === FRAME.END) stream.onEnd();
    else if (frame.type === FRAME.RESET) stream.onReset(reasonOf(frame.payload));
    else stream.onCredit(frame.payload.readUInt32BE(0));
  }

  valid({ type, payload }) {
    if (type === FRAME.OPENED || type === FRAME.END) return payload.byteLength === 0;
    if (type === FRAME.DATA) return payload.byteLength <= TUNNEL_CHUNK;
    if (type === FRAME.RESET) return true;
    if (type === FRAME.CREDIT) return payload.byteLength === 4 && payload.readUInt32BE(0) > 0;
    return false;
  }

  gone() {
    for (const stream of this.streams.values()) stream.onReset('ECONNRESET');
  }
}

export function offeredKey(header) {
  const offered = String(header)
    .split(',')
    .map((value) => value.trim());
  if (!offered.includes(KERNEL_TUNNEL_PROTOCOL)) return null;
  const key = offered.find((value) => value.startsWith(KERNEL_KEY_PROTOCOL));
  return key ? key.slice(KERNEL_KEY_PROTOCOL.length) : '';
}

export function createTunnels({ log, openTimeout = OPEN_TIMEOUT, ping = TUNNEL_PING }) {
  const live = [];
  let next = 0;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 5 + TUNNEL_CHUNK,
    perMessageDeflate: false,
    handleProtocols: () => KERNEL_TUNNEL_PROTOCOL,
  });
  const pinger = setInterval(() => {
    for (const tunnel of live) {
      if (!tunnel.alive) tunnel.ws.terminate();
      tunnel.alive = false;
      tunnel.ws.ping();
    }
  }, ping);
  pinger.unref();
  return {
    accept(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const tunnel = new Tunnel(ws, req.headers.origin);
        live.push(tunnel);
        log(`kernel tunnel from ${tunnel.origin} (${live.length} open)`);
        ws.on('close', () => {
          live.splice(live.indexOf(tunnel), 1);
          tunnel.gone();
          log(`kernel tunnel from ${tunnel.origin} closed (${live.length} open)`);
        });
      });
    },
    open(port) {
      const tunnel = live.at(-1);
      if (!tunnel) return null;
      next += 1;
      return tunnel.open(next, port, openTimeout);
    },
    count: () => live.length,
    close() {
      clearInterval(pinger);
      for (const tunnel of [...live]) tunnel.ws.terminate();
      wss.close();
    },
  };
}
