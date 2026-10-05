// HTTP for the Hive, kept apart from host.mjs so it can be tested without starting a host.
//   POST /api/heartbeat   keyed (same shared key as seats). A service reports in.
//   GET  /hive/state      the wall as JSON: HiveMember[]   (read-only, like the screen itself)
//   GET  /hive/stream     the same, as server-sent events: a full snapshot now and on every change
//   GET  /hive/buzz       the buzz thread as JSON;  GET /hive/buzz/stream the same as server-sent events
//   POST /hive/buzz       a person types into the wall's chat box (no key; capped per client address)
//   GET  /hive/info       { responder, settings }: whether the bots will answer, and what the host is set to
//   GET  /hive/join-info  { ingest, key }: what the Join page needs. The key is null unless the host pre-fills it (never part of /hive/info)
//   POST /api/buzz        keyed. A chatty agent says a line.   GET /buzz (keyed): the thread, for agents to read
//   GET  /hive/...        the built Hive screen (hive-ui/dist), SPA-style
import { NOBODY_MESSAGE } from './chat.mjs';
import { METRICS } from './service-rules.mjs';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const STATUSES = new Set(['ok', 'degraded', 'failure', 'gone']);
const MAX_BODY = 4096;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

/** What the host is set to, for the config page to show read-only (nothing here can be changed over HTTP). */
export function describeSettings(store, buzz, responder = null) {
  const min = (ms) => Math.round(ms / 60_000);
  return {
    ghostAfterMin: min(store.cfg.ghostAfterMs), ghostDropMin: min(store.cfg.ghostDropMs), stallMin: min(store.cfg.stallMs), serviceTtlSec: store.cfg.serviceTtlSec,
    buzzPerHour: buzz.cfg.perHour, humanPerHour: buzz.cfg.humanPerHour, maxChars: buzz.cfg.maxChars,
    responder: responder ?? { on: false },
  };
}

/** Validates a heartbeat body. -> { value } or { error }. */
export function parseHeartbeat(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const text = (k, max, required = false) => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return required ? new Error(`${k} is required`) : undefined;
    return typeof v === 'string' && v.length <= max ? v : new Error(`${k} must be a string of at most ${max} characters`);
  };
  const id = text('id', 100, true), name = text('name', 100), project = text('project', 100), message = text('message', 200);
  for (const v of [id, name, project, message]) if (v instanceof Error) return { error: v.message };
  const status = body.status ?? 'ok';
  if (!STATUSES.has(status)) return { error: `status must be one of ${[...STATUSES].join(', ')}` };
  let ttlSec;
  if (body.ttlSec !== undefined) {
    if (!Number.isInteger(body.ttlSec) || body.ttlSec < 5 || body.ttlSec > 86400) return { error: 'ttlSec must be a whole number of seconds from 5 to 86400' };
    ttlSec = body.ttlSec;
  }
  // Readings from the machine the service runs on (see machine-stats.mjs). Anything else in the object is ignored.
  let metrics;
  if (body.metrics !== undefined) {
    if (!body.metrics || typeof body.metrics !== 'object' || Array.isArray(body.metrics)) return { error: 'metrics must be an object like { "cpu": 40, "mem": 62 }' };
    metrics = {};
    for (const k of METRICS) {
      const v = body.metrics[k];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) || (v && typeof v === 'object')) return { error: `metrics.${k} must be one number: send the average across all of them (all CPUs, all GPUs), not one per core` };
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `metrics.${k} must be a number` };
      metrics[k] = k === 'temp' ? Math.max(-50, Math.min(250, v)) : Math.max(0, Math.min(k === 'net' ? 1e6 : 1000, v));
    }
    if (!Object.keys(metrics).length) metrics = undefined;
  }
  return { value: { id, name, project, status, message, ttlSec, ...(metrics ? { metrics } : {}) } };
}

/** POST /api/heartbeat. Returns true when it handled the request. */
export function handleHeartbeat(req, res, store, key) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/heartbeat') return false;
  if (!same(req.headers.authorization ?? '', `Bearer ${key}`)) { res.writeHead(401).end('unauthorized'); return true; }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { json(res, 413, { error: 'body too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'body is not valid JSON' }); }
    const { value, error } = parseHeartbeat(body);
    if (error) return json(res, 400, { error });
    store.heartbeat(value);
    res.writeHead(204).end();
  });
  return true;
}

/** Reads and parses a small JSON body; answers 400/413 itself and resolves null when it did. */
function readJson(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { json(res, 413, { error: 'body too large' }); req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { json(res, 400, { error: 'body is not valid JSON' }); resolve(null); }
    });
  });
}

/** POST /api/buzz (keyed). Only a seated agent that joined with --chatty may buzz. Returns true when it handled the request. */
export function handleBuzzPost(req, res, store, buzz, key) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/buzz') return false;
  if (!same(req.headers.authorization ?? '', `Bearer ${key}`)) { res.writeHead(401).end('unauthorized'); return true; }
  readJson(req, res).then((body) => {
    if (!body) return;
    const name = typeof body.name === 'string' ? body.name : '';
    const agent = store.findAgent(name);
    if (!agent) return json(res, 404, { error: `${name || 'that name'} is not in the hive` });
    if (!agent.chatty) return json(res, 403, { error: `${name} is not in chatty mode: rejoin with  hive join … --chatty` });
    const r = buzz.post({ from: name, kind: 'agent', text: body.text, replyTo: body.replyTo });
    if (!r.ok) return json(res, r.status, { error: r.error });
    res.writeHead(204).end();
  });
  return true;
}

