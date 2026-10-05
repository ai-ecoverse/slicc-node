import { spawn } from 'node:child_process';

export const DEFAULT_PAGE = 'https://seven.sliccy.ai/';

export function launchUrl(page, proxy) {
  const url = new URL(page);
  url.hash = new URLSearchParams({ proxy: proxy.url, key: proxy.key }).toString();
  return url.href;
}

export function opener(platform = process.platform) {
  if (platform === 'darwin') return ['open', []];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""']];
  return ['xdg-open', []];
}

export function openBrowser(url, { platform, run = spawn } = {}) {
  const [command, args] = opener(platform);
  return new Promise((resolve) => {
    const child = run(command, [...args, url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
