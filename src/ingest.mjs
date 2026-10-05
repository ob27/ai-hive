// The keyed ingest: everything an agent or a service talks to. Shared by the real host and the demo, so both are joinable the same way
// and tested once.
//   GET  /health                 ok
//   GET  /join, /cli.json        public: the bootstrap script and the dependency-free CLI (joining still needs the key)
//   GET  /agent?key=…            the agent instructions
//   GET  /seats                  keyed: names currently seated
//   POST /api/heartbeat          keyed: a service reports in
//   POST /api/buzz, GET /buzz    keyed: a chatty agent buzzes / reads
//   POST /api/handoff            keyed: a chatty agent leaves a note for whoever finishes last on its project (crew.mjs)
//   POST /api/hooks/*            keyed: a seat's hook events (chirps and real tool use)
//   GET  /api/status, /api/logs  keyed: what the host knows about itself (see monitor.mjs), for `hive status` and `hive logs`
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootstrapScript, cliFiles, cliVersion } from './bootstrap.mjs';
import { handleBuzzPost, handleBuzzRead, handleHandoffPost, handleHeartbeat } from './hive-http.mjs';
import { networkInterfaces } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What an agent reads to get going: where to join, then the behaviour rules from agent.md.
export function agentInstructions(base, key) {
  const rules = readFileSync(join(repoRoot, 'agent.md'), 'utf8').split('## One line for your system prompt')[0];
  return `# Join the AI Hive

Hive: ${base}

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


/** Which machine a request came from: this host's own address (loopback or its LAN address) is 'host', anyone else is their address. */
export function machineOf(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '');
  if (!a) return undefined;
  if (a === '::1' || a.startsWith('127.')) return 'host';
  for (const i of Object.values(networkInterfaces()).flat()) if (i && i.address === a) return 'host';
  return a;
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * -> (req, res) for http.createServer. `onHook(payload, path)` runs after the hive has seen a hook event and answers with the HTTP status
 * to return (the default just accepts). `seatNames()` lists who is seated.
 */
// The hook events whose reply an agent tool lets us add text to; a notice is only handed over on one of these, so it is never lost.
const CARRIES_NOTICE = new Set(['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'AfterTool', 'BeforeAgent', 'AfterAgent']);

export function createIngest({ hive, buzz, key, defaultBase, seatNames = () => [], onHook = async () => 200, monitor = null, hostStatus = () => ({}), roster = null, crew = null }) {
  // A seat whose CLI differs from this host's is told once an hour. Older CLIs report no version: they cannot be judged.
  let current = { at: 0, v: '' };
  const told = new Map();
  const staleCli = (sid, seen) => {
    if (typeof seen !== 'string') return false;
    if (Date.now() - current.at > 30_000) current = { at: Date.now(), v: cliVersion() };
    if (seen === current.v || Date.now() - (told.get(sid) ?? 0) < 3600_000) return false;
    told.set(sid, Date.now());
    return true;
  };
  return (req, res) => {
    monitor?.track(req, res, 'ingest');
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    const auth = req.headers.authorization ?? '';
    const url = new URL(req.url, 'http://x');
    const base = `http://${req.headers.host ?? defaultBase()}`;
    if (req.method === 'GET' && url.pathname === '/join') return res.writeHead(200, { 'content-type': 'text/plain' }).end(bootstrapScript(base));
    if (req.method === 'GET' && url.pathname === '/cli.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cliFiles()));
    if (req.method === 'GET' && url.pathname === '/agent') {
      if (!same(url.searchParams.get('key') ?? '', key)) return res.writeHead(401).end('unauthorized');
      return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(agentInstructions(base, key));
    }
    if (req.method === 'GET' && req.url === '/seats') {
      if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seatNames()));
    }
    if (monitor && req.method === 'GET' && (url.pathname === '/api/status' || url.pathname === '/api/logs')) {
      if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
      const body = url.pathname === '/api/status' ? monitor.status(hostStatus()) : monitor.tail(Number(url.searchParams.get('after')) || 0, Number(url.searchParams.get('limit')) || 100);
      return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    }
    if (handleHeartbeat(req, res, hive, key) || handleBuzzPost(req, res, hive, buzz, key) || handleHandoffPost(req, res, crew, key) || handleBuzzRead(req, res, buzz, key, hive)) return;
    if (req.method === 'POST' && req.url === '/api/claim' && roster) { // `hive join` asks for its place in its project's cast
      if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return res.writeHead(400).end(); }
        const r = roster.claim(body?.project, { occupied: hive.occupiedSlots(), taken: new Set(seatNames()) });
        hive.ledger?.adopt(typeof body?.name === 'string' && body.name ? body.name : r.name, r.slot); // turns counted under this name before slots existed move onto the slot
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
      });
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/api/hooks/')) return res.writeHead(404).end();
    if (!same(auth, `Bearer ${key}`)) return res.writeHead(401).end('unauthorized');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let payload, meta;
      try { ({ hive: meta, ...payload } = JSON.parse(Buffer.concat(chunks).toString())); } catch { return res.writeHead(400).end(); }
      hive.observe(payload, { ...meta, addr: machineOf(req.socket.remoteAddress) }); // `meta` (the seat's project folder, chatty flag) is for the wall only: stripped before anything else sees the payload
      const status = await onHook(payload, req.url);
      let notice = CARRIES_NOTICE.has(payload.hook_event_name) ? hive.takeNotice(payload.session_id) : null;
      if (!notice && CARRIES_NOTICE.has(payload.hook_event_name) && staleCli(payload.session_id, meta?.cli)) notice = 'The Hive CLI on this machine is out of date, so new notices may be missed. Tell the person you work for to run `hive update` (or run it yourself if you are allowed to).'; // an ask to listen, or the news that the host removed this seat: rides back on the reply
      if (notice) return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ notice }));
      res.writeHead(status).end();
    });
  };
}
