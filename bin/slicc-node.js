#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  configDir,
  DEFAULT_PAGE,
  DEFAULT_PROXY_PORT,
  launchUrl,
  openBrowser,
  persistentKey,
  startProxy,
} from '../src/index.js';

const usage = `Usage: slicc-node [options]

Starts a local proxy and opens SLICC with its URL and key in the URL fragment. The key and
port stay the same across restarts, so an open SLICC page reconnects.

  --page <url>      page to open (default ${DEFAULT_PAGE})
  --port <n>        port on 127.0.0.1 (default ${DEFAULT_PROXY_PORT}, or any free port with --ephemeral)
  --origin <url>    also allow this origin, repeatable
  --mount <path>[:<name>][:ro]
                    share a folder with the page, repeatable
  --kernel-port <n> port for http://<port>.kernel.localhost/ (default 80)
  --no-kernel       do not serve the page's kernel on <port>.kernel.localhost
  --rotate-key      replace the stored key, so earlier launch URLs stop working
  --ephemeral       use a fresh key and any free port, and store nothing
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

if (values.ephemeral && values['rotate-key']) {
  process.stderr.write('--ephemeral stores no key, so there is none to rotate\n');
  process.exit(2);
}

const warn = (line) => process.stderr.write(`${line}\n`);
const persistent = !values.ephemeral;
let proxy;
try {
  proxy = await startProxy({
    key: persistent
      ? await persistentKey({ dir: configDir(), rotate: values['rotate-key'], warn })
      : undefined,
    port: Number(values.port ?? (persistent ? DEFAULT_PROXY_PORT : 0)),
    portFallback: persistent && values.port === undefined,
    origins: [...values.origin, new URL(values.page).origin],
    mounts: values.mount,
    kernelPort: values.kernel ? Number(values['kernel-port']) : null,
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
if (values.open && !(await openBrowser(url)))
  process.stderr.write('could not open a browser; open the URL above\n');

const stop = () => proxy.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
