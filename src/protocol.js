export const FETCH_PROXY_PATH = '/api/fetch-proxy';
export const OAUTH_STATE_PATH = '/api/oauth-state';
export const OAUTH_CALLBACK_PATH = '/auth/callback';
export const RAW_REQUEST_HEADER = 'X-Slicc-Raw-Request';
export const RAW_PROBE_HEADER = 'X-Slicc-Raw-Probe';
export const RAW_CONTENT_TYPE = 'application/vnd.slicc.raw-fetch';
export const RAW_PROTOCOL_VERSION = 1;
export const KEY_HEADER = 'X-Bridge-Token';
export const ERROR_HEADER = 'X-Proxy-Error';
export const MAX_REQUEST_BODY = 256 * 1024 * 1024;
export const MAX_HEADER_BYTES = 1024 * 1024;
export const ACCEPT_ENCODING = 'gzip, deflate, br';

const DECODED_CODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const REQUEST_SKIP = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'accept-encoding',
  'expect',
  'proxy-authorization',
]);
const RESPONSE_SKIP = new Set(HOP_BY_HOP);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const isPair = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'string' &&
  typeof value[1] === 'string';

function connectionTokens(headers) {
  const tokens = new Set();
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed) tokens.add(trimmed);
    }
  }
  return tokens;
}

function joined(headers, wanted) {
  return headers
    .filter(([name]) => name.toLowerCase() === wanted)
    .map(([, value]) => value)
    .join(',');
}

function decodedCoding(encoding) {
  const codings = encoding
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity');
  return codings.length > 0 && codings.every((c) => DECODED_CODINGS.has(c));
}

export function decodeRequestHead(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { url, method, headers } = parsed;
  if (typeof url !== 'string' || typeof method !== 'string' || !TOKEN.test(method)) return null;
  if (!Array.isArray(headers) || !headers.every(isPair)) return null;
  return { url, method, headers };
}

export function upstreamRequestHeaders(headers) {
  const named = connectionTokens(headers);
  const out = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (REQUEST_SKIP.has(lower) || named.has(lower)) continue;
    const prior = out[lower];
    out[lower] =
      prior === undefined ? value : `${prior}${lower === 'cookie' ? '; ' : ', '}${value}`;
  }
  if (out.range === undefined && out['if-range'] === undefined)
    out['accept-encoding'] = ACCEPT_ENCODING;
  return out;
}

export function hasBody(method, status) {
  return method.toUpperCase() !== 'HEAD' && !NULL_BODY_STATUSES.has(status);
}

export function isDecodedPartial(status, headers) {
  return status === 206 && decodedCoding(joined(headers, 'content-encoding'));
}

export function responseHeaders(method, status, headers) {
  const named = connectionTokens(headers);
  const kept = headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !RESPONSE_SKIP.has(lower) && !named.has(lower);
  });
  if (!hasBody(method, status)) return kept;
  const encoding = joined(kept, 'content-encoding');
  const decoded = decodedCoding(encoding);
  return kept.filter(([name]) => {
    const lower = name.toLowerCase();
    if (lower === 'content-length') return !decoded;
    if (lower === 'content-encoding')
      return !decoded && encoding.trim().toLowerCase() !== 'identity';
    return true;
  });
}

export function encodeResponseFrame(head) {
  const json = Buffer.from(JSON.stringify(head));
  const frame = Buffer.alloc(4 + json.byteLength);
  frame.writeUInt32BE(json.byteLength, 0);
  json.copy(frame, 4);
  return frame;
}
