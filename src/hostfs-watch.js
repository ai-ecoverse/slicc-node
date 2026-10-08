import { watch } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const WATCH_DEBOUNCE = 50;
export const WATCH_MAX_PATHS = 256;
export const WATCH_RESTART = 1000;

export function relativeName(root, filename) {
  if (filename === null || filename === undefined || filename === '') return null;
  const name = String(filename);
  const rel = isAbsolute(name) ? relative(root, name) : name;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export function changedPaths(rel) {
  const at = rel.lastIndexOf('/');
  return [rel, at < 0 ? '' : rel.slice(0, at)];
}

export function createWatchers({
  debounce = WATCH_DEBOUNCE,
  maxPaths = WATCH_MAX_PATHS,
  restart = WATCH_RESTART,
  watchFn = watch,
} = {}) {
  const folders = new Map();

  const emit = (entry, event) => {
    for (const listener of entry.listeners) listener(event);
  };

  const flush = (entry) => {
    entry.timer = null;
    const paths = entry.pending;
    entry.pending = new Set();
    if (entry.overflow || paths.has(null) || paths.size > maxPaths) emit(entry, { all: true });
    else if (paths.size > 0) emit(entry, { paths: [...paths] });
    entry.overflow = false;
  };

  const note = (entry, rel) => {
    if (rel === null) entry.pending.add(null);
    else for (const path of changedPaths(rel)) entry.pending.add(path);
    if (entry.pending.size > maxPaths) entry.overflow = true;
    entry.timer ??= setTimeout(() => flush(entry), debounce);
  };

  const lost = (entry) => {
    entry.watcher = null;
    if (!entry.lost) note(entry, null);
    entry.lost = true;
    entry.retry = setTimeout(() => start(entry), restart);
  };

  const start = (entry) => {
    try {
      const watcher = watchFn(entry.root, { recursive: true }, (_type, filename) =>
        note(entry, relativeName(entry.root, filename))
      );
      watcher.on('error', () => {
        watcher.close();
        lost(entry);
      });
      entry.watcher = watcher;
      if (entry.lost) note(entry, null);
      entry.lost = false;
    } catch {
      lost(entry);
    }
  };

  return {
    subscribe(root, listener) {
      let entry = folders.get(root);
      if (!entry) {
        entry = { root, listeners: new Set(), pending: new Set(), timer: null, overflow: false };
        folders.set(root, entry);
        start(entry);
      }
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        folders.delete(root);
        clearTimeout(entry.timer);
        clearTimeout(entry.retry);
        entry.watcher?.close();
      };
    },
    close() {
      for (const entry of folders.values()) {
        clearTimeout(entry.timer);
        clearTimeout(entry.retry);
        entry.watcher?.close();
      }
      folders.clear();
    },
  };
}
