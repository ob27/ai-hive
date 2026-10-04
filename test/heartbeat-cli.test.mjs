import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { handleHeartbeat, handleHiveRead } from '../src/hive-http.mjs';

const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
const KEY = 'cli-key';
const store = new HiveStore();
let server, addr;
// An empty OFFICE_HOME so the CLI never picks up a real seat from this machine.
const env = { ...process.env, OFFICE_HOME: mkdtempSync(join(tmpdir(), 'hive-cli-')), OFFICE_SEAT: '', OFFICE_URL: '', OFFICE_KEY: '' };
// Async on purpose: the server under test lives in this process, so a blocking spawnSync would starve it.
const cli = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, 'heartbeat', ...args], { env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stderr }));
});
const wall = () => store.snapshot();
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

before(async () => {
  server = http.createServer((req, res) => { handleHeartbeat(req, res, store, KEY) || handleHiveRead(req, res, store, '/nonexistent') || res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  addr = `127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('one-shot: a service reports a suspected memory leak and shows as a failure', async () => {
  const r = await cli('--id', 'idx', '--name', 'Index Worker', '--project', 'Reports', '--status', 'degraded', '--message', 'memory climbing', '--url', addr, '--key', KEY);
  assert.equal(r.status, 0, r.stderr);
  const m = wall().find((x) => x.id === 'idx');
  assert.deepEqual([m.name, m.project, m.status, m.statusLabel, m.activity], ['Index Worker', 'Reports', 'failure', 'Degraded', 'memory climbing']);
});

test('the wrong key fails loudly with a non-zero exit', async () => {
  const r = await cli('--id', 'x', '--url', addr, '--key', 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /heartbeat failed: the Hive answered 401/);
});

test('missing host and key is a clear error, not a crash', async () => {
  const r = await cli('--id', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no host or key/);
});

test('a bad status is refused by the Hive and reported', async () => {
  const r = await cli('--id', 'x', '--status', 'sad', '--url', addr, '--key', KEY);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /status must be one of/);
});

test('--every keeps reporting and says gone on Ctrl+C', async () => {
  const child = spawn(process.execPath, [CLI, 'heartbeat', '--id', 'loop', '--name', 'Looper', '--every', '1', '--url', addr, '--key', KEY], { env });
  assert.ok(await until(() => wall().some((m) => m.id === 'loop' && m.status === 'active')), 'first beat arrives');
  const first = wall().find((m) => m.id === 'loop').updatedAt;
  assert.ok(await until(() => wall().find((m) => m.id === 'loop')?.updatedAt > first, 3500), 'a second beat arrives');
  child.kill('SIGINT');
  assert.ok(await until(() => !wall().some((m) => m.id === 'loop')), 'it is removed when the process says gone');
});
