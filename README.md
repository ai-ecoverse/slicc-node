# slicc-node

SLICC's local proxy for Node. It gives the new SLICC on `*.sliccy.ai` full network access: the page's kernel sends every request a program makes (`curl`, `git`, `npm`) to this process on loopback, which fetches it without CORS.

```bash
npx @ai-ecoverse/slicc-node
```

This starts the proxy on `127.0.0.1` with a fresh proxy key and opens `https://seven.sliccy.ai/#proxy=…&key=…`. The page passes both to `localProxyTransport({ url, key })` from [`@ai-ecoverse/slicc-kernel`](https://github.com/ai-ecoverse/slicc-kernel). The first time, Chrome asks whether the page may reach apps on this device (Local Network Access); allow it. The proxy lives as long as the process: stop it with `^C`, and the key dies with it.

| option | |
| --- | --- |
| `--page <url>` | page to open, default `https://seven.sliccy.ai/`; its origin is allowed too |
| `--port <n>` | port on `127.0.0.1`, default any free port |
| `--origin <url>` | also allow this origin (repeatable), for a page served locally |
| `--no-open` | print the URL without opening a browser |
| `--quiet` | do not log proxied requests to stderr |

```js
import { launchUrl, startProxy } from '@ai-ecoverse/slicc-node';

const proxy = await startProxy({ port: 0, origins: ['http://localhost:8787'] });
console.log(launchUrl('https://seven.sliccy.ai/', proxy));
await proxy.close();
```

`startProxy` also takes `key`, `host`, `fetch`, `maxRequestBody` and `log`, and resolves with `{ url, key, server, close() }`.

## Protocol

This is the contract a local proxy implements, so slicc-node and [slicc-swift](https://github.com/ai-ecoverse/slicc-swift) behave alike. It is raw mode of SLICC's `/api/fetch-proxy` (`packages/shared-ts/src/raw-fetch-protocol.ts`), with the security of its standalone bridge (`packages/node-server/src/bridge-security.ts`). The client is `localProxyTransport` in slicc-kernel.

### Launch

- The proxy listens on loopback only, and mints a fresh key per process: 32 random bytes, base64url (43 characters).
- It opens the page with both in the **fragment**, which never reaches a server: `https://seven.sliccy.ai/#proxy=http%3A%2F%2F127.0.0.1%3A54321&key=<key>`, form-encoded (`URLSearchParams`). The page keeps them, strips them from the address bar and falls back to `fetchTransport()` once `probeLocalProxy` returns `null`.

### Gate

Every request to the proxy passes these checks in order. Each refusal is a JSON `{ "error": "<reason>" }` with `X-Proxy-Error: 1`.

1. **Host:** `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the proxy's port; otherwise `403 host not allowed`. This blocks DNS rebinding.
2. **Path:** only `/api/fetch-proxy`; anything else is `404 not found`.
3. **Origin:** `Origin` must be `https://<label>.sliccy.ai`, where `<label>` is one DNS label other than `www`. That covers `seven` and the branch hosts slicc-bios deploys. Origins added with `--origin` (normalized, exact match) are also allowed. A missing or other origin is `403 origin not allowed`, sent **without** CORS headers.
4. **Preflight:** an `OPTIONS` from an allowed origin is answered `204` with:
   - `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`
   - `Access-Control-Allow-Methods: POST, OPTIONS`
   - `Access-Control-Allow-Headers: Content-Type, X-Bridge-Token, X-Slicc-Raw-Request, X-Slicc-Raw-Probe`
   - `Access-Control-Expose-Headers: X-Proxy-Error`
   - `Access-Control-Max-Age: 600`
   - `Access-Control-Allow-Private-Network: true` when the preflight carries `Access-Control-Request-Private-Network: true` (Private Network Access). Chrome 142 and later asks the user instead (Local Network Access); the header is harmless there.
5. **Method:** anything but `POST` is `405 method not allowed`, with `Allow: POST, OPTIONS`.
6. **Key:** `X-Bridge-Token` must equal the key, compared in constant time; otherwise `403 proxy key missing or wrong`. The key is never accepted in a query string.

From step 5 on, every answer carries `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers` and `Vary`, so the page can read refusals.

### Probe

`POST /api/fetch-proxy` with the key and `X-Slicc-Raw-Probe: 1` (and no `X-Slicc-Raw-Request`) fetches nothing and answers `200` JSON:

```json
{ "rawFetch": 1, "requestBodyStreaming": false, "maxRequestBodyBytes": 268435456 }
```

### Request

`POST /api/fetch-proxy` with the key and `X-Slicc-Raw-Request: <json>`. The proxy accepts request heads up to 1 MiB, since every upstream header travels in this one. The JSON is the head to send upstream, with characters past U+007E `\u`-escaped:

```json
{ "url": "https://example.com/", "method": "GET", "headers": [["User-Agent", "curl/8.22.0"], ["Accept", "*/*"]] }
```

- `url` must be `http:` or `https:` and `method` an HTTP token; otherwise `400 malformed X-Slicc-Raw-Request header`. With neither this header nor the probe header, the answer is `400 missing X-Slicc-Raw-Request header`.
- The hop's body is the upstream body, buffered up to 256 MiB, and `413` past that. It is not sent for `GET` and `HEAD`.
- Before sending, the proxy drops hop-by-hop headers (`Connection`, the fields `Connection` names, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) and the ones it owns (`Host`, `Content-Length`, `Accept-Encoding`, `Expect`). It joins repeated names with `, `, except `Cookie`, which joins with `; `.
- It sets `Accept-Encoding: gzip, deflate, br` (the codings it decodes), or nothing for a request with `Range` or `If-Range`, so ranged bodies stay unencoded.
- Redirects are not followed.

### Response

Once the upstream answers, the proxy answers `200` with `Content-Type: application/vnd.slicc.raw-fetch` and `Cache-Control: no-store`. The body is:

1. a big-endian `u32` length;
2. that many bytes of UTF-8 JSON, `{ "status", "statusText", "headers": [[name, value], …], "url" }`. The headers are the upstream's in order, each `Set-Cookie` its own entry, without hop-by-hop headers;
3. the upstream body, streamed until the hop ends. It is decoded: when the proxy undid every listed coding, it drops `Content-Encoding` and `Content-Length`. A response without a body (`HEAD`, `1xx`, `204`, `205`, `304`) keeps both as sent and has no bytes after the head.

If the upstream cannot be reached, the answer is `502 fetch failed: <reason>`. A `206` with a coding the proxy decoded is also `502`, because its `Content-Range` would no longer match the bytes. If the upstream breaks mid-body, the proxy drops the hop's connection.

## The rest of node-server

SLICC's `packages/node-server` (about 12k lines in `src/`) does much more than this proxy. Here is what it does, in the order proposed for moving it:

1. **CDP bridge** (`index.ts` `/cdp`, `cdp-proxy/`, `chrome-launch.ts`, `browser-shutdown.ts`): it launches Chrome and proxies CDP to the page over a WebSocket. The same origin and key gate applies, with the key in `Sec-WebSocket-Protocol: slicc.bridge.v1.<key>`. This one goes next, for ai-ecoverse/slicc-cdp.
2. **Host folders** (`hostfs.ts`, `hostfs-watch.ts`, `--mount`): serves local directories over `/api/hostfs`, with invalidations over `/licks-ws`. This is what makes a laptop folder usable from the shell.
3. **Secrets** (`secrets/`, `routes/secrets.ts`, `routes/oauth-callback.ts`, `sudo/`): masked secrets unmasked per domain in the default `/api/fetch-proxy`, HMAC signing, OAuth replicas and the sudo prompt. Raw mode here leaves secrets out; they come back with this step.
4. **Licks and handoff** (`routes/lick-*.ts`, `routes/handoff.ts`, `links-middleware.ts`, `routes/agent-activity.ts`): webhooks and events into the agent, plus activity tracking.
5. **Cloud and tray** (`cloud/`, `cloud-status.ts`, `hosted-*.ts`, `leader-restart.ts`): e2b sandboxes, hosted leaders and the tray hub.
6. **Electron** (`electron-*.ts`): attaching SLICC to Electron apps as leader or followers.
7. **Packaging** (`release-package*.ts`, `publish-chrome-web-store*.ts`, `install-cli.ts`, `qa-setup.ts`): these belong to the repos they package, not here.

Node ≥ 24. `npm run lint` runs `slicc-lint`, `npm test` the integration tests, and `npm run test:unit` the local unit tests. Each `feat` or `fix` on `main` is released by semantic-release.
