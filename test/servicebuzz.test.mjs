import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuzzLog } from '../src/buzz.mjs';
import { HiveStore } from '../src/hive.mjs';
import { handleHeartbeat, parseHeartbeat } from '../src/hive-http.mjs';
import { buzzFromHeartbeat, cleanBuzz, createServiceBuzz, extractBuzz } from '../src/servicebuzz.mjs';
import { createBuzzScanner, heartbeatBody, readNew } from '../src/heartbeat.mjs';

test('a tagged line is found anywhere in log text, in order, however it is wrapped', () => {
  assert.deepEqual(extractBuzz('<ai-hive-buzz>50% Complete</ai-hive-buzz>'), ['50% Complete']);
  assert.deepEqual(extractBuzz('2026-10-05 INFO start\n2026-10-05 INFO <ai-hive-buzz>step 1 done</ai-hive-buzz> ok\nnoise\n[x] <ai-hive-buzz>step 2 done</ai-hive-buzz>'), ['step 1 done', 'step 2 done']);
  assert.deepEqual(extractBuzz('<AI-HIVE-BUZZ>shouting works</AI-HIVE-BUZZ>'), ['shouting works']);
  assert.deepEqual(extractBuzz('<ai-hive-buzz>two\nlines   and  spaces</ai-hive-buzz>'), ['two lines and spaces'], 'one chat line');
  assert.deepEqual(extractBuzz('{"level":"info","msg":"<ai-hive-buzz>in JSON logs</ai-hive-buzz>"}'), ['in JSON logs']);
});

test('what is not a complete, non-empty tag is ignored', () => {
  assert.deepEqual(extractBuzz('<ai-hive-buzz>never closed'), []);
  assert.deepEqual(extractBuzz('</ai-hive-buzz> stray close <ai-hive-buzz>'), []);
  assert.deepEqual(extractBuzz('<ai-hive-buzz>   </ai-hive-buzz><ai-hive-buzz></ai-hive-buzz>'), []);
  assert.deepEqual(extractBuzz('<ai-hive-buzzer>nope</ai-hive-buzzer>'), []);
  assert.deepEqual(extractBuzz(''), []);
  assert.deepEqual(extractBuzz(undefined), []);
});

test('a line is cut to the chat\'s length, a burst to five lines, and stray tags inside are removed', () => {
  assert.equal(cleanBuzz('x'.repeat(500)).length, 280);
  assert.ok(cleanBuzz('x'.repeat(500)).endsWith('…'));
  assert.equal(cleanBuzz('a <ai-hive-buzz>b</ai-hive-buzz> c'), 'a b c');
  const many = Array.from({ length: 12 }, (_, i) => `<ai-hive-buzz>n${i}</ai-hive-buzz>`).join('\n');
  assert.deepEqual(extractBuzz(many), ['n0', 'n1', 'n2', 'n3', 'n4']);
});

test('a heartbeat contributes its buzz array, and tags in its message or logs, without repeats', () => {
  assert.deepEqual(buzzFromHeartbeat({ buzz: ['a', '  b  ', 7, '', null] }), ['a', 'b']);
  assert.deepEqual(buzzFromHeartbeat({ message: 'status <ai-hive-buzz>m</ai-hive-buzz>', logs: 'x <ai-hive-buzz>l</ai-hive-buzz>', buzz: ['m'] }), ['m', 'l']);
  assert.deepEqual(buzzFromHeartbeat({}), []);
  assert.deepEqual(buzzFromHeartbeat(null), []);
});

test('buzz and logs in a heartbeat are validated; everything else about it is as before', () => {
  assert.match(parseHeartbeat({ id: 'x', buzz: 'oops' }).error, /buzz must be an array of strings/);
  assert.match(parseHeartbeat({ id: 'x', buzz: [1] }).error, /buzz must be an array of strings/);
  assert.match(parseHeartbeat({ id: 'x', logs: 5 }).error, /logs must be a string/);
  const ok = parseHeartbeat({ id: 'svc', name: 'Billing', message: 'busy <ai-hive-buzz>40%</ai-hive-buzz>', buzz: ['hello'] });
  assert.deepEqual(ok.buzz, ['hello', '40%']);
  assert.equal(ok.value.buzz, undefined, 'the store is not given the buzz lines');
});

test('a service speaks in the chat as a 🤖 host line: it invites nobody, and says who it is', () => {
  const buzz = new BuzzLog();
  const post = createServiceBuzz({ buzz });
  assert.deepEqual(post('billing', 'Billing', ['50% Complete']), { posted: 1, dropped: 0 });
  const m = buzz.list(1)[0];
  assert.deepEqual([m.from, m.kind, m.text], ['🤖 Billing', 'system', '50% Complete']);
  assert.equal(m.invited, undefined, 'no agent is asked to answer a progress line');
});

test('a service repeating its last line is not repeated in the chat', () => {
  const buzz = new BuzzLog(); const post = createServiceBuzz({ buzz });
  post('s', 'S', ['50%']); post('s', 'S', ['50%', '50%']);
  assert.equal(buzz.list().filter((m) => m.text === '50%').length, 1);
  post('s', 'S', ['75%']); post('s', 'S', ['50%']);
  assert.deepEqual(buzz.list().map((m) => m.text), ['50%', '75%', '50%'], 'a different line in between lets it be said again');
});

