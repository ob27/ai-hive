import http from 'node:http';
import { handleAdmin, handleHiveRead, handleHumanBuzz, handleJoinRedirect, handleMode } from './hive-http.mjs';
import { joinPage } from './joinpage.mjs';

/** The public screen port: the Hive wall (at /hive/, and / goes there), its read and chat routes, the Join page, and the keyed cog actions. */
export function startScreen({ port, ingest, prefillKey = null, hive = null, uiDir = null, buzz = null, info = {}, mode = null, key = null, monitor = null }) {
  const server = http.createServer((req, res) => {
    monitor?.track(req, res, 'screen');
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/') return void res.writeHead(302, { location: '/hive/' }).end();
    if (hive && key && (handleMode(req, res, mode, key) || handleAdmin(req, res, { hive, buzz, key }))) return;
    if (hive && ((buzz && handleHumanBuzz(req, res, buzz, hive)) || handleHiveRead(req, res, hive, uiDir, buzz, info))) return; // /hive, /hive/state, /hive/stream: the Hive wall
    if (uiDir && handleJoinRedirect(req, res, uiDir)) return; // the Join page in the Hive screen; the plain page below is the fallback
    if (req.method === 'GET' && path === '/join-page') {
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(joinPage({ ingest, key: prefillKey }));
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
  });
  server.listen(port, '0.0.0.0');
  return server;
}
