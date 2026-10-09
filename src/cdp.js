import WebSocket, { WebSocketServer } from 'ws';
import {
  CDP_PROTOCOL,
  CDP_SUPERSEDED_CLOSE_CODE,
  CDP_SUPERSEDED_CLOSE_REASON,
  CDP_UPSTREAM_RESET_CLOSE_CODE,
  CDP_UPSTREAM_RESET_CLOSE_REASON,
  KERNEL_KEY_PROTOCOL,
} from './protocol.js';

export const CDP_CLIENT_FRAME_BUFFER_LIMIT = 1000;
export const CDP_PROXY_INSPECT_BYTES = 256 * 1024;
export const CDP_PROXY_HARD_FRAME_CAP = 64 * 1024 * 1024;
export const CHROME_RECONNECT_DELAY_MS = 1000;
export const CHROME_RECONNECT_FAILURE_THRESHOLD = 3;

const LOOP_EVENT_PREFIXES = [
  '{"method":"Network.webSocketFrameReceived"',
  '{"method":"Network.webSocketFrameSent"',
];
const OPEN = WebSocket.OPEN;

export function browserEndpoint(value) {
  if (value == null || String(value).trim() === '') return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('browser debugging URL must be http or https');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('browser debugging URL must be http or https');
  }
  return url.href;
}

export function offeredCdpKey(header) {
  const offered = String(header)
    .split(',')
    .map((value) => value.trim());
  if (!offered.includes(CDP_PROTOCOL)) return null;
  const key = offered.find((value) => value.startsWith(KERNEL_KEY_PROTOCOL));
  return key ? key.slice(KERNEL_KEY_PROTOCOL.length) : '';
}

function createClientFrameBuffer(generation) {
  return { generation, frames: [] };
}

export function appendBufferedClientFrame(frames, frame, limit = CDP_CLIENT_FRAME_BUFFER_LIMIT) {
  let dropped = false;
  while (frames.length >= limit) {
    frames.shift();
    dropped = true;
  }
  frames.push(frame);
  return dropped;
}

function currentBufferGeneration(state) {
  let chromeConnectionId = null;
  if (state.chromeWs?.readyState === OPEN) chromeConnectionId = state.chromeConnectionId;
  return { chromeConnectionId, clientId: state.activeClientId };
}

export function clientFrameBufferDropReason(buffer, current) {
  const { chromeConnectionId, clientId } = buffer.generation;
  if (chromeConnectionId !== null && chromeConnectionId !== current.chromeConnectionId) {
    return 'chrome-leg-reset';
  }
  if (current.clientId === null) return 'no-client';
  if (clientId !== current.clientId) return 'client-superseded';
  return null;
}

function takeClientFrameBuffer(state, targetConnectionId) {
  const buffer = state.messageBuffer;
  state.messageBuffer = null;
  if (!buffer) return { frames: [], dropped: null };
  const reason = clientFrameBufferDropReason(buffer, {
    chromeConnectionId: targetConnectionId,
    clientId: state.activeClientId,
  });
  if (!reason) return { frames: buffer.frames, dropped: null };
  return {
    frames: [],
    dropped: buffer.frames.length > 0 ? { count: buffer.frames.length, reason } : null,
  };
}

export function clientHoldsSlot(state, clientId) {
  return state.activeClientId === clientId;
}

function releaseClientFrameBuffer(state, reason) {
  const buffer = state.messageBuffer;
  state.messageBuffer = null;
  if (!buffer || buffer.frames.length === 0) return null;
  return { count: buffer.frames.length, reason };
}

export function adoptClientSlot(state, clientId) {
  state.activeClientId = clientId;
  let dropped = null;
  if (state.messageBuffer && state.messageBuffer.generation.clientId !== clientId) {
    dropped = releaseClientFrameBuffer(state, 'client-superseded');
  }
  state.messageBuffer ??= createClientFrameBuffer(currentBufferGeneration(state));
  return dropped;
}

export function releaseClientSlot(state, reason) {
  state.activeClientId = null;
  return releaseClientFrameBuffer(state, reason);
}

export function markChromeLegDown(state, droppedWs) {
  if (state.chromeWs !== null && state.chromeWs !== droppedWs) return false;
  state.chromeWs = null;
  if (state.shuttingDown) return false;
  state.messageBuffer ??= createClientFrameBuffer({
    chromeConnectionId: state.chromeConnectionId,
    clientId: state.activeClientId,
  });
  return true;
}