/**
 * GET /hive/mode -> { mode, canSwitch }.  POST /hive/mode { mode: 'demo' | 'work', key } switches the board between Demo (simulated agents and
 * services seated, so the wall is never empty) and Work (they are shown the door; only real agents and services appear). The key is the
 * hive key: whoever holds it can switch it. `ctl` is { get(): string, set(mode): void } or null when this host has no simulator.
 */
export function handleMode(req, res, ctl, key) {
  if (req.url.split('?')[0] !== '/hive/mode') return false;
  if (req.method === 'GET') { json(res, 200, { mode: ctl?.get() ?? 'work', canSwitch: !!ctl }); return true; }
  if (req.method !== 'POST') return false;
  readJson(req, res).then((body) => {
    if (!body) return;
    if (typeof body.key !== 'string' || !same(body.key, key)) return json(res, 401, { error: 'that key was not accepted' });
    if (!ctl) return json(res, 409, { error: 'this host has no simulator to switch' });
    if (body.mode !== 'demo' && body.mode !== 'work') return json(res, 400, { error: 'mode must be demo or work' });
    ctl.set(body.mode);
    res.writeHead(204).end();
  });
  return true;
}

/** POST /hive/buzz: a person on the wall says something. Same-origin from the screen; capped per client in BuzzLog. */
export function handleHumanBuzz(req, res, buzz, hive = null) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/hive/buzz') return false;
  readJson(req, res).then((body) => {
    if (!body) return;
    const raw = typeof body.name === 'string' ? body.name.trim() : '';
    const name = /^[\p{L}\p{N} _.'-]{1,24}$/u.test(raw) ? raw : 'Human'; // on a shared screen nobody has to give a name: the agents just see "Human"
    const r = buzz.post({ from: name, kind: 'human', text: body.text, limitKey: req.socket.remoteAddress, replyTo: body.replyTo });
    if (!r.ok) return json(res, r.status, { error: r.error });
    // Nobody is sitting in the chat (a few seconds' grace aside): the line stays in the thread, and the Hive itself says so, rather than leaving it hanging.
    if (hive && !hive.chatReady().ok) {
      const before = buzz.list(2).find((m) => m.id !== r.message.id && m.text === NOBODY_MESSAGE); // do not repeat it for a second line typed straight after
      if (!before || r.message.at - before.at > 30_000) buzz.post({ from: 'hive', kind: 'system', text: NOBODY_MESSAGE, replyTo: r.message.id });
    }
    res.writeHead(204).end();
  });
  return true;
}

/** POST /api/handoff (keyed): { name, text }. A chatty agent leaves a note for whoever finishes last on its project (crew.mjs). */
export function handleHandoffPost(req, res, crew, key) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/handoff') return false;
  if (!same(req.headers.authorization ?? '', `Bearer ${key}`)) { res.writeHead(401).end('unauthorized'); return true; }
  readJson(req, res).then((body) => {
    if (!body) return;
    if (!crew) return json(res, 404, { error: 'this host does not run crew handoffs' });
    const r = crew.addNote(typeof body.name === 'string' ? body.name : '', body.text);
    if (!r.ok) return json(res, r.status, { error: r.error });
    res.writeHead(204).end();
  });
  return true;
}

/** GET /buzz (keyed): the thread, for an agent that wants to read before it replies. */
export function handleBuzzRead(req, res, buzz, key) {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/buzz') return false;
  if (!same(req.headers.authorization ?? '', `Bearer ${key}`)) { res.writeHead(401).end('unauthorized'); return true; }
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.has('after')) { // long-poll: lines after an id that the asker did not write, waiting up to `wait` seconds for one
    const wait = Math.min(Math.max(Number(q.get('wait')) || 0, 0), 110) * 1000;
    const ctl = { gone: false };
    const left = new AbortController();
    req.on('close', () => { ctl.gone = true; });
    res.on('close', () => left.abort()); // a listener that disconnects stops counting as waiting in the chat at once
    res.setHeader('x-hive-epoch', buzz.epoch);
    buzz.waitFor(Number(q.get('after')) || 0, q.get('as') ?? '', wait, left.signal).then((lines) => { if (!ctl.gone) json(res, 200, lines); });
    return true;
  }
  res.setHeader('x-hive-epoch', buzz.epoch);
  json(res, 200, buzz.list(Number(q.get('limit')) || 20));
  return true;
}

function sse(req, res, source) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(source.snapshot());
  const off = source.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { off(); clearInterval(ping); });
}

// The screen's script is several megabytes: sent raw, it is a blank page for many seconds on weak Wi-Fi or a phone. Text files are sent
// compressed (brotli if the browser takes it, else gzip), compressed once per file version and kept.
const COMPRESSIBLE = /\.(html|js|mjs|css|svg|json|map)$/;
const squeezed = new Map(); // "file|mtime|encoding" -> Buffer

