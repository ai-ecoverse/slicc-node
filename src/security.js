import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ERROR_HEADER,
  HOSTFS_ERRNO_HEADER,
  HOSTFS_REQUEST_HEADER,
  HOSTFS_TOKEN_HEADER,
  KEY_HEADER,
  RAW_PROBE_HEADER,
  RAW_REQUEST_HEADER,
} from './protocol.js';

const SLICCY_HOST = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.sliccy\.ai$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALLOW_HEADERS = [
  'Content-Type',
  KEY_HEADER,
  RAW_REQUEST_HEADER,
  RAW_PROBE_HEADER,
  HOSTFS_TOKEN_HEADER,
  HOSTFS_REQUEST_HEADER,
].join(', ');
const EXPOSE_HEADERS = [ERROR_HEADER, HOSTFS_ERRNO_HEADER, 'ETag', 'Content-Range'].join(', ');

export function mintKey() {
  return randomBytes(32).toString('base64url');
}

export function normalizeOrigin(raw) {
  const trimmed = raw.trim().toLowerCase().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return url.origin === trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin, extra = []) {
  if (typeof origin !== 'string') return false;
  const match = SLICCY_HOST.exec(origin);
  if (match && match[1] !== 'www') return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && extra.includes(normalized);
}

export function isLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  const at = host.lastIndexOf(':');
  if (at <= 0 || host.slice(at + 1) !== String(port)) return false;
  return LOOPBACK_HOSTS.has(host.slice(0, at).toLowerCase());
}

export function validKey(presented, expected) {
  if (typeof presented !== 'string' || presented.length === 0 || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    Vary: 'Origin',
  };
}

export function preflightHeaders(origin, privateNetwork) {
  return {
    ...corsHeaders(origin),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '600',
    ...(privateNetwork ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
  };
}