export function closeClientForUpstreamReset(client, reason, log) {
  if (!client || client.readyState !== OPEN) return false;
  log(`cdp client reset (${reason})`);
  client.close(CDP_UPSTREAM_RESET_CLOSE_CODE, CDP_UPSTREAM_RESET_CLOSE_REASON);
  return true;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export class ChromeReconnectController {
  constructor(deps) {
    this.deps = deps;
    this.task = null;
    this.cancelled = false;
    this.slotHolderAtDrop = null;
  }

  schedule(reason) {
    if (this.cancelled || this.deps.isShuttingDown()) {
      this.deps.log(`cdp browser reconnect cancelled (${reason})`);
      return;
    }
    this.slotHolderAtDrop = this.deps.activeClientId();
    if (this.task !== null) return;
    const delayMs = this.deps.delayMs ?? CHROME_RECONNECT_DELAY_MS;
    this.deps.log(`cdp browser reconnecting in ${delayMs}ms (${reason})`);
    const task = this.run(delayMs);
    this.task = task;
    void task.finally(() => {
      if (this.task === task) this.task = null;
    });
  }

  cancel() {
    this.cancelled = true;
  }

  async settled() {
    await this.task;
  }

  async run(delayMs) {
    const threshold = this.deps.failureThreshold ?? CHROME_RECONNECT_FAILURE_THRESHOLD;
    const sleep = this.deps.sleep ?? defaultSleep;
    let consecutiveFailures = 0;
    let didSignalFailure = false;
    for (;;) {
      await sleep(delayMs);
      if (this.stopped()) return;
      if (await this.attempt(consecutiveFailures + 1)) return;
      consecutiveFailures += 1;
      if (didSignalFailure || consecutiveFailures < threshold) continue;
      didSignalFailure = true;
      this.deps.log(`cdp browser reconnect failed ${consecutiveFailures} times; resetting client`);
      this.deps.resetClient('reconnect-failed');
    }
  }

  async attempt(attempt) {
    if (this.deps.isChromeLegHealthy?.() === true) {
      this.deps.log('cdp browser already reconnected');
      return true;
    }
    try {
      const url = await this.deps.discoverChromeWsUrl();
      if (this.stopped()) return true;
      await this.deps.connectChrome(url);
      if (this.stopped()) return true;
      this.deps.log('cdp browser reconnected');
      this.resetStaleSlotHolder();
      return true;
    } catch (err) {
      this.deps.log(`cdp browser reconnect attempt ${attempt} failed: ${err.message}`);
      return false;
    }
  }

  resetStaleSlotHolder() {
    const holder = this.slotHolderAtDrop;
    const current = this.deps.activeClientId();
    if (holder !== null && current === holder) {
      this.deps.resetClient('reconnected');
      return;
    }
    if (current !== null) this.deps.log('cdp client connected during the outage');
  }

  stopped() {
    if (!this.cancelled && !this.deps.isShuttingDown()) return false;
    this.deps.log('cdp browser reconnect cancelled');
    return true;
  }
}

function frameText(data) {
  return Buffer.from(data).toString('utf8');
}

function logDropped(log, dropped) {
  if (dropped) log(`cdp dropped ${dropped.count} buffered frame(s): ${dropped.reason}`);
}

function flushBufferedClientFrames(state, target, targetConnectionId, log) {
  const { frames, dropped } = takeClientFrameBuffer(state, targetConnectionId);
  logDropped(log, dropped);
  for (const frame of frames) target.send(frameText(frame));
}

function forwardChromeFrame(state, data, log) {
  const buf = Buffer.from(data);
  if (buf.byteLength > CDP_PROXY_HARD_FRAME_CAP) {
    log(`cdp dropped oversized browser frame (${buf.byteLength})`);
    return;
  }
  const head = buf.subarray(0, CDP_PROXY_INSPECT_BYTES).toString('utf8');
  if (LOOP_EVENT_PREFIXES.some((prefix) => head.startsWith(prefix))) return;
  const text = buf.toString('utf8');
  if (state.activeClientWs?.readyState === OPEN) state.activeClientWs.send(text);
}

function forwardClientFrame(state, data, log) {
  const text = frameText(data);
  if (state.chromeWs?.readyState === OPEN && state.messageBuffer === null) {
    state.chromeWs.send(text);
    return;
  }
  if (state.messageBuffer && appendBufferedClientFrame(state.messageBuffer.frames, text)) {
    log('cdp client frame buffer full');
  }
}

async function discoverBrowserSocket(browser, fetchImpl) {
  const res = await fetchImpl(new URL('/json/version', browser));
  if (!res.ok) throw new Error(`json/version answered ${res.status}`);
  const body = await res.json();
  return debuggerSocketURL(body?.webSocketDebuggerUrl);
}

export function debuggerSocketURL(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('no browser webSocketDebuggerUrl from CDP');
  }
  const lower = url.toLowerCase();
  if (lower.startsWith('wss://')) {
    throw new Error(
      `webSocketDebuggerUrl ${url} is not supported; only ws:// debugging URLs are supported`
    );
  }
  if (!lower.startsWith('ws://')) {
    throw new Error('no browser webSocketDebuggerUrl from CDP');
  }
  return url;
}

function closeQuietly(ws) {
  if (!ws) return;
  ws.once('error', () => {});
  ws.close();
}