function serveFile(req, res, file, cache) {
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': cache, vary: 'Accept-Encoding' };
  const accept = req.headers['accept-encoding'] ?? '';
  const enc = COMPRESSIBLE.test(file) ? (/\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null) : null;
  if (!enc) {
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return void createReadStream(file).pipe(res);
  }
  const key = `${file}|${Math.round(statSync(file).mtimeMs)}|${enc}`;
  let body = squeezed.get(key);
  if (!body) {
    for (const k of squeezed.keys()) if (k.startsWith(`${file}|`) && k.endsWith(`|${enc}`)) squeezed.delete(k); // drop older versions of this file
    const raw = readFileSync(file);
    body = enc === 'br' ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(raw, { level: 6 });
    squeezed.set(key, body);
  }
  res.writeHead(200, { ...headers, 'content-encoding': enc, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * /join-page -> the Join page built into the Hive screen (/hive/join), keeping any ?key=. Returns false when the screen is not built,
 * so the caller can serve the plain dependency-free page instead.
 */
export function handleJoinRedirect(req, res, uiDir) {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/join-page' || !existsSync(join(uiDir, 'index.html'))) return false;
  if (/[?&]plain\b/.test(req.url)) return false; // ?plain=1: the lightweight page with no script bundle, for a slow connection
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.writeHead(302, { location: `/hive/join${query}` }).end();
  return true;
}

/** GET /hive, /hive/state, /hive/stream and the static screen. Returns true when it handled the request. */
export function handleHiveRead(req, res, store, uiDir, buzz = null, info = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = req.url.split('?')[0];
  if (path === '/hive') { res.writeHead(302, { location: '/hive/' }).end(); return true; }
  if (!path.startsWith('/hive/')) return false;
  if (path === '/hive/state') { json(res, 200, store.snapshot()); return true; }
  if (path === '/hive/stream') { sse(req, res, store); return true; }
  if (path === '/hive/production') { json(res, 200, store.production()); return true; }
  if (path === '/hive/info') { const { join, ...publicInfo } = info; json(res, 200, publicInfo); return true; }
  if (path === '/hive/join-info') { json(res, 200, info.join ?? { ingest: null, key: null }); return true; }
  if (buzz && path === '/hive/buzz') { json(res, 200, buzz.list(100)); return true; }
  if (buzz && path === '/hive/buzz/stream') { sse(req, res, { snapshot: () => buzz.list(100), subscribe: (fn) => buzz.subscribe(() => fn(buzz.list(100))) }); return true; }
  if (!existsSync(join(uiDir, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('The Hive screen is not built yet. Run:  cd hive-ui && pnpm install && pnpm build\n(or pnpm dev there to work on it live)\n');
    return true;
  }
  let decoded;
  try { decoded = decodeURIComponent(path.slice('/hive/'.length)); } catch { res.writeHead(400).end(); return true; }
  const rel = normalize(decoded || 'index.html');
  const file = join(uiDir, rel);
  if (rel.startsWith('..') || !file.startsWith(uiDir + sep)) { res.writeHead(403).end(); return true; }
  if (existsSync(file) && statSync(file).isFile()) { serveFile(req, res, file, rel.startsWith('assets') ? 'public, max-age=31536000, immutable' : 'no-cache'); return true; }
  if (extname(rel)) { res.writeHead(404).end(); return true; }
  serveFile(req, res, join(uiDir, 'index.html'), 'no-cache'); // SPA fallback
  return true;
}

/**
 * POST /hive/admin { action: 'boot' | 'listen', id, key, by? }: what the cog on an agent's details does. These act on someone else's seat, so they need the
 * hive key (the same one agents join with); the wall asks for it once.
 *   boot  take the agent off the wall; its events are ignored until it rejoins, and it is told once, on its next event, that it was removed.
 *   listen  ask a working, chatty agent to come and sit in the chat when it reaches a stopping point (it runs `hive listen`).
 */
export function handleAdmin(req, res, { hive, buzz, key }) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/hive/admin') return false;
  readJson(req, res).then((body) => {
    if (!body) return;
    if (typeof body.key !== 'string' || !same(body.key, key)) return json(res, 401, { error: 'that is not the hive key' });
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 24) : 'The host';
    if (body.action === 'boot') {
      const a = hive.boot(body.id);
      if (!a) return json(res, 404, { error: 'that agent is not on the wall any more' });
      buzz?.post({ from: 'hive', kind: 'system', text: `${a.name} was booted from the hive by ${by}.` });
      return void res.writeHead(204).end();
    }
    if (body.action === 'listen') {
      const t = hive.askToListen(body.id, by);
      if (!t) return json(res, 404, { error: 'that agent is not on the wall any more' });
      if (t.refused) return json(res, 409, { error: t.refused });
      buzz?.post({ from: 'hive', kind: 'system', text: `${by} asked ${t.name} to listen.` });
      return void res.writeHead(204).end();
    }
    json(res, 400, { error: 'action must be boot or listen' });
  });
  return true;
}
