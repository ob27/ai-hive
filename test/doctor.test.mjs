import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { Monitor, describeHost } from '../src/monitor.mjs';
import { createIngest } from '../src/ingest.mjs';
import { describeSettings, handleHiveRead, handleHumanBuzz, handleJoinRedirect, handleMode } from '../src/hive-http.mjs';
import { render, runChecks } from '../src/doctor.mjs';

const KEY = 'doc-key';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const servers = [];
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
after(() => servers.forEach((s) => s.close()));

let good, stale;

before(async () => {
  // A current host: the real handlers, a real built screen if there is one (the checks care that it answers).
  const store = new HiveStore(); const buzz = new BuzzLog(); const monitor = new Monitor({ role: 'host' });
  store.observe({ session_id: 's1', hook_event_name: 'SessionStart', cwd: '/office/Vint' }, { project: 'getcodex', hooks: [] });
  store.observe({ session_id: 's1', hook_event_name: 'Stop', cwd: '/office/Vint' });
  store.observe({ session_id: 's2', hook_event_name: 'PreToolUse', cwd: '/office/Tom', tool_name: 'Bash', tool_input: { command: 'chirp' } }, { hooks: ['claude'] });
  store.agents.get('s2').pre.at -= 10 * 60_000; store.agents.get('s2').lastAt -= 10 * 60_000;
  // A stand-in for the built screen, so this test does not need hive-ui built (the real one is not committed).
  const ui = mkdtempSync(join(tmpdir(), 'hive-ui-'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>AI Hive</title>');
  const info = { responder: false, settings: describeSettings(store, buzz) };
  const modeCtl = { get: () => 'work', set: () => {} };
  const ingest = await listen(createIngest({ hive: store, buzz, key: KEY, monitor, defaultBase: () => 'x', hostStatus: () => describeHost({ hive: store, buzz, mode: modeCtl, uiDir: ui, ports: {}, info }) }));
  const screen = await listen((req, res) => { monitor.track(req, res, 'screen'); if (req.url === '/') return res.writeHead(302, { location: '/hive/' }).end(); if (handleJoinRedirect(req, res, ui) || handleMode(req, res, modeCtl, KEY) || handleHumanBuzz(req, res, buzz)) return; if (!handleHiveRead(req, res, store, ui, buzz, info)) res.writeHead(404).end(); });
  good = { ingest, screen };
  // An OLD host: answers every address with a web page (a catch-all web page), has /health and the old join page, and no Hive anything.
  stale = { ingest: await listen((req, res) => (req.url === '/health' ? res.end('ok') : res.writeHead(404).end())),
            screen: await listen((req, res) => (req.url.startsWith('/join-page') ? res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Join the office</title>') : res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Some other app</title>'))) };
});

const by = (r, id) => r.checks.find((c) => c.id === id);

test('a current host passes, and the host reports on itself, including why Tom is stalled and that Vint reports nothing', async () => {
  const r = await runChecks({ host: '127.0.0.1', ingest: good.ingest, screen: good.screen, key: KEY });
  for (const id of ['ingest', 'screen', 'data', 'stream', 'mode', 'buzz', 'status', 'code']) assert.equal(by(r, id).state, 'ok', `${id}: ${by(r, id).detail}`);
  assert.match(by(r, 'data').detail, /JSON with 2 members/);
  assert.ok(r.diagnosis.some((d) => /Vint joined without hooks/.test(d)));
  assert.ok(r.diagnosis.some((d) => /Tom is stalled: Started "chirp" 10 min ago and has not reported finishing/.test(d)));
  const text = render(r, { host: 'test' });
  assert.match(text, /Board: WORK mode, 2 members \(/);
  assert.match(text, /Tom \(agent\) Stalled: Started "chirp"/);
});

test('an OLD host is diagnosed from outside: the wall data is a web page, the join page is the old one, and it needs a restart', async () => {
  const r = await runChecks({ host: '127.0.0.1', ingest: stale.ingest, screen: stale.screen, key: KEY });
  assert.equal(by(r, 'ingest').state, 'ok');
  assert.equal(by(r, 'data').state, 'fail');
  assert.match(by(r, 'data').detail, /answers with a web page, not data/);
  assert.equal(by(r, 'join').state, 'warn');
  assert.match(by(r, 'join').detail, /OLD "Join the office" page/);
  assert.match(by(r, 'status').detail, /predates the monitor/);
  assert.equal(r.diagnosis.filter((d) => /^Restart/.test(d)).length, 1, 'restart is said once');
  assert.match(r.diagnosis[0], /^Restart the host so it loads the current code/);
});

test('nothing listening is reported plainly, with what to do', async () => {
  const r = await runChecks({ host: '127.0.0.1', ingest: 1, screen: 1, key: KEY });
  assert.equal(by(r, 'ingest').state, 'fail');
  assert.match(by(r, 'ingest').detail, /nothing answers at/);
  assert.match(by(r, 'ingest').fix, /Start the host/);
});

test('a wrong key is called out', async () => {
  const r = await runChecks({ host: '127.0.0.1', ingest: good.ingest, screen: good.screen, key: 'wrong' });
  assert.equal(by(r, 'status').state, 'fail');
  assert.match(by(r, 'status').detail, /key was not accepted/);
});

const cli = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin', 'office.mjs'), ...args], { env: { ...process.env, OFFICE_HOME: '/nonexistent-home', HIVE_SEAT: '', OFFICE_SEAT: '' } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => resolve({ status, out, err }));
});

test('the CLI: hive status exits non-zero and names the fix for an old host, zero for a current one; hive logs shows what the host saw', async () => {
  const old = await cli('status', '--url', `127.0.0.1:${stale.ingest}`, '--screen', String(stale.screen), '--key', KEY);
  assert.equal(old.status, 1);
  assert.match(old.out, /✗ The Hive wall data is served/);
  assert.match(old.out, /What to do:\n 1\. Restart the host/);
  const fine = await cli('status', '--url', `127.0.0.1:${good.ingest}`, '--screen', String(good.screen), '--key', KEY);
  assert.match(fine.out, /✓ The Hive wall data is served/);
  const logs = await cli('logs', '--url', `127.0.0.1:${good.ingest}`, '--key', KEY);
  assert.equal(logs.status, 0, logs.err);
  assert.match(logs.out, /req\s+(screen|ingest) GET \/hive\/state -> 200/);
});
