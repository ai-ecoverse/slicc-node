# slicc-node

SLICC's local proxy for Node. It gives the new SLICC on `*.sliccy.ai` full network access: the page's kernel sends every request a program makes (`curl`, `git`, `npm`) to this process on loopback, which fetches it without CORS.

```bash
npx @ai-ecoverse/slicc-node
```

This starts the proxy on `127.0.0.1:17117` with its proxy key and opens `https://seven.sliccy.ai/#proxy=…&key=…`. The page passes both to `localProxyTransport({ url, key })` from [`@ai-ecoverse/slicc-kernel`](https://github.com/ai-ecoverse/slicc-kernel). The first time, Chrome asks whether the page may reach apps on this device (Local Network Access); allow it. Stop it with `^C`. The key and port stay the same when it starts again, after an update, a crash or a reboot, so an open SLICC page reconnects without a new launch URL (see [Restarts](#restarts)).

| option | |
| --- | --- |
| `--page <url>` | page to open, default `https://seven.sliccy.ai/`; its origin is allowed too |
| `--port <n>` | port on `127.0.0.1`, default `17117` (any free port with `--ephemeral`) |
| `--origin <url>` | also allow this origin (repeatable), for a page served locally |
| `--mount <path>[:<name>][:ro]` | share a folder with the page (repeatable), under `<name>` (default: its basename), read-only with `:ro`; see [Host folders](#host-folders) |
| `--kernel-port <n>` | port on `127.0.0.1` for `http://<port>.kernel.localhost/`, default `80`; see [Kernel services](#kernel-services) |
| `--no-kernel` | do not serve the page's kernel on `<port>.kernel.localhost` |
| `--cdp <url>` | relay `/cdp` to a browser already listening at this HTTP debugging URL, such as `http://127.0.0.1:9222` |
| `--rotate-key` | replace the stored key, so pages and launch URLs holding the old one stop working |
| `--ephemeral` | use a fresh key and any free port, and store nothing: the key dies with the process |
| `--no-open` | print the URL without opening a browser |
| `--quiet` | do not log proxied requests to stderr |

```js
import { launchUrl, startProxy } from '@ai-ecoverse/slicc-node';

const proxy = await startProxy({ port: 0, origins: ['http://localhost:8787'] });
console.log(launchUrl('https://seven.sliccy.ai/', proxy));
await proxy.close();
```

`startProxy` mints a fresh key unless given one; `persistentKey({ dir, rotate, warn })` returns the stored one, creating it if needed, and `configDir()` names the directory. `startProxy` also takes `key`, `portFallback` (listen on any free port when `port` is taken), `host`, `fetch`, `maxRequestBody`, `log`, `mounts` (the `--mount` values), `warn`, `hostfsIdle`, `kernelPort` (default `80`, `null` for off), `kernelOpenTimeout` (ms, default 10 s), `cdp` (HTTP debugging URL of a browser already running) and `cdpReconnectDelay` (ms, default 1 s), and resolves with `{ url, key, server, kernelPort, close() }`. `kernelPort` is `null` when the listener is off or could not bind.

## Protocol

This is the contract a local proxy implements, so slicc-node and [slicc-swift](https://github.com/ai-ecoverse/slicc-swift) behave alike. It is raw mode of SLICC's `/api/fetch-proxy` (`packages/shared-ts/src/raw-fetch-protocol.ts`), with the security of its standalone bridge (`packages/node-server/src/bridge-security.ts`). The client is `localProxyTransport` in slicc-kernel.

### Launch

- The proxy listens on loopback only. Its key is 32 random bytes, base64url (43 characters), kept across restarts as described in [Restarts](#restarts).
- It opens the page with both in the **fragment**, which never reaches a server: `https://seven.sliccy.ai/#proxy=http%3A%2F%2F127.0.0.1%3A54321&key=<key>`, form-encoded (`URLSearchParams`). The page keeps them, strips them from the address bar and falls back to `fetchTransport()` once `probeLocalProxy` returns `null`.

### Restarts

The page stores `{ url, key }` from the launch fragment. A local proxy keeps both valid across restarts, so after an update, a crash or a reboot the page reconnects on its own: network through the same proxy, [host folders](#host-folders) by asking for new tokens, and the [kernel tunnel](#kernel-services) with the same key.

- **Key file.** The key lives in `key` in the config directory: `$XDG_CONFIG_HOME/slicc-node` when that is set, else `~/Library/Application Support/slicc-node` on macOS, `%APPDATA%\slicc-node` on Windows and `~/.config/slicc-node` elsewhere. It is created on first run, mode `0600` in a `0700` directory, and published whole (written aside, then linked in), so two first starts at once agree on one key. A file or directory open to others is set back to `0600` or `0700` with a warning. A file without a key gets a new one, also with a warning. The key keeps websites out; any process running as the user could already read the user's files, so a `0600` file doesn't change who is trusted.
- **Port.** The default is `17117`. If it is taken, for example by a second slicc-node, the proxy warns and takes any free port; pages from an earlier launch can't reconnect to that one. A port given with `--port` that is taken stops slicc-node.
- **Host folders** are only as persistent as the command line: pass the same `--mount` options again, and the kernel's driver re-grants each folder by name when its old token answers `403`. Tokens never survive a restart.
- `--rotate-key` writes a new key, so every page and launch URL with the old one is refused. `--ephemeral` keeps the old behaviour: a fresh key, any free port, nothing stored.

### Gate

Every request to the proxy passes these checks in order. Each refusal is a JSON `{ "error": "<reason>" }` with `X-Proxy-Error: 1`.

1. **Host:** `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the proxy's port; otherwise `403 host not allowed`. This blocks DNS rebinding.
2. **Path:** `/api/fetch-proxy` (`POST`), `/api/oauth-state` (`POST`, `DELETE`), `/api/oauth-result` (`GET`) and the [host folder](#host-folders) paths, each refusing other methods with `405`; `/api/kernel-tunnel` and `/cdp` take only a WebSocket upgrade (see [Kernel services](#kernel-services) and [Browser debugging](#browser-debugging)), and so does no other path; `/auth/callback` skips the rest of the gate (see [Sign-in callback](#sign-in-callback)); anything else is `404 not found`.
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

With at least one folder exported, it adds `"hostfs": 1`. With the [kernel listener](#kernel-services) up, it adds `"kernelTunnel": 1, "kernelPort": <port>`. With a [browser debugging URL](#browser-debugging), it adds `"cdp": 1`.

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
                          "caseInsensitive": true, "normalization": "nfd-insensitive",
                          "ranges": true } }
```

- A token reaches only its folder, and only from the origin that was granted it. `readonly: true`, or an export marked `:ro`, makes every write `EROFS`.
- A token lives in memory until `DELETE /api/hostfs/grant` with `{ "token" }`, until the process exits, or until 5 minutes pass with no request and no open watch stream. Its file handles die with it. A dead or unknown token is `403` with `X-Proxy-Error: 1`, and the kernel asks for a new one once.
- Tokens are never accepted in a query string and never logged. They are kept by their SHA-256.
- `caseInsensitive` is probed on the folder's volume; `normalization` is `nfd-insensitive` on macOS and `none` elsewhere.
- `ranges: true` says `setattr` takes `size`, so the kernel reads and writes in pages. A proxy without it is used whole-file.
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
| `setattr` | `path`, `size?`, `mode?`, `mtime?` (ms) | `{}`; `size` truncates or extends with zeros, like `truncate(2)`, then `mode` and `mtime` apply; `size` on a directory is `EISDIR`, `size` or `mode` on a symlink is `EINVAL` |
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

### Kernel services

The page's kernel runs servers too: vite, `python -m http.server`, impeccable live. From the page, `localhost` stays the real machine and a kernel port `N` is `http://N.kernel.localhost/`. seven's service worker routes its own pages' subresources there through `kernel.loopbackFetch`, but it cannot carry top-level navigations or WebSockets (vite HMR). `*.kernel.localhost` resolves to loopback, so a local listener carries them through a tunnel into the page, which calls `kernel.dial({ port: N })` ([slicc-kernel#103](https://github.com/ai-ecoverse/slicc-kernel/issues/103)). Each kernel port is its own origin, isolated from seven's.

**Listener.**
- It listens on `127.0.0.1:80` by default (unprivileged on macOS); `--kernel-port` picks another, and then URLs carry it: `http://8400.kernel.localhost:8080/`.
- If the port cannot be bound, for example because something on the machine already uses `:80` or Linux refuses an unprivileged bind, slicc-node prints `kernel services are off: … try --kernel-port` and runs on without it. The probe then leaves out `kernelTunnel`. seven still reaches kernel servers for subresources through its service worker, but navigations and WebSockets to `*.kernel.localhost` find nothing, so pass `--kernel-port 8080` (or any free port).
- It reads the first request head (64 KiB at most, within 30 s) and takes exactly one `Host` of the form `<1–65535>.kernel.localhost`. The host may carry no port or the listener's own port; no leading zeros and no trailing dot. It then opens a stream to that kernel port, sends what it has read and pipes bytes both ways without parsing anything else. Keep-alive, chunked bodies and WebSocket upgrades pass through as they are.
- A connection belongs to the host of its first request. Browsers pool HTTP/1.1 connections per host and port, so no other origin writes into it.

**Errors** are plain text with `X-Proxy-Error: 1` and `Connection: close`:

| case | answer |
| --- | --- |
| `Host` not `<port>.kernel.localhost` | `421` |
| malformed request line, or not exactly one `Host` | `400` |
| head over 64 KiB | `431` |
| no page connected | `502 no seven page connected` |
| the page answers `RESET` with `ECONNREFUSED` | `502 nothing listening on kernel port N` |
| the page answers `RESET` with another reason | `502 kernel port N: <reason>` |
| no `OPENED` within 10 s | `504 kernel port N did not answer` |

The browser's connection waits for `OPENED` unread, so a browser that gives up meanwhile is noticed when the dial completes or times out.

**Tunnel.** The page opens a WebSocket to `ws://127.0.0.1:<proxy port>/api/kernel-tunnel` with the subprotocols `slicc.kernel-tunnel.v1` and `slicc.key.<key>`, since a browser cannot set headers on a WebSocket. Before upgrading, the proxy checks the loopback `Host` (`403 host not allowed`), the path and that the listener is up (`404`), the `Origin` as in [Gate](#gate) (`403 origin not allowed`), that `slicc.kernel-tunnel.v1` is offered (`400`) and the key in constant time (`403 proxy key missing or wrong`). It selects `slicc.kernel-tunnel.v1`, so the key is never echoed.

Every message is binary (a text message closes the tunnel with `1003`): a `u8` type, a big-endian `u32` stream id, then the payload. slicc-node opens every stream and numbers them from 1, never reusing an id.

| type | direction | payload |
| --- | --- | --- |
| `1` OPEN | slicc-node → page | `u16` BE kernel port |
| `2` OPENED | page → slicc-node | empty: the dial succeeded |
| `3` DATA | both | 1 to 65 536 bytes |
| `4` END | both | empty: the sender half-closes (`SHUT_WR`) |
| `5` RESET | both | UTF-8 reason, such as `ECONNREFUSED`; aborts both directions |
| `6` CREDIT | both | `u32` BE count of bytes consumed, at least 1 |

- **Flow control:** each side may have at most 256 KiB of DATA per stream and direction that the other has not credited. The receiver credits bytes once it has handed them on: slicc-node when the browser's socket takes them, the page when `writer.write()` resolves. A sender out of window stops reading its source. Without this, one slow tab would stall every stream behind it.
- **Lifecycle:** the page answers OPEN with OPENED or RESET, and DATA flows only after OPENED. A stream ends after END both ways or a RESET from either side. Frames for an unknown id are ignored, since they may cross a RESET.
- **Violations:** DATA or END before OPENED, DATA or END after the page's END, empty DATA, DATA past the window or CREDIT past it reset the stream with `EPROTO`. An unknown type, a short or malformed frame or OPEN from the page closes the tunnel with `1002`, and a message over 65 541 bytes with `1009`. Closing the tunnel resets its streams.
- **Liveness:** slicc-node pings every 15 s and drops a tunnel that misses a pong.
- **The page** calls `kernel.dial({ port })` for each OPEN and sends OPENED, or RESET with the error code. It sends `readable` as DATA and END when it is done, writes DATA to `writable`, closes `writable` on END and calls `close()` on RESET.

**Several tabs.** The most recently connected tunnel takes new streams. When it closes, the one before it that is still open takes over. Open streams stay where they are.

**Security.**
- The `Host` allowlist on the listener defends against DNS rebinding. Only a page holding the key, on an allowed origin, can register a tunnel.
- Kernel services are exposed like any dev server on localhost: any local process can reach them on the kernel port, and so can any web page Chrome lets reach loopback (a public page goes through Local Network Access first). The listener binds `127.0.0.1` even when `startProxy` is given another `host`. Run with `--no-kernel` to keep them inside the page.

### Browser debugging

`--cdp <url>` names an already-running browser's HTTP debugging endpoint, such as `http://127.0.0.1:9222`. slicc-node does not launch the browser and does not listen on another port. The probe then adds `"cdp": 1`.

The page opens `ws://127.0.0.1:<proxy port>/cdp` with the subprotocols `slicc.cdp.v1` and `slicc.key.<key>`, since a browser cannot set headers on a WebSocket. Before upgrading, the proxy checks the loopback `Host` (`403 host not allowed`), the path and that a debugging URL was given (`404`), the `Origin` as in [Gate](#gate) (`403 origin not allowed`), that `slicc.cdp.v1` is offered (`400 subprotocol slicc.cdp.v1 missing`) and the key in constant time (`403 proxy key missing or wrong`). It selects `slicc.cdp.v1`, so the key is never echoed. A key in the query string or in `X-Bridge-Token` is ignored.

Text frames are relayed as they are. The browser socket is `webSocketDebuggerUrl` from `GET <url>/json/version`. One page holds the slot. A second page closes the first with code `4001` and reason `superseded-by-new-cdp-client`, and the first page must not dial again. A frame from a page that has lost the slot is dropped.

When the browser socket closes, the proxy reads `/json/version` again every 1 s until the socket is back or the process stops. Frames sent in the gap are held, at most 1 000, and the oldest is dropped past that. They are forwarded only when they still belong to that same browser connection and that same page. Frames held across the drop are discarded, because the browser has forgotten those sessions. The page that held the slot when the socket died is then closed with code `4002` and reason `upstream-reset`, so it dials again with no cached session ids. A page that connected during the gap is left open, and the frames it held are sent. After three failed attempts the current page is closed once with `4002`, and the proxy keeps reading `/json/version`. `Network.webSocketFrameReceived` and `Network.webSocketFrameSent` are not relayed, and neither is a frame over 64 MiB.

The browser already speaks flattened sessions (`Target.attachToTarget` with `flatten: true`, then a top-level `sessionId`). This proxy does not implement `Target.*`.

## The rest of node-server

SLICC's `packages/node-server` (about 12k lines in `src/`) does much more than this proxy. Here is what it does, in the order proposed for moving it:

1. **CDP bridge**: the `/cdp` relay, the single-client slot and the reconnect are in [Browser debugging](#browser-debugging). Launching Chrome (`chrome-launch.ts`, `browser-shutdown.ts`), secret unmasking, Electron, hosted leaders, cloud status and the tray stay in the monorepo.
2. **Host folders** (`hostfs.ts`, `hostfs-watch.ts`, `--mount`): done, as the new protocol in [Host folders](#host-folders) rather than a port.
3. **Secrets** (`secrets/`, `routes/secrets.ts`, `routes/oauth-callback.ts`, `sudo/`): masked secrets unmasked per domain in the default `/api/fetch-proxy`, HMAC signing, OAuth replicas and the sudo prompt. Raw mode here leaves secrets out; they come back with this step.
4. **Licks and handoff** (`routes/lick-*.ts`, `routes/handoff.ts`, `links-middleware.ts`, `routes/agent-activity.ts`): webhooks and events into the agent, plus activity tracking.
5. **Cloud and tray** (`cloud/`, `cloud-status.ts`, `hosted-*.ts`, `leader-restart.ts`): e2b sandboxes, hosted leaders and the tray hub.
6. **Electron** (`electron-*.ts`): attaching SLICC to Electron apps as leader or followers.
7. **Packaging** (`release-package*.ts`, `publish-chrome-web-store*.ts`, `install-cli.ts`, `qa-setup.ts`): these belong to the repos they package, not here.

Node ≥ 24. `npm run lint` runs `slicc-lint`, `npm test` the integration tests, and `npm run test:unit` the local unit tests. Each `feat` or `fix` on `main` is released by semantic-release.
