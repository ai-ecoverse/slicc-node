#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_PAGE, launchUrl, openBrowser, startProxy } from '../src/index.js';

const usage = `Usage: slicc-node [options]

Starts a local proxy with a fresh proxy key and opens SLICC with both in the URL fragment.

  --page <url>      page to open (default ${DEFAULT_PAGE})
  --port <n>        port on 127.0.0.1 (default: any free port)
  --origin <url>    also allow this origin, repeatable
  --mount <path>[:<name>][:ro]
                    share a folder with the page, repeatable
  --no-open         print the URL without opening a browser
  --quiet           do not log proxied requests
  -h, --help        show this help
`;

const { values } = parseArgs({
  options: {
    page: { type: 'string', default: DEFAULT_PAGE },
    port: { type: 'string', default: '0' },
    origin: { type: 'string', multiple: true, default: [] },
    mount: { type: 'string', multiple: true, default: [] },
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

const proxy = await startProxy({
  port: Number(values.port),
  origins: [...values.origin, new URL(values.page).origin],
  mounts: values.mount,
  log: values.quiet ? undefined : (line) => process.stderr.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
});
const url = launchUrl(values.page, proxy);
process.stdout.write(`slicc-node proxy on ${proxy.url}\n${url}\n`);
if (values.open && !(await openBrowser(url)))
  process.stderr.write('could not open a browser; open the URL above\n');

const stop = () => proxy.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
