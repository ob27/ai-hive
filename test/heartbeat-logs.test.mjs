import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { Monitor } from '../src/monitor.mjs';
import { createIngest } from '../src/ingest.mjs';
import { logSummary } from '../src/heartbeat.mjs';

const at = (s) => new Date(2026, 9, 5, 14, 3, s).getTime();
const req = (id, text, s = id) => ({ id, at: at(s), kind: 'req', text });

test('the log summary skips the noise (the screen polling, heartbeats) and shows the latest line that means something', () => {
  const s = logSummary([req(1, 'ingest POST /api/buzz -> 204 (2ms)'), req(2, 'ingest POST /api/heartbeat -> 204 (1ms)'), req(3, 'screen GET /hive/state -> 200 (1ms)'), req(4, 'screen GET /hive/stream -> 200 (5011ms)')]);
  assert.deepEqual([s.status, s.message], ['ok', '14:03:01 ingest POST /api/buzz -> 204 (2ms)']);
});

test('console output counts, a server error makes it degraded, and a quiet spell keeps the last line with its age', () => {
  const console1 = { id: 5, at: at(5), kind: 'console', text: 'Hive listening on 3100' };
  assert.equal(logSummary([req(1, 'ingest GET /seats -> 200 (1ms)'), console1]).message, '14:03:05 Hive listening on 3100');
  const err = logSummary([req(6, 'ingest POST /api/hooks/claude -> 500 (4ms)')]);
  assert.deepEqual([err.status, err.message], ['degraded', '14:03:06 ingest POST /api/hooks/claude -> 500 (4ms)']);
  const first = logSummary([req(1, 'ingest GET /seats -> 200 (1ms)')]);
  const quiet = logSummary([req(2, 'ingest POST /api/heartbeat -> 204 (1ms)')], first.last, at(1) + 95_000);
  assert.deepEqual([quiet.status, quiet.message], ['ok', '14:03:01 ingest GET /seats -> 200 (1ms) (1m ago)']);
  assert.equal(logSummary([]).message, 'running, no activity yet');
});

const KEY = 'logs-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
let store, server, addr;
before(async () => {
  store = new HiveStore(); const monitor = new Monitor({ role: 'host' });
  server = http.createServer(createIngest({ hive: store, buzz: new BuzzLog(), key: KEY, monitor, defaultBase: () => addr, hostStatus: () => ({}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  addr = `127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('hive heartbeat --logs reports the host\'s own log tail as the service message', async () => {
  await fetch(`http://${addr}/seats`, { headers: { authorization: `Bearer ${KEY}` } });
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'heartbeat', '--id', 'hive-web', '--name', 'Hive Web App', '--logs', '--url', addr, '--key', KEY], { env: { ...process.env, OFFICE_HOME: mkdtempSync(join(tmpdir(), 'hb-')) } });
    let o = ''; child.stdout.on('data', (d) => { o += d; }); child.stderr.on('data', (d) => { o += d; });
    child.on('close', (code) => resolve({ code, o }));
  });
  assert.equal(out.code, 0, out.o);
  const m = store.snapshot().find((x) => x.id === 'hive-web');
  assert.equal(m.statusLabel, 'Healthy');
  assert.match(m.activity, /^\d\d:\d\d:\d\d ingest GET \/seats -> 200/);
});

test('a multi-line console entry (the host\'s startup banner) is shown as one line, clipped', () => {
  const banner = { id: 1, at: at(1), kind: 'console', text: `The hive is open.\n  Board mode:  WORK\n  ${'x'.repeat(300)}` };
  const s = logSummary([banner]);
  assert.ok(!s.message.includes('\n') && s.message.length <= 200 && s.message.startsWith('14:03:01 The hive is open. Board mode: WORK'));
});
