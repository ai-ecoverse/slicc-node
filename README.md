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
| `--mount <path>[:<name>][:ro]` | share a folder with the page (repeatable), under `<name>` (default: its basename), read-only with `:ro`; see [Host folders](#host-folders) |
| `--no-open` | print the URL without opening a browser |
| `--quiet` | do not log proxied requests to stderr |

```js
import { launchUrl, startProxy } from '@ai-ecoverse/slicc-node';

const proxy = await startProxy({ port: 0, origins: ['http://localhost:8787'] });
console.log(launchUrl('https://seven.sliccy.ai/', proxy));
await proxy.close();
```

`startProxy` also takes `key`, `host`, `fetch`, `maxRequestBody`, `log`, `mounts` (the `--mount` values), `warn` and `hostfsIdle`, and resolves with `{ url, key, server, close() }`.

## Protocol

This is the contract a local proxy implements, so slicc-node and [slicc-swift](https://github.com/ai-ecoverse/slicc-swift) behave alike. It is raw mode of SLICC's `/api/fetch-proxy` (`packages/shared-ts/src/raw-fetch-protocol.ts`), with the security of its standalone bridge (`packages/node-server/src/bridge-security.ts`). The client is `localProxyTransport` in slicc-kernel.

### Launch

- The proxy listens on loopback only, and mints a fresh key per process: 32 random bytes, base64url (43 characters).
- It opens the page with both in the **fragment**, which never reaches a server: `https://seven.sliccy.ai/#proxy=http%3A%2F%2F127.0.0.1%3A54321&key=<key>`, form-encoded (`URLSearchParams`). The page keeps them, strips them from the address bar and falls back to `fetchTransport()` once `probeLocalProxy` returns `null`.

### Gate

Every request to the proxy passes these checks in order. Each refusal is a JSON `{ "error": "<reason>" }` with `X-Proxy-Error: 1`.

1. **Host:** `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the proxy's port; otherwise `403 host not allowed`. This blocks DNS rebinding.
2. **Path:** `/api/fetch-proxy` (`POST`), `/api/oauth-state` (`POST`, `DELETE`), `/api/oauth-result` (`GET`) and the [host folder](#host-folders) paths, each refusing other methods with `405`; `/auth/callback` skips the rest of the gate (see [Sign-in callback](#sign-in-callback)); anything else is `404 not found`.
3. **Origin:** `Origin` must be `https://<label>.sliccy.ai`, where `<label>` is one DNS label other than `www`. That covers `seven` and the branch hosts slicc-bios deploys. Origins added with `--origin` (normalized, exact match) are also allowed. A missing or other origin is `403 origin not allowed`, sent **without** CORS headers.
4. **Preflight:** an `OPTIONS` from an allowed origin is answered `204` with:
   - `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`
   - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
   - `Access-Control-Allow-Headers: Content-Type, X-Bridge-Token, X-Slicc-Raw-Request, X-Slicc-Raw-Probe, X-Hostfs-Token, X-Hostfs-Request`
   - `Access-Control-Expose-Headers: X-Proxy-Error, X-Hostfs-Errno, ETag, Content-Range`
   - `Access-Control-Max-Age: 600`
   - `Access-Control-Allow-Private-Network: true` when the preflight carries `Access-Control-Request-Private-Network: true` (Private Network Access). Chrome 142 and later asks the user instead (Local Network Access); the header is harmless there.
5. **Method:** each path takes only its own methods (see **Path**); any other is `405 method not allowed`, with `Allow` listing them and `OPTIONS`.
6. **Key:** `X-Bridge-Token` must equal the key (or, on `/api/hostfs`, `/api/hostfs/write` and `/api/hostfs/watch`, `X-Hostfs-Token` must name a live token granted to this origin), compared in constant time; otherwise `403 proxy key missing or wrong`. The key is never accepted in a query string.

From step 5 on, every answer carries `Access-Control-Allow-Origin`, `Access-Control-Expose-Headers` and `Vary`, so the page can read refusals.

### Probe

`POST /api/fetch-proxy` with the key and `X-Slicc-Raw-Probe: 1` (and no `X-Slicc-Raw-Request`) fetches nothing and answers `200` JSON:

```json
{ "rawFetch": 1, "requestBodyStreaming": false, "maxRequestBodyBytes": 268435456 }
```

With at least one folder exported, it adds `"hostfs": 1`.

### Request

`POST /api/fetch-proxy` with the key and `X-Slicc-Raw-Request: <json>`. The proxy accepts request heads up to 1 MiB, since every upstream header travels in this one. The JSON is the head to send upstream, with characters past U+007E `\u`-escaped:

```json
{ "url": "https://example.com/", "method": "GET", "headers": [["User-Agent", "curl/8.22.0"], ["Accept", "*/*"]] }
```

- `url` must be `http:` or `https:` and `method` an HTTP token; otherwise `400 malformed X-Slicc-Raw-Request header`. With neither this header nor the probe header, the answer is `400 missing X-Slicc-Raw-Request header`.
- The hop's body is the upstream body, buffered up to 256 MiB, and `413` past that. It is not sent for `GET` and `HEAD`.
- Before sending, the proxy drops hop-by-hop headers (`Connection`, the fields `Connection` names, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) and the ones it owns (`Host`, `Content-Length`, `Accept-Encoding`, `Expect`), and `Proxy-Authorization`, which is meant for a proxy, not the origin. It joins repeated names with `, `, except `Cookie`, which joins with `; `.
- It sets `Accept-Encoding: gzip, deflate, br` (the codings it decodes), or nothing for a request with `Range` or `If-Range`, so ranged bodies stay unencoded.
- Redirects are not followed.

### Upstream TLS

`startProxy` uses `globalThis.fetch` unless a `fetch` option is passed. Node's fetch verifies HTTPS certificates by default. That is the only check of the real origin: `@ai-ecoverse/wasm-tls-engine` terminates TLS only for the realm's own MITM (kernel proxy ↔ program), not the hop from this process to the origin. Do not pass a `fetch` that turns verification off, and do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### Response

Once the upstream answers, the proxy answers `200` with `Content-Type: application/vnd.slicc.raw-fetch` and `Cache-Control: no-store`. The body is:

1. a big-endian `u32` length;
2. that many bytes of UTF-8 JSON, `{ "status", "statusText", "headers": [[name, value], …], "url" }`. The headers are the upstream's in order, each `Set-Cookie` its own entry, without hop-by-hop headers;
3. the upstream body, streamed until the hop ends. It is decoded: when the proxy undid every listed coding, it drops `Content-Encoding` and `Content-Length`. A response without a body (`HEAD`, `1xx`, `204`, `205`, `304`) keeps both as sent and has no bytes after the head.

If the upstream cannot be reached, the answer is `502 fetch failed: <reason>`. A `206` with a coding the proxy decoded is also `502`, because its `Content-Range` would no longer match the bytes. If the upstream breaks mid-body, the proxy drops the hop's connection.

### Sign-in callback

Some identity providers allowlist only one redirect target. Adobe IMS, for example, redirects only to `https://www.sliccy.ai/auth/callback`, a relay that forwards the implicit-flow result to `http://localhost:<port>/auth/callback` when the OAuth `state` asks for it (`{ source: 'local', port, path: '/auth/callback', nonce }`). A local proxy hands that result to the page:

1. **Register:** before opening the sign-in popup, the page sends `POST /api/oauth-state` with the key and `{ "nonce": "<16–128 url-safe characters>" }`. This passes the same gate as `/api/fetch-proxy` (host, origin, key) and answers `204`. The proxy remembers the nonce with the page's `Origin` for 10 minutes.
2. **Callback:** the relay's redirect lands on `GET /auth/callback?nonce=…#access_token=…`. Only the host check applies, because a top-level navigation carries no `Origin`. Each nonce gets this page once; an unknown, used or expired nonce gets a `403` page. The page removes the fragment from its address and sends `{ nonce, redirectUrl }` back to its own origin with `POST /auth/callback`. The proxy takes that only from `Origin: http://localhost:<port>` (or another loopback name with its port), only after the page was served, only once, and only when `redirectUrl` carries the same nonce. The page's CSP allows its one inline script by hash and `connect-src 'self'`, and nothing else.
3. **Collect:** the page that registered the nonce polls `GET /api/oauth-result?nonce=…` through the same gate as `/api/fetch-proxy`. The answer is `204` while the sign-in is pending and `200 { "redirectUrl": … }` once. After that, and for an unknown or expired nonce or another origin, it is `404`. `DELETE /api/oauth-state?nonce=…` drops a sign-in the page cancelled.
4. **No opener:** SLICC pages are cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`), so a popup that navigated to the identity provider has no `window.opener`. Polling works anyway.
5. **The token is kept only in memory.** It is deleted on the first `200` or by a timer when the nonce expires after 10 minutes, whichever comes first, even if nothing else reaches the proxy. It is never written to disk, and no log line or error message includes it.

Chrome's Local Network Access doesn't apply to the popup's top-level navigation to `localhost`.

### Host folders

hostfs mounts a folder from the user's machine in the kernel ([slicc-kernel#84](https://github.com/ai-ecoverse/slicc-kernel/issues/84)), with no File System Access picker and no size cap. The client is slicc-kernel's `hostfs` mount driver, which runs in the kernel worker. The design is [#13](https://github.com/ai-ecoverse/slicc-node/issues/13).

**Export.** `--mount <path>[:<name>][:ro]` exports a folder. Its root is `realpath`'d at start; a missing path or a file is skipped with a warning, and so is a name that is taken. Names never reveal host paths.

| path | methods | auth |
| --- | --- | --- |
| `/api/hostfs/grant` | `POST`, `DELETE` | `X-Bridge-Token` |
| `/api/hostfs/mounts` | `POST` | `X-Bridge-Token` |
| `/api/hostfs` | `POST` | `X-Hostfs-Token` |
| `/api/hostfs/write` | `PUT` | `X-Hostfs-Token` |
| `/api/hostfs/watch` | `POST` | `X-Hostfs-Token` |

Each path is one fixed URL, so one preflight per path covers the `Access-Control-Max-Age` window.

**Tokens.** The page holds the key and asks for a token scoped to one folder:

```
POST /api/hostfs/grant            X-Bridge-Token: <key>
{ "mount": "project", "readonly": false }
→ 200 { "token": "<43 chars>", "mount": "project", "readonly": false,
        "capabilities": { "maxIo": 16777216, "symlinks": true, "chmod": true,
                          "caseInsensitive": true, "normalization": "nfd-insensitive" } }
```

- A token reaches only its folder, and only from the origin that was granted it. `readonly: true`, or an export marked `:ro`, makes every write `EROFS`.
- A token lives in memory until `DELETE /api/hostfs/grant` with `{ "token" }`, until the process exits, or until 5 minutes pass with no request and no open watch stream. Its file handles die with it. A dead or unknown token is `403` with `X-Proxy-Error: 1`, and the kernel asks for a new one once.
- Tokens are never accepted in a query string and never logged. They are kept by their SHA-256.
- `caseInsensitive` is probed on the folder's volume; `normalization` is `nfd-insensitive` on macOS and `none` elsewhere.
- `POST /api/hostfs/mounts` answers `[{ "name", "readonly" }]`.

**Paths** are relative to the folder, `/`-separated, with `""` for the root. `..`, a leading `/` and NUL are refused (`EACCES`, `EINVAL`). Every operation resolves the parent with `realpath` and refuses it outside the folder (`EACCES`), and treats the last component with lstat semantics: the kernel follows symlinks itself, so `open` on a symlink is `ELOOP`. Operations that change the namespace run one at a time, and others never run alongside them, so a page cannot swap a directory for a symlink between the check and the use.

**Operations:** `POST /api/hostfs` with a JSON body of at most 1 MiB, `{ "op", … }`:

| op | body | answer |
| --- | --- | --- |
| `stat` | `path` | `attr` |
| `list` | `path` | `{ "entries": [{ "name", "attr" }] }`; an entry that vanishes meanwhile is left out |
| `mkdir` | `path` | `{}`; not recursive |
| `rmdir` | `path` | `{}` |
| `unlink` | `path` | `{}`; `EISDIR` for a directory |
| `rename` | `from`, `to` | `{}`, `rename(2)`; a directory onto a non-empty one is `ENOTEMPTY` |
| `symlink` | `target`, `path` | `{}`; `target` is stored as given |
| `readlink` | `path` | `{ "target" }` |
| `setattr` | `path`, `mode?`, `mtime?` (ms) | `{}`; `mode` on a symlink is `EINVAL` |
| `statfs` | | `{ "bsize", "blocks", "bfree", "bavail" }` |
| `open` | `path`, `write?`, `create?`, `truncate?`, `exclusive?`, `mode?` | `{ "fh", "attr" }` |
| `read` | `fh`, `offset`, `size` (≤ `maxIo`), `ifMatch?` | the bytes, with `ETag` and `Content-Range`; short at EOF, empty past it |
| `release` | `fh` | `{ "attr" }` for a write handle, `{}` otherwise |

The root can't be removed or renamed (`EBUSY`). `attr` is `{ "kind": "file"|"directory"|"symlink", "size", "mtime" (ms), "mode" (permission bits), "ino", "etag" }`, and `etag` is `"<size>-<mtimeNs>-<ino>"`.

**Reads.** A handle opened without `write`, `create`, `truncate` or `exclusive` is a name, and holds nothing open between calls. Each `read` opens the file again, and when `ifMatch` differs from the file's current etag it answers `ESTALE`, so the kernel restarts instead of mixing two versions. `read` on a write handle reads its descriptor and ignores `ifMatch`.

**Writes happen in place,** like `open(2)`: `create`, `exclusive` (with `create`), `truncate` and `mode` (default `0666` minus the umask) apply at `open`, and the errors come back there. Each chunk is a `pwrite` into the real file:

```
PUT /api/hostfs/write             X-Hostfs-Token: <token>
X-Hostfs-Request: {"fh": 7, "offset": 33554432}
<at most maxIo bytes>
→ 200 {}
```

The body streams to disk with bounded memory, in any order and with holes. `release` closes the descriptor. Writing in place keeps hard links, extended attributes, ACLs and ownership, and costs nothing for a small change to a large file. Programs that want atomic replacement already write a temporary file and rename it, and those are hostfs operations too. A dropped connection leaves what was written, as a crashed local process would.

**Watch.** `POST /api/hostfs/watch` answers `200 application/x-ndjson` and keeps streaming lines:

```
{"mount": "project", "paths": ["src/a.ts", "src"]}
{"mount": "project", "all": true}
{"ping": 1}
```

- `paths` name what changed and its parent directory, coalesced over 50 ms. Past 256 paths the line is `all`. A watcher that fails or cannot start retries every second, and sends one `all` when it is lost and one when it is back.
- A ping goes out every 15 s. The stream ends only when a token it carries is revoked or expires, or when the proxy stops. The kernel reconnects once at once, and goes `nomedium` only when that fails.
- `X-Hostfs-Token` may list several tokens, comma-separated, so one stream serves every mount. Chrome allows six HTTP/1.1 connections per host and port, shared by the page and its workers.
- Changes the kernel made itself come back too.

**Errors.** A file system error carries `X-Hostfs-Errno: <name>` and the body `{ "errno", "message" }`. The message never contains a host path.

| errno | status |
| --- | --- |
| `ENOENT` | 404 |
| `EACCES`, `EPERM`, `EROFS` | 403 |
| `EEXIST`, `ENOTEMPTY`, `EISDIR`, `ENOTDIR`, `EBUSY`, `ESTALE` | 409 |
| `EINVAL`, `ENAMETOOLONG`, `ELOOP` | 400 |
| `EBADF` | 410 |
| `ENOSPC`, `EFBIG` | 507 |
| anything else (`EIO`, `EMFILE`, …) | 500 |

**Local Network Access.** The page's permission covers its dedicated worker. In Chromium 153, a public page without it reaches loopback neither from the page nor from a worker; once the user allows it, the worker's hostfs calls, the `PUT` and the watch stream all go through (`test/integration/lna.test.mjs`).

## The rest of node-server

SLICC's `packages/node-server` (about 12k lines in `src/`) does much more than this proxy. Here is what it does, in the order proposed for moving it:

1. **CDP bridge** (`index.ts` `/cdp`, `cdp-proxy/`, `chrome-launch.ts`, `browser-shutdown.ts`): it launches Chrome and proxies CDP to the page over a WebSocket. The same origin and key gate applies, with the key in `Sec-WebSocket-Protocol: slicc.bridge.v1.<key>`. This one goes next, for ai-ecoverse/slicc-cdp.
2. **Host folders** (`hostfs.ts`, `hostfs-watch.ts`, `--mount`): done, as the new protocol in [Host folders](#host-folders) rather than a port.
3. **Secrets** (`secrets/`, `routes/secrets.ts`, `routes/oauth-callback.ts`, `sudo/`): masked secrets unmasked per domain in the default `/api/fetch-proxy`, HMAC signing, OAuth replicas and the sudo prompt. Raw mode here leaves secrets out; they come back with this step.
4. **Licks and handoff** (`routes/lick-*.ts`, `routes/handoff.ts`, `links-middleware.ts`, `routes/agent-activity.ts`): webhooks and events into the agent, plus activity tracking.
5. **Cloud and tray** (`cloud/`, `cloud-status.ts`, `hosted-*.ts`, `leader-restart.ts`): e2b sandboxes, hosted leaders and the tray hub.
6. **Electron** (`electron-*.ts`): attaching SLICC to Electron apps as leader or followers.
7. **Packaging** (`release-package*.ts`, `publish-chrome-web-store*.ts`, `install-cli.ts`, `qa-setup.ts`): these belong to the repos they package, not here.

Node ≥ 24. `npm run lint` runs `slicc-lint`, `npm test` the integration tests, and `npm run test:unit` the local unit tests. Each `feat` or `fix` on `main` is released by semantic-release.