test('each service has an hourly allowance, separate from the others, and it rolls', () => {
  let t = 1_000_000; const buzz = new BuzzLog({ now: () => t });
  const post = createServiceBuzz({ buzz, now: () => t, perHour: 3 });
  const r = post('a', 'A', ['1', '2', '3', '4', '5']);
  assert.deepEqual(r, { posted: 3, dropped: 2 });
  assert.deepEqual(post('b', 'B', ['x']), { posted: 1, dropped: 0 }, 'another service is not affected');
  t += 61 * 60_000;
  assert.deepEqual(post('a', 'A', ['6']), { posted: 1, dropped: 0 });
});

// --- over HTTP, through the real heartbeat handler ---------------------------------------------------------------------------------------------------
const KEY = 'sb-key';
const store = new HiveStore(); const buzz = new BuzzLog();
const serviceBuzz = createServiceBuzz({ buzz });
let server, base;
before(async () => {
  server = http.createServer((req, res) => { if (!handleHeartbeat(req, res, store, KEY, serviceBuzz)) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const beat = (body) => fetch(`${base}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/heartbeat with buzz lines puts them in the chat under the service\'s name, and still updates its card', async () => {
  assert.equal((await beat({ id: 'etl', name: 'Nightly ETL', message: 'running', buzz: ['migration 50% complete'] })).status, 204);
  assert.deepEqual(buzz.list().filter((m) => m.from.startsWith('🤖')).map((m) => [m.from, m.text]), [['🤖 Nightly ETL', 'migration 50% complete']]);
  assert.equal(store.snapshot().find((m) => m.id === 'etl').activity, 'running');
});

test('a tag in the heartbeat message is announced, and a service with no name is announced by its id', async () => {
  await beat({ id: 'cron7', message: '<ai-hive-buzz>backup done</ai-hive-buzz>' });
  assert.ok(buzz.list().some((m) => m.from === '🤖 cron7' && m.text === 'backup done'));
});

test('a heartbeat with no buzz posts nothing, and a refused one posts nothing', async () => {
  const before = buzz.list().length;
  await beat({ id: 'quiet', message: 'fine' });
  await beat({ id: 'bad', buzz: 'oops' });
  assert.equal(buzz.list().length, before);
});

test('the CLI body carries buzz lines only when there are some', () => {
  assert.deepEqual(heartbeatBody({ id: 'x', buzz: [] }), { id: 'x', status: 'ok' });
  assert.deepEqual(heartbeatBody({ id: 'x', buzz: ['a'] }).buzz, ['a']);
});

// --- reading logs: a file's new bytes and a stream's chunks ---------------------------------------------------------------------------------------
test('a followed log file yields only what was added, and starts again if it was rotated', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'sb-')), 'app.log');
  writeFileSync(f, 'old line <ai-hive-buzz>old</ai-hive-buzz>\n');
  let { text, offset } = readNew(f, 0);
  assert.match(text, /old/);
  ({ text, offset } = readNew(f, offset));
  assert.equal(text, '', 'nothing new');
  appendFileSync(f, 'new <ai-hive-buzz>fresh</ai-hive-buzz>\n');
  ({ text, offset } = readNew(f, offset));
  assert.deepEqual(extractBuzz(text), ['fresh']);
  writeFileSync(f, 'rotated <ai-hive-buzz>again</ai-hive-buzz>\n'); // shorter than the offset: a new file
  assert.deepEqual(extractBuzz(readNew(f, offset).text), ['again']);
  assert.deepEqual(readNew(join(tmpdir(), 'does-not-exist.log'), 5), { text: '', offset: 5 });
});

test('a tag split across two chunks is announced once, when it completes; an unfinished one waits', () => {
  const s = createBuzzScanner();
  assert.deepEqual(s.push('start <ai-hive-buzz>half '), []);
  assert.deepEqual(s.push('way</ai-hive-buzz> and <ai-hive-buzz>second</ai-hive-buzz> tail'), ['half way', 'second']);
  assert.deepEqual(s.push('plain log line\n'), []);
  assert.deepEqual(s.push('<ai-hive-buzz>whole</ai-hive-buzz><ai-hive-buzz>unfin'), ['whole']);
  assert.deepEqual(s.push('ished</ai-hive-buzz>'), ['unfinished']);
});

test('an unclosed tag that never ends is dropped rather than kept for ever', () => {
  const s = createBuzzScanner();
  s.push(`<ai-hive-buzz>${'x'.repeat(10_000)}`);
  assert.deepEqual(s.push('later line <ai-hive-buzz>ok</ai-hive-buzz>'), ['ok']);
});

test('the card shows the words of a tagged message, not the markup', () => {
  assert.equal(parseHeartbeat({ id: 'x', message: 'ok <ai-hive-buzz>50% complete</ai-hive-buzz>' }).value.message, 'ok 50% complete');
  assert.equal(parseHeartbeat({ id: 'x', message: 'plain' }).value.message, 'plain');
});
