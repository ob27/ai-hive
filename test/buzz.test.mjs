import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuzzLog, watchHive } from '../src/buzz.mjs';
import { HiveStore } from '../src/hive.mjs';

const MIN = 60_000;
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('a line is stored with its sender, kind and time; blank and oversized lines are refused', () => {
  const c = clock(); const b = new BuzzLog({ now: c.now });
  const r = b.post({ from: 'Barry', text: '  phew,   that was a hard one ' });
  assert.deepEqual([r.ok, r.message.from, r.message.kind, r.message.text, r.message.at], [true, 'Barry', 'agent', 'phew, that was a hard one', 1_000_000]);
  assert.equal(b.post({ from: 'Barry', text: '   ' }).status, 400);
  assert.equal(b.post({ from: 'Barry', text: 'x'.repeat(281) }).status, 400);
  assert.equal(b.post({ text: 'hi' }).status, 400);
});

test('an agent is capped per hour; the cap rolls; system lines are never capped', () => {
  const c = clock(); const b = new BuzzLog({ now: c.now, perHour: 3 });
  for (let i = 0; i < 3; i++) assert.ok(b.post({ from: 'Barry', text: `line ${i}` }).ok);
  const over = b.post({ from: 'Barry', text: 'one more' });
  assert.deepEqual([over.ok, over.status], [false, 429]);
  assert.ok(b.post({ from: 'Alice', text: 'my own allowance' }).ok);          // per agent, not shared
  assert.ok(b.post({ from: 'hive', kind: 'system', text: 'DSL is down' }).ok); // system is exempt
  c.advance(61 * MIN);
  assert.ok(b.post({ from: 'Barry', text: 'a new hour' }).ok);
});

test('the thread keeps only the most recent lines and list() returns the tail, oldest first', () => {
  const b = new BuzzLog({ keep: 5 });
  for (let i = 1; i <= 8; i++) b.post({ from: `a${i}`, kind: 'system', text: `m${i}` });
  assert.deepEqual(b.list(100).map((m) => m.text), ['m4', 'm5', 'm6', 'm7', 'm8']);
  assert.deepEqual(b.list(2).map((m) => m.text), ['m7', 'm8']);
});

test('subscribers hear every new line', () => {
  const b = new BuzzLog(); const seen = [];
  const off = b.subscribe((all) => seen.push(all.length));
  b.post({ from: 'a', text: 'one' }); b.post({ from: 'a', text: 'two' }); off(); b.post({ from: 'a', text: 'three' });
  assert.deepEqual(seen, [1, 2]);
});

const ev = (n, e, extra = {}) => ({ session_id: `s-${n}`, hook_event_name: e, cwd: `/office/${n}`, ...extra });
const lines = (b) => b.list(100).map((m) => m.text);

test('real changes on the wall become system lines: joins, a service failing, recovering and leaving', () => {
  const c = clock(); const store = new HiveStore({ now: c.now }); const b = new BuzzLog({ now: c.now });
  watchHive(store, b);
  store.heartbeat({ id: 'dsl', name: 'DSL Service' });          // first snapshot only seeds
  assert.deepEqual(lines(b), []);
  store.observe(ev('Barry', 'SessionStart'));
  store.heartbeat({ id: 'dsl', name: 'DSL Service', status: 'degraded', message: 'memory climbing' });
  store.heartbeat({ id: 'dsl', name: 'DSL Service' });
  store.observe(ev('Barry', 'SessionEnd'));
  assert.deepEqual(lines(b), ['Barry joined the hive.', 'DSL Service reports trouble: memory climbing', 'DSL Service is healthy again.', 'Barry left the hive.']);
});

test('a service that stops responding is announced as likely failed; a ghost leaving is "drifted away"', () => {
  const c = clock(); const store = new HiveStore({ now: c.now }); const b = new BuzzLog({ now: c.now });
  watchHive(store, b);
  store.heartbeat({ id: 'dsl', name: 'DSL Service', ttlSec: 30 });
  store.observe(ev('Gus', 'Stop'));
  c.advance(31_000);
  store.emit();                                                  // the host's ticker does this on a timer
  c.advance(31 * MIN); store.emit();                             // Gus has gone quiet long enough to be a ghost
  c.advance(60 * MIN); store.emit();                             // and an hour later he drops off
  assert.ok(lines(b).includes('DSL Service stopped responding and has likely failed.'));
  assert.ok(lines(b).includes('Gus drifted away.'));
});

test('a reply carries a snapshot of the line it answers, so it can be shown quoted', () => {
  const b = new BuzzLog({ keep: 3 });
  const first = b.post({ from: 'Tom', kind: 'human', text: 'how is everyone doing today? '.repeat(7) }).message;
  const reply = b.post({ from: 'Barry', text: 'fine, thanks', replyTo: first.id }).message;
  assert.deepEqual([reply.quote.id, reply.quote.from, reply.quote.kind], [first.id, 'Tom', 'human']);
  assert.ok(reply.quote.text.length <= 140 && reply.quote.text.endsWith('…'));
  for (let i = 0; i < 4; i++) b.post({ from: 'x', kind: 'system', text: `later ${i}` });
  assert.equal(b.list(10).find((m) => m.id === reply.id), undefined);      // the thread has moved on...
  assert.equal(reply.quote.from, 'Tom');                                   // ...but the quote does not need the original
  assert.equal(b.post({ from: 'Alice', text: 'hello', replyTo: 9999 }).message.quote, undefined); // an unknown id is ignored
});

test('an event line can be quoted like any other: a comment on a failure carries the event it is about', () => {
  const store = new HiveStore(); const b = new BuzzLog(); watchHive(store, b);
  store.heartbeat({ id: 'dsl', name: 'DSL Service' });
  store.heartbeat({ id: 'dsl', name: 'DSL Service', status: 'failure', message: 'out of memory' });
  const event = b.list(10).find((m) => m.kind === 'system');
  const comment = b.post({ from: 'Alice', text: 'oh no, that service is down', replyTo: event.id }).message;
  assert.deepEqual([comment.quote.kind, comment.quote.from, comment.quote.id], ['system', 'hive', event.id]);
  assert.match(comment.quote.text, /DSL Service reports a failure/);
});

test('waitFor: returns at once when there is something new, and wakes when someone else speaks', async () => {
  const { BuzzLog } = await import('../src/buzz.mjs');
  const log = new BuzzLog();
  log.post({ from: 'Ann', kind: 'agent', text: 'hello' });
  assert.equal((await log.waitFor(0, 'Bob', 50)).length, 1);        // already there
  assert.equal((await log.waitFor(1, 'Bob', 30)).length, 0);        // nothing new: times out empty
  const pending = log.waitFor(1, 'Bob', 2000);
  log.post({ from: 'Bob', kind: 'agent', text: 'my own line' });     // own lines never wake it
  log.post({ from: 'Tom', kind: 'human', text: 'hi Bob' });
  const got = await pending;
  assert.deepEqual(got.map((m) => m.from), ['Tom']);
  assert.equal(log.listeners.size, 0);                               // no leaked subscription
});
