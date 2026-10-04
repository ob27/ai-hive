import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { handleHeartbeat, handleHiveRead, parseHeartbeat } from '../src/hive-http.mjs';

const KEY = 'k3y';
const ui = mkdtempSync(join(tmpdir(), 'hive-ui-'));
mkdirSync(join(ui, 'assets'));
writeFileSync(join(ui, 'index.html'), '<title>hive</title>');
writeFileSync(join(ui, 'assets', 'a.js'), 'console.log(1)');
const store = new HiveStore();
let server, base;

before(async () => {
  server = http.createServer((req, res) => {
    if (handleHeartbeat(req, res, store, KEY) || handleHiveRead(req, res, store, ui)) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const beat = (body, key = KEY) => fetch(`${base}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a heartbeat needs the key', async () => {
  assert.equal((await beat({ id: 'x' }, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/api/heartbeat`, { method: 'POST', body: '{}' })).status, 401);
});

test('a good heartbeat shows up on the wall', async () => {
  assert.equal((await beat({ id: 'dsl', name: 'DSL Service', project: 'Dm-Archive', status: 'degraded', message: 'leaking memory?', ttlSec: 30 })).status, 204);
  const wall = await (await fetch(`${base}/hive/state`)).json();
  const m = wall.find((x) => x.id === 'dsl');
  assert.deepEqual([m.kind, m.status, m.statusLabel, m.activity], ['service', 'failure', 'Degraded', 'leaking memory?']);
});

test('bad heartbeats are refused with a reason', async () => {
  for (const [body, why] of [['not json', /valid JSON/], [{}, /id is required/], [{ id: 'x', status: 'sad' }, /status must be/], [{ id: 'x', ttlSec: 1 }, /ttlSec/], [{ id: 'x', message: 'm'.repeat(201) }, /message/]]) {
    const res = await beat(body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, why);
  }
});

test('an oversized heartbeat is refused', async () => {
  const res = await beat({ id: 'x', message: 'ok', pad: 'p'.repeat(5000) }).catch(() => ({ status: 413 }));
  assert.equal(res.status, 413);
});

