import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiveStore, describe } from '../src/hive.mjs';
import { AWAY, LISTENING, pick } from '../src/phrases.mjs';

const MIN = 60_000;
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name, extra = {}) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/office/${name}`, ...extra });
const find = (store, id) => store.snapshot().find((m) => m.id === id);

test('an agent is active while it works and idle after Stop, with the minutes it has been idle', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Barry', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }), { project: 'rebarui' });
  let m = find(s, 's-Barry');
  assert.deepEqual([m.kind, m.name, m.project, m.status, m.statusLabel, m.activity], ['agent', 'Barry', 'rebarui', 'active', 'Active Now', 'pnpm test']);
  s.observe(ev('Barry', 'Stop'));
  assert.equal(find(s, 's-Barry').statusLabel, 'Idle');
  c.advance(12 * MIN);
  m = find(s, 's-Barry');
  assert.deepEqual([m.status, m.statusLabel], ['idle', 'Idle 12mins']);
});

test('a quiet agent becomes a ghost, not a failure, and drops off the board an hour later', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Gus', 'SessionStart'));
  s.observe(ev('Gus', 'Stop'));
  c.advance(30 * MIN);
  assert.deepEqual([find(s, 's-Gus').status, find(s, 's-Gus').statusLabel], ['ghost', 'Ghost']);
  c.advance(59 * MIN);
  assert.equal(find(s, 's-Gus').status, 'ghost'); // 89 minutes silent: still on the board
  c.advance(1 * MIN);
  assert.equal(find(s, 's-Gus'), undefined);      // 90 minutes silent: 30 to ghost + 60 as a ghost
});

test('a ghost that moves again comes straight back', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Gus', 'Stop'));
  c.advance(40 * MIN);
  assert.equal(find(s, 's-Gus').status, 'ghost');
  s.observe(ev('Gus', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b/c.ts' } }));
  assert.deepEqual([find(s, 's-Gus').status, find(s, 's-Gus').activity], ['active', 'c.ts']);
});

test('a busy agent whose tool call never finishes is stalled', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Hana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 9999' } }));
  c.advance(4 * MIN);
  assert.equal(find(s, 's-Hana').status, 'active');
  c.advance(1 * MIN);
  assert.deepEqual([find(s, 's-Hana').status, find(s, 's-Hana').statusLabel], ['stalled', 'Stalled']);
});

test('SessionEnd removes an agent at once', () => {
  const s = new HiveStore({ now: clock().now });
  s.observe(ev('Barry', 'SessionStart'));
  s.observe(ev('Barry', 'SessionEnd'));
  assert.equal(s.snapshot().length, 0);
});

test('a service that beats ok is active and healthy', () => {
  const s = new HiveStore({ now: clock().now });
  s.heartbeat({ id: 'dsl', name: 'DSL Service', project: 'Dm-Archive', message: 'DM-Archive DLS Worker Service' });
  const m = find(s, 'dsl');
  assert.deepEqual([m.kind, m.status, m.statusLabel, m.activity], ['service', 'active', 'Healthy', 'DM-Archive DLS Worker Service']);
});

test('a service that says it is degraded (leaking memory) is an active failure, with its own words', () => {
  const s = new HiveStore({ now: clock().now });
  s.heartbeat({ id: 'idx', name: 'Index Worker', status: 'degraded', message: 'memory climbing, may be leaking' });
  const m = find(s, 'idx');
  assert.deepEqual([m.status, m.statusLabel, m.activity], ['failure', 'Degraded', 'memory climbing, may be leaking']);
  s.heartbeat({ id: 'idx', name: 'Index Worker', status: 'failure', message: 'out of memory' });
  assert.deepEqual([find(s, 'idx').status, find(s, 'idx').statusLabel], ['failure', 'Failure']);
});

test('a service that misses its heartbeat has likely failed; it never ghosts', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.heartbeat({ id: 'dsl', name: 'DSL Service', ttlSec: 30 });
  c.advance(30_000);
  assert.equal(find(s, 'dsl').status, 'active');
  c.advance(1_000);
  let m = find(s, 'dsl');
  assert.deepEqual([m.status, m.statusLabel], ['failure', 'Not responding']);
  assert.match(m.activity, /no heartbeat for over a minute, likely failed/);
  c.advance(3 * 60 * MIN);
  assert.equal(find(s, 'dsl').status, 'failure'); // hours later: still shown as failed, not a ghost
  s.heartbeat({ id: 'dsl', name: 'DSL Service' });  // and it recovers on the next beat
  assert.equal(find(s, 'dsl').status, 'active');
});

test('status gone removes a service; a service silent for a day is dropped', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.heartbeat({ id: 'a', name: 'A' }); s.heartbeat({ id: 'b', name: 'B' });
  s.heartbeat({ id: 'a', status: 'gone' });
  assert.deepEqual(s.snapshot().map((m) => m.id), ['b']);
  c.advance(24 * 60 * MIN);
  assert.equal(s.snapshot().length, 0);
});

test('the wall lists the worst first: failure, stalled, active, idle, ghost', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Zed', 'Stop'));
  s.observe(ev('Amy', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }));
  s.heartbeat({ id: 'svc', name: 'Svc', status: 'degraded' });
  s.observe(ev('Old', 'Stop')); c.advance(31 * MIN); s.observe(ev('Zed', 'Stop')); s.observe(ev('Amy', 'Stop')); s.heartbeat({ id: 'svc', name: 'Svc', status: 'degraded' });
  assert.deepEqual(s.snapshot().map((m) => m.name), ['Svc', 'Amy', 'Zed', 'Old']);
});

test('describe shows a command or a file name, never a full path', () => {
  assert.equal(describe('Bash', { command: 'git status\nsecond line' }), 'git status');
  assert.equal(describe('Edit', { file_path: '/home/someone/private/notes/secret.md' }), 'secret.md');
  assert.equal(describe('Read', { file_path: 'reading the config' }), 'reading the config');
  assert.equal(describe('Task', {}), 'Task');
});

test('subscribers get the full wall on every change, and stop after unsubscribing', () => {
  const s = new HiveStore({ now: clock().now });
  const seen = [];
  const off = s.subscribe((m) => seen.push(m.map((x) => x.name)));
  s.heartbeat({ id: 'a', name: 'A' });
  s.observe(ev('Barry', 'SessionStart'));
  off();
  s.heartbeat({ id: 'b', name: 'B' });
  assert.deepEqual(seen, [['A'], ['A', 'Barry']]);
});

test('every status explains itself, in plain words', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Hana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'crawling the site' } }));
  assert.match(find(s, 's-Hana').statusReason, /^Working: last report \d+s ago, "crawling the site" in progress\./);
  c.advance(7 * MIN);
  assert.match(find(s, 's-Hana').statusReason, /Started "crawling the site" 7 min ago and has not reported finishing or going idle since .*no `hive idle`/);
  s.observe(ev('Hana', 'Stop'));
  c.advance(12 * MIN);
  assert.equal(find(s, 's-Hana').statusReason, 'Reported finishing its turn 12 min ago and has said nothing since.');
  c.advance(30 * MIN);
  assert.match(find(s, 's-Hana').statusReason, /^Silent for 42 min, so most likely just not active \(not a failure\)\. It drops off the board in 48 min\./);
  s.heartbeat({ id: 'dsl', name: 'DSL Service', status: 'degraded', message: 'memory climbing' });
  assert.match(find(s, 'dsl').statusReason, /reported it is struggling .*"memory climbing"\. That shows as a failure\./);
  c.advance(2 * MIN);
  assert.match(find(s, 'dsl').statusReason, /^No heartbeat for 2 min; it should report at least every 1 min, so it has likely failed\./);
});

test('an agent that joined without hooks says so, and one that did is not blamed', () => {
  const s = new HiveStore({ now: clock().now });
  s.observe(ev('Vint', 'SessionStart'), { project: 'getcodex', hooks: [] });
  s.observe(ev('Vint', 'Stop'));
  const vint = find(s, 's-Vint');
  assert.equal(vint.reports, 'chirps');
  assert.match(vint.statusReason, /It joined without hooks, so only what it says with `hive say` shows here/);
  s.observe(ev('Jean', 'SessionStart'), { hooks: ['claude'] });
  s.observe(ev('Jean', 'Stop'));
  assert.equal(find(s, 's-Jean').reports, 'hooks');
  assert.doesNotMatch(find(s, 's-Jean').statusReason, /without hooks/);
  s.observe(ev('Sim', 'SessionStart'));              // unknown (no hooks field): no claim either way
  assert.equal(find(s, 's-Sim').reports, undefined);
});

test('an idle card never keeps its last task: a chatty agent just done asks for more, anyone else has wandered off', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Bjarne', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'responding to tom' } }), { chatty: true });
  s.observe(ev('Quiet', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'responding to tom' } }), { chatty: false });
  s.observe(ev('Bjarne', 'Stop')); s.observe(ev('Quiet', 'Stop'));
  assert.ok(LISTENING.includes(find(s, 's-Bjarne').activity));
  assert.ok(AWAY.includes(find(s, 's-Quiet').activity));
  const first = find(s, 's-Bjarne').activity;
  c.advance(30_000);
  assert.equal(find(s, 's-Bjarne').activity, first, 'the line is stable between refreshes');
  c.advance(80_000); // past the listening window
  assert.ok(AWAY.includes(find(s, 's-Bjarne').activity));
});

test('pick is stable per seed and the lists have no duplicates', () => {
  assert.equal(pick(AWAY, 'a:1'), pick(AWAY, 'a:1'));
  assert.equal(new Set(AWAY).size, AWAY.length);
  assert.equal(new Set(LISTENING).size, LISTENING.length);
});

test('an agent quiet far longer than its own rhythm reads as Focusing, not stalled, and stalls only after five minutes', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  const step = () => { s.observe(ev('Quill', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } })); c.advance(2_000); s.observe(ev('Quill', 'PostToolUse')); c.advance(3_000); };
  for (let i = 0; i < 12; i++) step();                  // it normally reports every few seconds
  c.advance(10_000);
  assert.equal(find(s, 's-Quill').statusLabel, 'Active Now');
  c.advance(25_000);                                    // 35s of silence: past its usual, past the 30s floor
  let m = find(s, 's-Quill');
  assert.deepEqual([m.status, m.statusLabel], ['active', 'Focusing']);
  assert.match(m.statusReason, /longer than its usual .* between reports[\s\S]*stalled after 5 min/);
  c.advance(4.5 * MIN);
  assert.equal(find(s, 's-Quill').status, 'stalled');
  s.observe(ev('Quill', 'PostToolUse'));
  assert.equal(find(s, 's-Quill').statusLabel, 'Active Now', 'any report brings it straight back');
});

test('a slow-and-steady agent is allowed longer before Focusing than a quick one, and a new agent gets the default', () => {
  const c = clock(); const slow = new HiveStore({ now: c.now });
  for (let i = 0; i < 12; i++) { slow.observe(ev('Slow', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } })); c.advance(20_000); slow.observe(ev('Slow', 'PostToolUse')); c.advance(10_000); }
  c.advance(20_000);                                    // 30s of silence: past the 30s floor, but this one often goes 20s, so twice that is its line
  assert.equal(find(slow, 's-Slow').statusLabel, 'Active Now');
  c.advance(15_000);
  assert.equal(find(slow, 's-Slow').statusLabel, 'Focusing');
  const fresh = new HiveStore({ now: c.now });
  fresh.observe(ev('New', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }));
  c.advance(50_000); assert.equal(find(fresh, 's-New').statusLabel, 'Active Now');
  c.advance(15_000); assert.equal(find(fresh, 's-New').statusLabel, 'Focusing');
});

test('a very long service name is cut so it cannot ruin the card, and its id is untouched', () => {
  const s = new HiveStore();
  s.heartbeat({ id: 'a-service-with-a-really-quite-long-identifier', name: 'The Very Long Named Document Archive Ingestion Worker Service (production, eu-west)' });
  s.heartbeat({ id: 'short', name: 'DSL   Service' });
  const long = s.snapshot().find((m) => m.id.startsWith('a-service'));
  assert.equal(long.name.length, 28);
  assert.ok(long.name.endsWith('…'));
  assert.equal(long.id, 'a-service-with-a-really-quite-long-identifier');
  assert.equal(s.snapshot().find((m) => m.id === 'short').name, 'DSL Service', 'runs of spaces are tidied too');
});
