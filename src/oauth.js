import { createHash } from 'node:crypto';

export const OAUTH_TTL = 10 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function validNonce(nonce) {
  return typeof nonce === 'string' && NONCE.test(nonce);
}

export function createOAuthStates(
  now = Date.now,
  timers = { set: setTimeout, clear: clearTimeout }
) {
  const states = new Map();
  const forget = (nonce) => {
    timers.clear(states.get(nonce)?.timer);
    states.delete(nonce);
  };
  const live = (nonce) => {
    for (const [key, state] of states) {
      if (now() - state.at > OAUTH_TTL) forget(key);
    }
    return states.get(nonce);
  };
  return {
    expect(nonce, origin) {
      if (live(nonce)) forget(nonce);
      const timer = timers.set(() => states.delete(nonce), OAUTH_TTL);
      timer?.unref?.();
      states.set(nonce, { origin, at: now(), visited: false, result: null, timer });
    },
    visit(nonce) {
      const state = live(nonce);
      if (!state || state.visited) return false;
      state.visited = true;
      return true;
    },
    deliver(nonce, redirectUrl) {
      const state = live(nonce);
      if (!state?.visited || state.result !== null) return false;
      state.result = redirectUrl;
      return true;
    },
    collect(nonce, origin) {
      const state = live(nonce);
      if (!state || state.origin !== origin) return null;
      if (state.result === null) return { pending: true };
      forget(nonce);
      return { redirectUrl: state.result };
    },
    drop(nonce, origin) {
      if (live(nonce)?.origin === origin) forget(nonce);
    },
  };
}

const script = `var msg = document.getElementById('msg');
var redirectUrl = location.href;
var nonce = new URLSearchParams(location.search).get('nonce');
history.replaceState(null, '', location.pathname);
fetch('/auth/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nonce: nonce, redirectUrl: redirectUrl })
}).then(function (response) {
  if (!response.ok) throw new Error();
  msg.textContent = 'Signed in. You can close this window.';
  setTimeout(function () { window.close(); }, 300);
}).catch(function () {
  msg.textContent = 'Could not reach SLICC. Close this window and try again.';
});`;

export const callbackPage = {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'`,
  },
  body: `<!doctype html><title>SLICC</title><p id="msg">Returning to SLICC…</p><script>${script}</script>`,
};

export const refusedPage = {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
  },
  body: '<!doctype html><title>SLICC</title><p>This sign-in is unknown or has expired. Close this window and try again from SLICC.</p>',
};
