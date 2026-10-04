import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog, watchHive } from '../src/buzz.mjs';
import { handleBuzzPost, handleBuzzRead, handleHiveRead, handleHumanBuzz } from '../src/hive-http.mjs';

const KEY = 'buzz-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
const store = new HiveStore();
const buzz = new BuzzLog({ perHour: 3 });
watchHive(store, buzz);
const home = mkdtempSync(join(tmpdir(), 'hive-buzz-'));
let server, base;

const ev = (n, e) => ({ session_id: `s-${n}`, hook_event_name: e, cwd: `/office/${n}` });
const seat = (name, chatty) => {
  mkdirSync(join(home, 'seats'), { recursive: true });
  writeFileSync(join(home, 'seats', `${name}.json`), JSON.stringify({ name, url: base, token: KEY, project: 'rebarui', chatty, sessionId: `s-${name}`, cwd: `/office/${name}` }));
};
const cli = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, OFFICE_HOME: home, OFFICE_SEAT: '' } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => resolve({ status, out, err }));
});

before(async () => {
  server = http.createServer((req, res) => { handleBuzzPost(req, res, store, buzz, KEY) || handleBuzzRead(req, res, buzz, KEY) || handleHumanBuzz(req, res, buzz) || handleHiveRead(req, res, store, '/nonexistent', buzz, { responder: true }) || res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  store.observe(ev('Barry', 'SessionStart'), { project: 'rebarui', chatty: true });
  store.observe(ev('Alice', 'SessionStart'), { project: 'rebarui', chatty: false });
  seat('Barry', true); seat('Alice', false); seat('Ghosty', true);
});
after(() => server.close());

test('a chatty agent can buzz, and the line shows up for the screen and for other agents', async () => {
  const r = await cli('buzz', '--seat', 'Barry', 'phew, that was a hard one');
  assert.equal(r.status, 0, r.err);
  const thread = await (await fetch(`${base}/hive/buzz`)).json();
  assert.ok(thread.some((m) => m.from === 'Barry' && m.kind === 'agent' && m.text === 'phew, that was a hard one'));
  const read = await cli('buzz', '--read', '--seat', 'Alice');
  assert.match(read.out, /Barry: phew, that was a hard one/);
  assert.match(read.out, /\[hive\]: Alice joined the hive\./); // the host announces joins (the first snapshot only seeds)
});

test('an agent that did not join --chatty is refused, and so is a name that is not in the hive', async () => {
  const a = await cli('buzz', '--seat', 'Alice', 'hello?');
  assert.equal(a.status, 1);
  assert.match(a.err, /not in chatty mode/);
  const g = await cli('buzz', '--seat', 'Ghosty', 'hello?');
  assert.match(g.err, /not in the hive/);
});

test('the per-agent cap is reported as a clear error', async () => {
  await cli('buzz', '--seat', 'Barry', 'two');
  await cli('buzz', '--seat', 'Barry', 'three');
  const r = await cli('buzz', '--seat', 'Barry', 'four');
  assert.equal(r.status, 1);
  assert.match(r.err, /buzzed 3 times this hour/);
});

test('buzzing needs the key and the buzz stream sends the thread', async () => {
  assert.equal((await fetch(`${base}/api/buzz`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/buzz`)).status, 401);
  const res = await fetch(`${base}/hive/buzz/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /phew, that was a hard one/);
});

test('a person types into the wall: no key, a clean name, marked human; bad input is refused', async () => {
  const post = (body) => fetch(`${base}/hive/buzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ name: 'Tom', text: 'hello bots' })).status, 204);
  assert.equal((await post({ name: '<script>x</script>', text: 'second' })).status, 204);
  const thread = await (await fetch(`${base}/hive/buzz`)).json();
  const mine = thread.filter((m) => m.kind === 'human');
  assert.deepEqual(mine.map((m) => [m.from, m.text]), [['Tom', 'hello bots'], ['Human', 'second']]);
  assert.equal((await post({ name: 'Tom', text: '   ' })).status, 400);
  assert.equal((await post({ name: 'Tom', text: 'x'.repeat(300) })).status, 400);
});

test('/hive/info says whether the bots will answer', async () => {
  assert.deepEqual(await (await fetch(`${base}/hive/info`)).json(), { responder: true });
});

test('replyTo travels through the CLI and the wall box, and --read shows ids and replies', async () => {
  const target = (await (await fetch(`${base}/hive/buzz`)).json()).find((m) => m.text === 'hello bots');
  await fetch(`${base}/hive/buzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tom', text: 'a reply from the box', replyTo: target.id }) });
  const fromBox = (await (await fetch(`${base}/hive/buzz`)).json()).find((m) => m.text === 'a reply from the box');
  assert.equal(fromBox.quote.id, target.id);
  const store2 = (await cli('buzz', '--read', '--seat', 'Alice')).out;
  assert.match(store2, new RegExp(`#${fromBox.id} .*Tom \\(human\\) \\(replying to #${target.id}\\): a reply from the box`));
});