export function createCdp({
  browser,
  fetch: fetchImpl = globalThis.fetch,
  log = () => {},
  reconnectDelay = CHROME_RECONNECT_DELAY_MS,
  failureThreshold = CHROME_RECONNECT_FAILURE_THRESHOLD,
  sleep,
}) {
  const state = {
    chromeWs: null,
    chromeConnectionId: 0,
    activeClientId: null,
    activeClientWs: null,
    messageBuffer: null,
    shuttingDown: false,
    clientConnectionSeq: 0,
    socketUrl: null,
  };

  function ensureChromeConnection(url) {
    return new Promise((resolve, reject) => {
      if (state.chromeWs && state.chromeWs.readyState === OPEN) {
        flushBufferedClientFrames(state, state.chromeWs, state.chromeConnectionId, log);
        resolve();
        return;
      }
      closeQuietly(state.chromeWs);
      state.chromeWs = null;
      state.messageBuffer ??= createClientFrameBuffer(currentBufferGeneration(state));
      const chromeWs = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
      const connectionId = ++state.chromeConnectionId;
      state.chromeWs = chromeWs;
      state.socketUrl = url;
      let opened = false;
      chromeWs.on('open', () => {
        opened = true;
        log('cdp browser connected');
        flushBufferedClientFrames(state, chromeWs, connectionId, log);
        resolve();
      });
      chromeWs.on('message', (data, isBinary) => {
        if (isBinary) return;
        forwardChromeFrame(state, data, log);
      });
      chromeWs.on('close', (code) => {
        log(`cdp browser closed (${code})`);
        handleChromeLegDown(chromeWs, `close ${code}`);
        if (!opened) reject(new Error(`browser socket closed before open (${code})`));
      });
      chromeWs.on('error', (err) => {
        log(`cdp browser error: ${err.message}`);
        handleChromeLegDown(chromeWs, `error ${err.message}`);
        reject(err);
      });
    });
  }

  function resetActiveCdpClient(reason) {
    if (!closeClientForUpstreamReset(state.activeClientWs, reason, log)) return;
    state.activeClientWs = null;
    logDropped(log, releaseClientSlot(state, 'upstream-reset'));
  }

  const reconnect = new ChromeReconnectController({
    discoverChromeWsUrl: async () => {
      state.socketUrl = await discoverBrowserSocket(browser, fetchImpl);
      return state.socketUrl;
    },
    connectChrome: (url) => ensureChromeConnection(url),
    isChromeLegHealthy: () => state.chromeWs?.readyState === OPEN,
    resetClient: (reason) => resetActiveCdpClient(reason),
    activeClientId: () => state.activeClientId,
    isShuttingDown: () => state.shuttingDown,
    log,
    sleep,
    delayMs: reconnectDelay,
    failureThreshold,
  });

  function handleChromeLegDown(chromeWs, reason) {
    if (!markChromeLegDown(state, chromeWs)) return;
    reconnect.schedule(reason);
  }

  async function ensureDiscovered() {
    if (state.chromeWs?.readyState !== OPEN) {
      state.socketUrl = await discoverBrowserSocket(browser, fetchImpl);
    }
    await ensureChromeConnection(state.socketUrl);
  }

  function handleClient(clientWs) {
    const previous = state.activeClientWs;
    state.activeClientWs = clientWs;
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      log('cdp client superseded');
      previous.close(CDP_SUPERSEDED_CLOSE_CODE, CDP_SUPERSEDED_CLOSE_REASON);
    } else {
      log('cdp client connected');
    }
    const clientId = ++state.clientConnectionSeq;
    logDropped(log, adoptClientSlot(state, clientId));
    clientWs.on('message', (data, isBinary) => {
      if (isBinary || !clientHoldsSlot(state, clientId)) return;
      forwardClientFrame(state, data, log);
    });
    clientWs.on('close', () => {
      if (state.activeClientWs !== clientWs) return;
      state.activeClientWs = null;
      logDropped(log, releaseClientSlot(state, 'client-disconnected'));
    });
    clientWs.on('error', () => {
      if (state.activeClientWs !== clientWs) return;
      state.activeClientWs = null;
      logDropped(log, releaseClientSlot(state, 'client-disconnected'));
    });
    ensureDiscovered().catch((err) => {
      log(`cdp connection failed: ${err.message}`);
      clientWs.close();
    });
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 0,
    perMessageDeflate: false,
    handleProtocols: () => CDP_PROTOCOL,
  });

  return {
    accept(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws));
    },
    close() {
      state.shuttingDown = true;
      reconnect.cancel();
      const chrome = state.chromeWs;
      state.chromeWs = null;
      if (chrome) chrome.terminate();
      const client = state.activeClientWs;
      state.activeClientWs = null;
      state.activeClientId = null;
      state.messageBuffer = null;
      if (client) client.close();
      for (const open of wss.clients) open.terminate();
      wss.close();
    },
  };
}
