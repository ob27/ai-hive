import { after, before, test } from 'node:test';
import { AWAY } from '../src/phrases.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { createIngest } from '../src/ingest.mjs';
import { TOOLS, rawApiSnippets } from '../src/hooking-in.mjs';

const run = promisify(execFile);
const KEY = 'api-key';
const store = new HiveStore(); const buzz = new BuzzLog();
let server, base;

before(async () => {
  server = http.createServer(createIngest({ hive: store, buzz, key: KEY, defaultBase: () => 'x' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const member = (name) => store.snapshot().find((m) => m.name === name);

test('the documented curl example, run for real: the agent appears, works, goes idle and leaves', async () => {
  const { curl } = rawApiSnippets({ base, key: KEY, name: 'CurlBee', sid: 'curl-1' });
  // Run each documented step in turn and look at the wall in between.
  const steps = curl.split('\n').filter((l) => l.startsWith('send ') || l.startsWith('HIVE=') || l.startsWith('KEY=') || l.startsWith('send()'));
  const prelude = steps.filter((l) => l.startsWith('HIVE=') || l.startsWith('KEY=') || l.startsWith('send()')).join('\n');
  const events = steps.filter((l) => l.startsWith('send \''));
  const sh = async (line) => run('bash', ['-c', `${prelude}\n${line}`]);
  await sh(events[0]);
  assert.deepEqual([member('CurlBee').status, member('CurlBee').reports], ['idle', 'hooks']);
  await sh(events[1]);
  assert.deepEqual([member('CurlBee').status, member('CurlBee').activity], ['active', 'crawling the site']);
  await sh(events[2]); await sh(events[3]);
  assert.equal(member('CurlBee').status, 'idle');
  await sh(events[4]);
  assert.equal(member('CurlBee'), undefined);
});

test('the documented Python example (standard library only), run for real', async () => {
  const { python } = rawApiSnippets({ base, key: KEY, name: 'PyBee', sid: 'py-1' });
  const file = join(mkdtempSync(join(tmpdir(), 'hive-py-')), 'agent.py');
  // Stop before the final SessionEnd so the end state can be checked; the example itself is otherwise unmodified.
  writeFileSync(file, python.replace(/send\("SessionEnd"\).*$/m, ''));
  await run('python3', [file]);
  assert.deepEqual([member('PyBee').status, AWAY.includes(member('PyBee').activity), member('PyBee').reports], ['idle', true, 'hooks']);
});

test('the documented Node example, run for real', async () => {
  const { node } = rawApiSnippets({ base, key: KEY, name: 'NodeBee', sid: 'node-1' });
  const file = join(mkdtempSync(join(tmpdir(), 'hive-node-')), 'agent.mjs');
  writeFileSync(file, node.replace(/await send\("SessionEnd"\).*$/m, ''));
  await run(process.execPath, [file]);
  assert.deepEqual([member('NodeBee').status, AWAY.includes(member('NodeBee').activity)], ['idle', true]);
});

test('the documented buzz and heartbeat calls work (a chatty seat can buzz; a service shows up)', async () => {
  await fetch(`${base}/api/hooks/claude`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ session_id: 'b1', hook_event_name: 'SessionStart', cwd: '/office/MyAgent', hive: { chatty: true, hooks: ['custom'] } }) });
  const { buzz: buzzCmd, heartbeat } = rawApiSnippets({ base, key: KEY, name: 'MyAgent' });
  const lines = (s) => s.replace(/\\\n/g, ' ').split('\n').filter((l) => l.startsWith('curl'));
  for (const cmd of [...lines(buzzCmd), ...lines(heartbeat)]) await run('bash', ['-c', cmd]);
  assert.ok(buzz.list(20).some((m) => m.from === 'MyAgent' && m.text === 'phew, that was a hard one'));
  assert.equal(member('My Service').statusLabel, 'Healthy');
});

test('every way in is listed with an honest status', () => {
  assert.ok(TOOLS.length >= 10);
  for (const t of TOOLS) assert.ok(t.id && t.name && t.how && t.gets && t.status, `${t.id} is complete`);
  assert.equal(TOOLS.find((t) => t.id === 'claude').status, 'in daily use');
  assert.match(TOOLS.find((t) => t.id === 'browser').status, /cannot hook in directly/);
  for (const id of ['qwen', 'gemini', 'cursor', 'codex']) assert.match(TOOLS.find((t) => t.id === id).status, /not yet run in the real app/, `${id} is not claimed to be verified`);
});

test('the guide covers every way in, and the matrix in the guide matches the one the Join pages use', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'HOOKING_IN.md'), 'utf8');
  for (const t of TOOLS) {
    assert.ok(doc.includes(t.name), `docs/HOOKING_IN.md lists "${t.name}"`);
    assert.ok(doc.includes(t.status), `docs/HOOKING_IN.md carries the same status for ${t.id}: "${t.status}"`);
  }
});
