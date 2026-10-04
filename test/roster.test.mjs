import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { Ledger } from '../src/production.mjs';
import { Roster } from '../src/roster.mjs';
import { createIngest } from '../src/ingest.mjs';
import { nameKind } from '../src/avatars.mjs';

const tmpFile = (n) => join(mkdtempSync(join(tmpdir(), 'hive-roster-')), n);

test('a project always gets the same cast: slot 0 is the same name every time, a second agent gets slot 1, and a freed slot comes back', () => {
  const file = tmpFile('roster.json');
  const r = new Roster({ file });
  const a = r.claim('rebarui');
  const b = r.claim('rebarui', { occupied: new Set([a.slot]) });
  assert.deepEqual([a.slot, b.slot], ['rebarui#0', 'rebarui#1']);
  assert.notEqual(a.name, b.name);
  assert.equal(r.claim('rebarui', { occupied: new Set([b.slot]) }).name, a.name, 'slot 0 is free again: the same agent steps back in');
  const again = new Roster({ file }); // the host restarted
  assert.equal(again.claim('rebarui').name, a.name);
  assert.equal(again.nameOf('rebarui#1'), b.name);
});

test('names are never shared between slots or projects, and a name in use by someone else makes a slot unusable', () => {
  const r = new Roster({ file: tmpFile('roster.json') });
  const names = ['alpha', 'beta', 'gamma'].flatMap((p) => [0, 1, 2].map(() => 0).map((_, i) => r.claim(p, { occupied: new Set(Array.from({ length: i }, (_, k) => `${p}#${k}`)) }).name));
  assert.equal(new Set(names).size, names.length);
  const first = new Roster({ file: tmpFile('x.json') }).claim('p').name;
  const r2 = new Roster({ file: tmpFile('y.json') });
  assert.equal(r2.claim('p', { taken: new Set([first]) }).slot, 'p#1', 'someone is already sitting under that name');
});

test('production counted by name before slots existed moves onto the slot once, and shows under the agent\'s name', () => {
  const file = tmpFile('production.json');
  const ledger = new Ledger({ file, saveMs: 0 });
  ledger.add('Leslie', 17);
  assert.equal(ledger.adopt('Leslie', 'rebarui#0'), true);
  assert.deepEqual([ledger.get('Leslie'), ledger.get('rebarui#0')], [0, 17]);
  assert.equal(ledger.adopt('Leslie', 'rebarui#0'), false, 'only once');
  assert.deepEqual(ledger.top(3), [{ name: 'Leslie', turns: 17 }]);
  ledger.save();
  assert.equal(new Ledger({ file }).get('rebarui#0'), 17);
});

// --- end to end: real CLIs join from two folders called the same ---
const KEY = 'roster-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
let store, server, addr, root;
before(async () => {
  store = new HiveStore({ ledger: new Ledger({ file: tmpFile('production.json'), saveMs: 0 }) });
  server = http.createServer(createIngest({ hive: store, buzz: new BuzzLog(), key: KEY, defaultBase: () => addr, roster: new Roster({ file: tmpFile('roster.json') }), seatNames: () => store.snapshot().filter((m) => m.kind === 'agent').map((m) => m.name) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  addr = `127.0.0.1:${server.address().port}`;
  root = mkdtempSync(join(tmpdir(), 'hive-cast-'));
  for (const d of ['one/rebarui', 'two/rebarui', 'three/rebarui']) mkdirSync(join(root, d), { recursive: true });
});
after(() => server.close());

const run = (dir, args, stdin) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: join(root, dir), env: { ...process.env, OFFICE_HOME: join(root, 'home'), OFFICE_SEAT: '', HIVE_SEAT: '' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.on('close', (status) => resolve({ status, out }));
  if (stdin !== undefined) child.stdin.end(JSON.stringify(stdin)); else child.stdin.end();
});
const member = (slot) => store.snapshot().find((m) => m.slot === slot);

test('two agents joining from folders with the same project name get slots 0 and 1; the same agent coming back gets its slot (and name) again', async () => {
  const one = await run('one/rebarui', ['join', addr, '--key', KEY]);
  const two = await run('two/rebarui', ['join', addr, '--key', KEY]);
  assert.equal(one.status, 0, one.out); assert.equal(two.status, 0, two.out);
  const [a, b] = [member('rebarui#0'), member('rebarui#1')];
  assert.ok(a && b && a.name !== b.name);
  assert.equal((await run('one/rebarui', ['leave', '--seat', a.name])).status, 0);
  await run('three/rebarui', ['join', addr, '--key', KEY]);
  assert.equal(member('rebarui#0').name, a.name, 'the next agent from the project steps into the free slot, with the same name');
  assert.equal(member('rebarui#1').name, b.name);
});

test('production follows the slot: a turn counts for the slot even when the agent was given another name', async () => {
  const slot0 = member('rebarui#0');
  await run('three/rebarui', ['hook', '--seat', slot0.name], { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' }, session_id: 'x', cwd: '/x' });
  await run('three/rebarui', ['hook', '--seat', slot0.name], { hook_event_name: 'Stop', session_id: 'x', cwd: '/x' });
  assert.equal(member('rebarui#0').turns, 1, 'a turn that edited a file is a whole cell');
  await run('three/rebarui', ['leave', '--seat', slot0.name]);
  assert.equal((await run('one/rebarui', ['join', addr, 'Nickname', '--key', KEY])).status, 0);
  const renamed = member('rebarui#0');
  assert.equal(renamed.name, 'Nickname');
  assert.equal(renamed.turns, 1, 'renamed, same agent: its turns came with it');
  assert.equal(store.production().total, 1);
  assert.ok(['male', 'female', 'androgynous'].includes(nameKind(renamed.name)));
});

test('rejoining under a name that already had turns counted (before slots) carries them onto the slot', async () => {
  store.ledger.add('Veteran', 9);
  assert.equal((await run('three/rebarui', ['join', addr, 'Veteran', '--key', KEY])).status, 0);
  const m = store.snapshot().find((x) => x.name === 'Veteran');
  assert.equal(m.turns, 9);
  assert.ok(m.slot?.startsWith('rebarui#'));
});
