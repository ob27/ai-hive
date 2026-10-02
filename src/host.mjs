import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

const PIXEL_AGENTS = 'pixel-agents@1.4.1';
const dir = join(homedir(), '.workspace-office');
const hostFile = join(dir, 'host.json');

/** The shared key is what the host hands to CLI users. It is stable across restarts (unlike
 *  Pixel Agents' own per-boot token, which never leaves this machine). */
export function loadKey({ rotate = false } = {}) {
  if (!rotate && existsSync(hostFile)) return JSON.parse(readFileSync(hostFile, 'utf8')).key;
  const key = randomBytes(16).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile, JSON.stringify({ key }, null, 2), { mode: 0o600 });
  return key;
}

const lanIp = () => Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '<this-machine-ip>';

// Pixel Agents registers {port, token} under ~/.pixel-agents/servers/ on every boot.
function pixelAgentsToken(port) {
  const d = join(homedir(), '.pixel-agents', 'servers');
  try {
    for (const f of readdirSync(d)) {
      const reg = JSON.parse(readFileSync(join(d, f), 'utf8'));
      if (reg.port === port && reg.servesSpa) return reg.token;
    }
  } catch { /* not up yet */ }
  return null;
}

async function waitForToken(port, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const token = pixelAgentsToken(port);
    if (token) return token;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Pixel Agents did not start (is Node >= 20 and npm reachable?)');
}

// Seats are only adopted when "Watch All Sessions" is on; flip it so hosts don't have to.
function enableWatchAll(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'setWatchAllSessions', enabled: true })); setTimeout(() => ws.close(), 500); };
  ws.onerror = () => console.error('office host: could not enable Watch All Sessions — turn it on in the UI settings');
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startHost({ port = 3100, ingest = 3101, rotate = false } = {}) {
  const key = loadKey({ rotate });
  const child = spawn('npx', ['-y', PIXEL_AGENTS, '--host', '0.0.0.0', '--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGINT', () => { child.kill(); process.exit(0); });

  const token = await waitForToken(port);
  enableWatchAll(port, token);

  // Ingest shim: only the hook endpoint is exposed here, and only with the shared key.
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    const auth = req.headers.authorization ?? '';
    if (req.method !== 'POST' || !req.url.startsWith('/api/hooks/')) return res.writeHead(404).end();
    if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
    const out = http.request(
      { host: '127.0.0.1', port, path: req.url, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pixelAgentsToken(port) ?? token}` } },
      (up) => { res.writeHead(up.statusCode); up.pipe(res); },
    );
    out.on('error', () => res.writeHead(502).end());
    req.pipe(out);
  }).listen(ingest, '0.0.0.0');

  const ip = lanIp();
  console.log(`\nOffice is open.\n  Big screen:  http://${ip}:${port}/\n  Join with:   office join ${ip}:${ingest} <name> --key ${key}\n`);
}
