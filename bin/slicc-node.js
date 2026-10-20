#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  configDir,
  DEFAULT_PAGE,
  DEFAULT_PROXY_PORT,
  forgetStoredKey,
  launchUrl,
  openBrowser,
  startProxy,
} from '../src/index.js';

const usage = `Usage: slicc-node [options]

Starts a local proxy and opens SLICC with its URL and key in the URL fragment. Every launch
mints a fresh key, held in memory only, so the key lives only as long as the launcher.

  --page <url>      page to open (default ${DEFAULT_PAGE})
  --port <n>        port on 127.0.0.1 (default ${DEFAULT_PROXY_PORT}, or any free port if it is taken)
  --origin <url>    also allow this origin, repeatable
  --mount <path>[:<name>][:ro]
                    share a folder with the page, repeatable
  --kernel-port <n> port for http://<port>.kernel.localhost/ (default 80)
  --no-kernel       do not serve the page's kernel on <port>.kernel.localhost
  --cdp <url>       HTTP debugging URL of a browser already running, such as http://127.0.0.1:9222
  --rotate-key      accepted for compatibility; does nothing, every launch has a fresh key
  --ephemeral       accepted for compatibility; does nothing, no key is ever stored
  --no-open         print the URL without opening a browser
  --quiet           do not log proxied requests
  -h, --help        show this help
`;

const { values } = parseArgs({
  options: {
    page: { type: 'string', default: DEFAULT_PAGE },
    port: { type: 'string' },
    origin: { type: 'string', multiple: true, default: [] },
    mount: { type: 'string', multiple: true, default: [] },
    'kernel-port': { type: 'string', default: '80' },
    kernel: { type: 'boolean', default: true },
    cdp: { type: 'string' },
    'rotate-key': { type: 'boolean', default: false },
    ephemeral: { type: 'boolean', default: false },
    open: { type: 'boolean', default: true },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowNegative: true,
});

if (values.help) {
  process.stdout.write(usage);
  process.exit(0);
}

const warn = (line) => process.stderr.write(`${line}\n`);
let proxy;
await forgetStoredKey({ dir: configDir() }).catch((err) =>
  warn(`slicc-node: could not remove the old key file: ${err.message}`)
);
try {
  proxy = await startProxy({
    port: Number(values.port ?? DEFAULT_PROXY_PORT),
    portFallback: values.port === undefined,
    origins: [...values.origin, new URL(values.page).origin],
    mounts: values.mount,
    kernelPort: values.kernel ? Number(values['kernel-port']) : null,
    cdp: values.cdp,
    log: values.quiet ? undefined : warn,
    warn,
  });
} catch (err) {
  warn(`slicc-node: ${err.message}`);
  process.exit(1);
}
const url = launchUrl(values.page, proxy);
process.stdout.write(`slicc-node proxy on ${proxy.url}\n${url}\n`);
if (proxy.kernelPort !== null) {
  const suffix = proxy.kernelPort === 80 ? '' : `:${proxy.kernelPort}`;
  process.stderr.write(`kernel services on http://<port>.kernel.localhost${suffix}/\n`);
}
if (values.cdp) process.stderr.write(`cdp proxy for ${values.cdp}\n`);
if (values.open && !(await openBrowser(url)))
  process.stderr.write('could not open a browser; open the URL above\n');

const stop = () => proxy.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
