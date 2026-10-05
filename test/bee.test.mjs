import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { chooseInvitees } from '../src/chat.mjs';
import { STARTERS, BEE_NAME, fill, createBee, chooseStarter, beeContext } from '../src/bee.mjs';

const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/o/${name}` });
function room(c, names) {
  const store = new HiveStore({ now: c.now });
  const buzz = new BuzzLog({ now: c.now, invite: (m, th) => chooseInvitees(store, th, m) });
  for (const n of names) store.observe(ev(n, 'Stop'), { chatty: true, project: 'Dm-Archive', model: 'claude-opus-5-5' });
  return { store, buzz };
}

test('fill: a starter with a placeholder it cannot fill is not eligible', () => {
  assert.equal(fill('{a} and {b}', { a: 'Ann', b: 'Bo' }), 'Ann and Bo');
  assert.equal(fill('{service} is down', { a: 'Ann' }), null);
});

test('every starter fits a chat line when filled with long names', () => {
  const ctx = { a: 'A'.repeat(20), b: 'B'.repeat(20), top: 'T'.repeat(20), low: 'L'.repeat(20), aProject: 'P'.repeat(30), bProject: 'Q'.repeat(30), aModel: 'claude-haiku-4-5-20251001', bModel: 'claude-opus-5-5', topScore: 12, lowScore: 1, service: 'Web App', serviceState: 'is degraded', quoteFrom: 'F'.repeat(20), quoteText: 'x'.repeat(90), quoteKind: 'human', agents: 5, services: 3 };
  for (const [id, t] of STARTERS) { const s = fill(t, ctx); assert.ok(s && s.length <= 280, `${id}: ${s?.length}`); }
});

test('a failing service makes the Bee ask who to tell', () => {
  const ctx = { a: 'Ann', b: 'Bo', top: 'Ann', low: 'Bo', topScore: 0, lowScore: 0, service: 'Web App', serviceState: 'is degraded', agents: 2, services: 1 };
  assert.match(chooseStarter(ctx, { rand: () => 0 }).text, /Web App is degraded/);
});

test('two listeners get one starter, from the Bee, inviting exactly those two; a third stays out', () => {
  const c = clock(); const { store, buzz } = room(c, ['Ann', 'Bo', 'Cy']);
  const bee = createBee({ store, buzz, now: c.now, rand: () => 0.3 });
  bee.tick();
  assert.equal(buzz.list().length, 0, 'they have only just arrived');
  c.advance(10_000); bee.tick();
  const [m] = buzz.list();
  assert.equal(m.from, BEE_NAME); assert.equal(m.kind, 'system'); assert.equal(m.invited.length, 2);
  const out = ['Ann', 'Bo', 'Cy'].find((n) => !m.invited.includes(n));
  assert.equal(buzz.hearable(m, out), false);
  bee.tick(); assert.equal(buzz.list().length, 1, 'not twice');
  bee.stop();
});

test('one listener alone, a live exchange, or an unanswered Bee line: no starter', () => {
  const c = clock(); const { store, buzz } = room(c, ['Ann']);
  const bee = createBee({ store, buzz, now: c.now });
  c.advance(10_000); bee.tick(); assert.equal(buzz.list().length, 0);
  store.observe(ev('Bo', 'Stop'), { chatty: true });
  buzz.post({ from: 'tom', kind: 'human', text: 'how is everyone getting on?' });
  c.advance(10_000); bee.tick(); assert.equal(buzz.list().length, 1, 'a person spoke 10s ago: stay out of it');
  bee.stop();
});

test('the Bee does not talk while the board is being seated (quiet) and a pair that includes a non-chatty agent does not count', () => {
  const c = clock(); const { store, buzz } = room(c, ['Ann']);
  store.observe(ev('Dan', 'Stop'), { chatty: false });
  const quiet = { on: true };
  const bee = createBee({ store, buzz, now: c.now, quiet });
  c.advance(10_000); bee.tick(); assert.equal(buzz.list().length, 0);
  bee.stop();
});

test('context carries project, model and production', () => {
  const c = clock(); const { store } = room(c, ['Ann', 'Bo']);
  const m = store.snapshot();
  const ctx = beeContext({ pair: m, members: m, messages: [] });
  assert.equal(ctx.aProject, 'Dm-Archive');
  assert.ok(ctx.aModel);
});
