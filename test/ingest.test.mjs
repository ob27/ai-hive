import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { createIngest } from '../src/ingest.mjs';

const KEY = 'ingest-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
const store = new HiveStore();
const buzz = new BuzzLog();
const forwarded = [];
let server, addr;

before(async () => {
  server = http.createServer(createIngest({ hive: store, buzz, key: KEY, defaultBase: () => addr, seatNames: () => store.snapshot().filter((m) => m.kind === 'agent').map((m) => m.name), onHook: async (payload) => { forwarded.push(payload); return 200; } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  addr = `127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, key) => fetch(`http://${addr}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const cli = (home, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, OFFICE_HOME: home, OFFICE_SEAT: '', HIVE_SEAT: '' } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => resolve({ status, out, err }));
});

test('health, and the public bootstrap and CLI downloads', async () => {
  assert.equal(await (await get('/health')).text(), 'ok');
  assert.match(await (await get('/join')).text(), /cli\.json/);
  const files = await (await get('/cli.json')).json();
  assert.ok(files['bin/office.mjs'] && files['src/ingest.mjs'] && files['src/buzz.mjs']);
});

test('the agent instructions and the seat list need the key', async () => {
  assert.equal((await get('/agent')).status, 401);
  assert.equal((await get('/agent?key=wrong')).status, 401);
  assert.match(await (await get(`/agent?key=${KEY}`)).text(), /Join the AI Hive[\s\S]*curl -s http:\/\/.*\/join \| node - join --key/);
  assert.equal((await get('/seats')).status, 401);
  assert.deepEqual(await (await get('/seats', KEY)).json(), []);
});

test('a hook event needs the key, reaches the hive without its wall-only metadata, and is handed on', async () => {
  const body = { session_id: 's1', hook_event_name: 'PreToolUse', cwd: '/office/Zed', tool_name: 'Bash', tool_input: { command: 'ls' }, hive: { project: 'rebarui', chatty: true } };
  assert.equal((await fetch(`http://${addr}/api/hooks/claude`, { method: 'POST', body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(`http://${addr}/api/hooks/claude`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: 'not json' })).status, 400);
  assert.equal((await fetch(`http://${addr}/api/hooks/claude`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })).status, 200);
  const m = store.snapshot().find((x) => x.name === 'Zed');
  assert.deepEqual([m.project, m.chatty, m.activity], ['rebarui', true, 'ls']);
  assert.equal(forwarded.at(-1).hive, undefined, 'the metadata is stripped before the hook is handed on');
  assert.equal(forwarded.at(-1).session_id, 's1');
});

test('heartbeats, buzz and everything else behave as before, and unknown routes are 404', async () => {
  assert.equal((await fetch(`http://${addr}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ id: 'dsl', name: 'DSL Service' }) })).status, 204);
  assert.ok(store.snapshot().some((m) => m.id === 'dsl'));
  assert.equal((await get('/buzz', KEY)).status, 200);
  assert.equal((await get('/nope')).status, 404);
});

test('a real CLI joins as chatty, appears on the wall, and can buzz', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hive-join-'));
  const joined = await cli(home, 'join', addr, 'Nina', '--key', KEY, '--chatty');
  assert.equal(joined.status, 0, joined.err);
  assert.match(joined.out, /Nina is seated/);
  const nina = store.snapshot().find((m) => m.name === 'Nina');
  assert.deepEqual([nina.kind, nina.chatty], ['agent', true]);
  const said = await cli(home, 'buzz', '--seat', 'Nina', 'hello from a real seat');
  assert.equal(said.status, 0, said.err);
  assert.ok(buzz.list(20).some((m) => m.from === 'Nina' && m.text === 'hello from a real seat'));
  assert.equal((await cli(home, 'leave', '--seat', 'Nina')).status, 0);
  assert.equal(store.snapshot().some((m) => m.name === 'Nina'), false);
});
