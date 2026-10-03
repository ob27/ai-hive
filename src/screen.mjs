import http from 'node:http';
import net from 'node:net';
import { joinPage } from './joinpage.mjs';

// A "Join" button floating over Pixel Agents' own page. Pixel Agents' UI is a prebuilt bundle we don't edit, so
// the host fronts it as a small reverse proxy and injects this into the one HTML document it serves.
const BUTTON = `
<a id="office-join" href="/join-page">+ Join the office</a>
<style>
  #office-join { position: fixed; top: 10px; right: 10px; z-index: 2147483647; background: #2a2a4a; color: #fff;
    border: 2px solid #5a5a8a; padding: 8px 12px; font: 14px/1 ui-monospace, Menlo, Consolas, monospace;
    text-decoration: none; box-shadow: 2px 2px 0 #0008; }
  #office-join:hover { background: #3a3a6a; border-color: #7ee0a0; }
</style>`;

/** Public screen port → Pixel Agents on a private local port, plus /join-page and the injected button. */
export function startScreen({ port, inner, ingest }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/join-page') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(joinPage({ ingest }));
    }
    const headers = { ...req.headers };
    delete headers['accept-encoding']; // we may need to rewrite the HTML, so ask for it uncompressed
    if ((headers.accept ?? '').includes('text/html')) { delete headers['if-none-match']; delete headers['if-modified-since']; }
    const up = http.request({ host: '127.0.0.1', port: inner, path: req.url, method: req.method, headers }, (r) => {
      if (!(r.headers['content-type'] ?? '').startsWith('text/html')) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace('</body>', `${BUTTON}</body>`);
        const h = { ...r.headers, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' };
        delete h.etag; delete h['last-modified'];
        res.writeHead(r.statusCode, h).end(html);
      });
    });
    up.on('error', () => res.writeHead(502).end('office is starting…'));
    req.pipe(up);
  });

  // The live office updates arrive over a WebSocket: tunnel the upgrade straight through, bytes untouched.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(inner, '127.0.0.1', () => {
      const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(port, '0.0.0.0');
  return server;
}
