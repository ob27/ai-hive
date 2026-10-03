import { execSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapScript, cliFiles } from './bootstrap.mjs';

const PIXEL_AGENTS = 'pixel-agents@1.4.1';
const dir = join(homedir(), '.workspace-office');
const hostFile = join(dir, 'host.json');

// Pixel Agents auto-detects every local Claude Code session by scanning ~/.claude/projects and labels each
// one with its project folder. We want only agents that `office join`, with proper names, so the host runs
// Pixel Agents under a private home directory: nothing to scan, nothing auto-detected, layout/settings kept.
const paHome = join(dir, 'pixel-home');

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
  const d = join(paHome, '.pixel-agents', 'servers');
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
  ws.onopen = () => { for (const type of ['setWatchAllSessions', 'setAlwaysShowLabels']) ws.send(JSON.stringify({ type, enabled: true })); setTimeout(() => ws.close(), 500); };
  ws.onerror = () => console.error('office host: could not enable Watch All Sessions — turn it on in the UI settings');
}

// Pixel Agents does not replay a hooks-only seat's current activity to a viewer that connects late, so a
// TV opened (or reloaded) after a chirp shows that seat idle. The host remembers each seat's latest
// activity and re-sends it periodically; seats silent for GHOST_MS are ended so crashed agents don't linger.
const REPLAY_MS = 10_000;
const GHOST_MS = 30 * 60_000;

function trackSeats(forward) {
  const seats = new Map(); // session_id -> { lastSeen, pre }
  return {
    observe(p) {
      const id = p.session_id;
      if (!id) return false;
      if (p.hook_event_name === 'SessionEnd') return void seats.delete(id);
      const known = seats.has(id);
      const seat = seats.get(id) ?? { lastSeen: 0, pre: null };
      seat.lastSeen = Date.now();
      if (p.cwd?.startsWith('/office/')) seat.name = p.cwd.slice('/office/'.length);
      if (p.hook_event_name === 'PreToolUse') seat.pre = p;
      else if (p.hook_event_name === 'PostToolUse' || p.hook_event_name === 'Stop') seat.pre = null;
      seats.set(id, seat);
      return !known; // true → first time this host has heard from the seat
    },
    names: () => [...new Set([...seats.values()].map((x) => x.name).filter(Boolean))],
    start() {
      setInterval(() => {
        for (const [id, seat] of seats) {
          if (Date.now() - seat.lastSeen > GHOST_MS) {
            forward({ session_id: id, hook_event_name: 'SessionEnd', cwd: seat.pre?.cwd, reason: 'other' });
            seats.delete(id);
          } else if (seat.pre) {
            forward({ ...seat.pre, hook_event_name: 'PostToolUse' });
            forward(seat.pre);
          }
        }
      }, REPLAY_MS).unref();
    },
  };
}

// os.hostname() can be a router-assigned name (e.g. "Mac.mymodem"); macOS's Bonjour name is the stable one.
function stableName() {
  try {
    if (process.platform === 'darwin') return `${execSync('scutil --get LocalHostName', { encoding: 'utf8' }).trim()}.local`;
  } catch { /* fall through */ }
  return hostname().endsWith('.local') ? hostname() : null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What an agent reads to get going: where to join, then the behaviour rules from agent.md.
function agentInstructions(base, key) {
  const rules = readFileSync(join(repoRoot, 'agent.md'), 'utf8').split('## One line for your system prompt')[0];
  return `# Take a seat in the workspace office

Office: ${base}

## 1. Join (once, first)

Run this exactly:

    curl -s ${base}/join | node - join --key ${key}

It prints the name you were given and a \`Report as <name> with: …\` command. Use exactly that command (with
\`respond\`, \`say\` or \`idle\` after it) for everything below — your shell does not remember anything
between calls, so don't rely on \`export\`. If you are Claude Code and the user wants hooks, add \`--claude\`
to the join (then tool use and "responding to <user>" are reported for you and you can skip steps 2–3).
If the join fails, tell the user and carry on with their task.

## 2. Behave

${rules.replace(/^# agent\.md.*\n/, '')}`;
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startHost({ port = 3100, ingest = 3101, rotate = false } = {}) {
  const key = loadKey({ rotate });
  mkdirSync(paHome, { recursive: true });
  const env = { ...process.env, HOME: paHome, USERPROFILE: paHome };
  // A new HOME would otherwise give npx a cold cache; keep using the real one.
  try { env.npm_config_cache ??= execSync('npm config get cache', { encoding: 'utf8', shell: true }).trim(); } catch { /* fall back to default */ }
  const child = spawn('npx', ['-y', PIXEL_AGENTS, '--host', '0.0.0.0', '--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32', env });
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGINT', () => { child.kill(); process.exit(0); });

  const token = await waitForToken(port);
  enableWatchAll(port, token);

  const post = (path, payload) => new Promise((resolve) => {
    const out = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pixelAgentsToken(port) ?? token}` } },
      (up) => { up.resume(); up.on('end', () => resolve(up.statusCode)); },
    );
    out.on('error', () => resolve(502));
    out.end(JSON.stringify(payload));
  });
  const seats = trackSeats((payload) => post('/api/hooks/claude', payload));
  seats.start();

  // Ingest shim: only the hook endpoint is exposed here, and only with the shared key.
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    const auth = req.headers.authorization ?? '';
    // Public, secret-free: the bootstrap script and the CLI itself. (Joining still needs the key.)
    const url = new URL(req.url, 'http://x');
    const base = `http://${req.headers.host ?? `${lanIp()}:${ingest}`}`;
    if (req.method === 'GET' && url.pathname === '/join') return res.writeHead(200, { 'content-type': 'text/plain' }).end(bootstrapScript(base));
    if (req.method === 'GET' && url.pathname === '/cli.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cliFiles()));
    if (req.method === 'GET' && url.pathname === '/agent') {
      if (!same(url.searchParams.get('key') ?? '', key)) return res.writeHead(401).end('unauthorized');
      return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(agentInstructions(base, key));
    }
    if (req.method === 'GET' && req.url === '/seats') {
      if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seats.names()));
    }
    if (req.method !== 'POST' || !req.url.startsWith('/api/hooks/')) return res.writeHead(404).end();
    if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return res.writeHead(400).end(); }
      // After a host restart, running agents keep sending tool events but never a new SessionStart, and
      // Pixel Agents drops events for sessions it has not seen start. Re-introduce the seat ourselves.
      if (seats.observe(payload) === true && payload.hook_event_name !== 'SessionStart') {
        await post(req.url, { session_id: payload.session_id, hook_event_name: 'SessionStart', cwd: payload.cwd, source: 'startup' });
      }
      res.writeHead(await post(req.url, payload)).end();
    });
  }).listen(ingest, '0.0.0.0');

  // Prefer the machine's .local name: the LAN address changes when DHCP renews, and every seat stores its address.
  const ip = lanIp();
  const name = stableName() ?? ip;
  console.log(`
Office is open.
  Big screen:  http://${name}:${port}/${name === ip ? '' : `   (or http://${ip}:${port}/)`}
  Join:        curl -s http://${name}:${ingest}/join | node - join --key ${key}
  For agents:  "Read http://${name}:${ingest}/agent?key=${key} and follow it" (fetch it with curl)
`);
}
