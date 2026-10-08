import { createHash } from 'node:crypto';

export const OAUTH_TTL = 10 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function validNonce(nonce) {
  return typeof nonce === 'string' && NONCE.test(nonce);
}

export function createOAuthStates(now = Date.now) {
  const states = new Map();
  const prune = () => {
    for (const [nonce, state] of states) {
      if (now() - state.at > OAUTH_TTL) states.delete(nonce);
    }
  };
  return {
    expect(nonce, origin) {
      prune();
      states.set(nonce, { origin, at: now() });
    },
    take(nonce) {
      prune();
      const state = states.get(nonce);
      states.delete(nonce);
      return state?.origin ?? null;
    },
  };
}

export function callbackPage(origin) {
  const target = JSON.stringify(origin).replaceAll('<', '\\u003c');
  const script = `try {
  window.opener.postMessage({ type: 'oauth-callback', redirectUrl: location.href }, ${target});
  document.getElementById('msg').textContent = 'Signed in. You can close this window.';
} catch (e) {
  document.getElementById('msg').textContent = 'Could not reach SLICC. Close this window and try again.';
}
setTimeout(function () { window.close(); }, 300);`;
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'`,
    },
    body: `<!doctype html><title>SLICC</title><p id="msg">Returning to SLICC…</p><script>${script}</script>`,
  };
}

export const refusedPage = {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
  },
  body: '<!doctype html><title>SLICC</title><p>This sign-in is unknown or has expired. Close this window and try again from SLICC.</p>',
};
