import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

export async function upstream() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === '/moved') {
      res.writeHead(302, { Location: '/target', 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end();
    } else if (req.url === '/gzip') {
      const body = gzipSync('decoded by the proxy\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'gzip',
        'Content-Length': body.byteLength,
      });
      res.end(body);
    } else if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let left = 64;
      const tick = () => {
        if (left-- === 0) return res.end();
        res.write(Buffer.alloc(16 * 1024, 120), () => setImmediate(tick));
      };
      tick();
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': 5,
        'X-Upstream': 'yes',
      });
      res.end(req.method === 'HEAD' ? undefined : 'hello');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