test('the stream sends the wall now and again on every change', async () => {
  const res = await fetch(`${base}/hive/stream`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const read = async () => { const { value } = await reader.read(); return new TextDecoder().decode(value); };
  let text = await read();
  while (!text.includes('data:')) text += await read();
  assert.match(text, /DSL Service/);
  await beat({ id: 'idx', name: 'Index Worker' });
  let next = '';
  while (!next.includes('Index Worker')) next += await read();
  await reader.cancel();
});

test('the screen is served, with the SPA fallback, and cannot escape its folder', async () => {
  assert.equal((await fetch(`${base}/hive`, { redirect: 'manual' })).status, 302);
  assert.match(await (await fetch(`${base}/hive/`)).text(), /<title>hive<\/title>/);
  assert.match(await (await fetch(`${base}/hive/anything/deep`)).text(), /<title>hive<\/title>/);
  assert.equal(await (await fetch(`${base}/hive/assets/a.js`)).text(), 'console.log(1)');
  assert.equal((await fetch(`${base}/hive/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/hive/..%2f..%2f..%2fetc/passwd`)).status, 403);
});

test('without a built screen the route says how to build it', async () => {
  const empty = http.createServer((req, res) => { handleHiveRead(req, res, store, join(ui, 'nope')) || res.writeHead(404).end(); });
  await new Promise((r) => empty.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${empty.address().port}/hive/`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /pnpm build/);
  empty.close();
});

test('parseHeartbeat defaults status to ok', () => {
  assert.deepEqual(parseHeartbeat({ id: 'a' }).value, { id: 'a', name: undefined, project: undefined, status: 'ok', message: undefined, ttlSec: undefined });
});

test('describeSettings reports the host thresholds for the config page', async () => {
  const { describeSettings } = await import('../src/hive-http.mjs');
  const { BuzzLog } = await import('../src/buzz.mjs');
  const s = describeSettings(new HiveStore(), new BuzzLog());
  assert.deepEqual([s.ghostAfterMin, s.ghostDropMin, s.stallMin, s.serviceTtlSec, s.buzzPerHour, s.humanPerHour, s.responder.on], [30, 60, 5, 60, 12, 30, false]);
});

test('the Join page gets the ingest port and key from /hive/join-info; the key never appears in /hive/info', async () => {
  const srv = http.createServer((req, res) => { handleHiveRead(req, res, store, ui, null, { responder: true, join: { ingest: 3101, key: 'sekret' } }) || res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await (await fetch(`${b}/hive/join-info`)).json(), { ingest: 3101, key: 'sekret' });
  const pub = await (await fetch(`${b}/hive/info`)).text();
  assert.equal(pub.includes('sekret'), false);
  assert.deepEqual(JSON.parse(pub), { responder: true });
  srv.close();
});

test('/join-page redirects to the Join page in the Hive screen, keeping ?key=, only when the screen is built', async () => {
  const { handleJoinRedirect } = await import('../src/hive-http.mjs');
  const srv = http.createServer((req, res) => { handleJoinRedirect(req, res, req.headers['x-ui'] === 'none' ? join(ui, 'nope') : ui) || res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const built = await fetch(`${b}/join-page?key=abc`, { redirect: 'manual' });
  assert.deepEqual([built.status, built.headers.get('location')], [302, '/hive/join?key=abc']);
  assert.equal((await fetch(`${b}/join-page`, { redirect: 'manual' })).headers.get('location'), '/hive/join');
  assert.equal((await fetch(`${b}/join-page`, { redirect: 'manual', headers: { 'x-ui': 'none' } })).status, 404); // not built: the caller serves the plain page
  srv.close();
});

test('the board mode: anyone can read it; switching needs the hive key', async () => {
  const { handleMode } = await import('../src/hive-http.mjs');
  let mode = 'work';
  const ctl = { get: () => mode, set: (m) => { mode = m; } };
  const srv = http.createServer((req, res) => { handleMode(req, res, ctl, 'k3y') || res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(`${b}/hive/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${b}/hive/mode`)).json(), { mode: 'work', canSwitch: true });
  assert.equal((await post({ mode: 'demo' })).status, 401);
  assert.equal((await post({ mode: 'demo', key: 'wrong' })).status, 401);
  assert.equal(mode, 'work');
  assert.equal((await post({ mode: 'sideways', key: 'k3y' })).status, 400);
  assert.equal((await post({ mode: 'demo', key: 'k3y' })).status, 204);
  assert.equal(mode, 'demo');
  assert.equal((await post({ mode: 'work', key: 'k3y' })).status, 204);
  assert.equal(mode, 'work');
  srv.close();
  const none = http.createServer((req, res) => { handleMode(req, res, null, 'k3y') || res.writeHead(404).end(); });
  await new Promise((r) => none.listen(0, '127.0.0.1', r));
  const nb = `http://127.0.0.1:${none.address().port}`;
  assert.deepEqual(await (await fetch(`${nb}/hive/mode`)).json(), { mode: 'work', canSwitch: false });
  assert.equal((await fetch(`${nb}/hive/mode`, { method: 'POST', body: JSON.stringify({ mode: 'demo', key: 'k3y' }) })).status, 409);
  none.close();
});

test('the screen sends text files compressed (brotli, else gzip), once per version, and leaves images alone', async () => {
  const { gunzipSync, brotliDecompressSync } = await import('node:zlib');
  const dir = mkdtempSync(join(tmpdir(), 'hive-zip-'));
  mkdirSync(join(dir, 'assets'));
  const big = 'console.log("the hive");\n'.repeat(4000);
  writeFileSync(join(dir, 'index.html'), '<title>zip</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), big);
  writeFileSync(join(dir, 'assets', 'pic.png'), Buffer.from([137, 80, 78, 71]));
  const srv = http.createServer((req, res) => { handleHiveRead(req, res, store, dir) || res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}/hive/assets`;
  const get = (path, enc) => new Promise((resolve) => http.get(`${b}${path}`, { headers: { 'accept-encoding': enc } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(c) })); }));
  const br = await get('/app.js', 'gzip, deflate, br');
  assert.equal(br.res.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(br.body).toString(), big);
  assert.ok(br.body.length < big.length / 20, 'it is much smaller on the wire');
  const gz = await get('/app.js', 'gzip');
  assert.equal(gz.res.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gz.body).toString(), big);
  assert.match(gz.res.headers.vary, /Accept-Encoding/);
  const raw = await get('/app.js', 'identity');
  assert.equal(raw.res.headers['content-encoding'], undefined);
  assert.equal(raw.body.toString(), big);
  const png = await get('/pic.png', 'gzip, br');
  assert.equal(png.res.headers['content-encoding'], undefined, 'images are not recompressed');
  srv.close();
});

test('/join-page?plain=1 is never redirected: it is the lightweight page for a slow connection', async () => {
  const { handleJoinRedirect } = await import('../src/hive-http.mjs');
  const srv = http.createServer((req, res) => { handleJoinRedirect(req, res, ui) || res.writeHead(200).end('plain'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await fetch(`${b}/join-page?plain=1`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${b}/join-page?key=abc&plain=1`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${b}/join-page?key=abc`, { redirect: 'manual' })).status, 302);
  srv.close();
});
