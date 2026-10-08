import { createHash } from 'node:crypto';
import { mintKey } from './security.js';

export const GRANT_IDLE = 5 * 60 * 1000;
export const MAX_HANDLES = 4096;

const digest = (token) => createHash('sha256').update(token).digest('base64url');

export function createLock() {
  let readers = 0;
  let writing = false;
  const waiting = [];
  const next = () => {
    while (waiting.length > 0 && !writing) {
      const head = waiting[0];
      if (head.exclusive && readers > 0) return;
      waiting.shift();
      if (head.exclusive) writing = true;
      else readers++;
      head.start();
    }
  };
  const run = (exclusive, fn) =>
    new Promise((resolve, reject) => {
      waiting.push({
        exclusive,
        start: () => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              if (exclusive) writing = false;
              else readers--;
              next();
            });
        },
      });
      next();
    });
  return {
    shared: (fn) => run(false, fn),
    exclusive: (fn) => run(true, fn),
  };
}

function closeHandles(grant) {
  for (const entry of grant.handles.values()) void entry.file?.close().catch(() => {});
  grant.handles.clear();
}

export function createGrants({ idle = GRANT_IDLE, maxHandles = MAX_HANDLES } = {}) {
  const grants = new Map();
  const arm = (grant) => {
    clearTimeout(grant.timer);
    grant.timer = setTimeout(() => drop(grant.id), idle);
    grant.timer.unref();
  };
  const drop = (id) => {
    const grant = grants.get(id);
    if (!grant) return false;
    grants.delete(id);
    clearTimeout(grant.timer);
    closeHandles(grant);
    for (const end of grant.streams) end();
    return true;
  };
  return {
    grant(folder, readonly, origin) {
      const token = mintKey();
      const id = digest(token);
      const grant = {
        id,
        folder,
        readonly: readonly || folder.readonly,
        origin,
        handles: new Map(),
        streams: new Set(),
        nextFh: 1,
        maxHandles,
        timer: null,
      };
      arm(grant);
      grants.set(id, grant);
      return { token, grant };
    },
    find(token, origin) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const grant = grants.get(digest(token));
      if (!grant || grant.origin !== origin) return null;
      if (grant.streams.size === 0) arm(grant);
      return grant;
    },
    revoke: (token) => typeof token === 'string' && drop(digest(token)),
    stream(grant, end) {
      grant.streams.add(end);
      clearTimeout(grant.timer);
      return () => {
        grant.streams.delete(end);
        if (grant.streams.size === 0 && grants.has(grant.id)) arm(grant);
      };
    },
    clear() {
      for (const id of [...grants.keys()]) drop(id);
    },
  };
}

export function addHandle(grant, entry) {
  if (grant.handles.size >= grant.maxHandles) return null;
  const fh = grant.nextFh++;
  grant.handles.set(fh, entry);
  return fh;
}
