import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuzzLog, watchHive } from '../src/buzz.mjs';
import { HiveStore } from '../src/hive.mjs';
import { SIM_NAMES, createDemoSim } from '../scripts/demo-sim.mjs';

const ev = (n, e, extra = {}) => ({ session_id: `real-${n}`, hook_event_name: e, cwd: `/office/${n}`, ...extra });
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function board() {
  const store = new HiveStore(); const buzz = new BuzzLog({ perHour: 1000 }); const quiet = { on: false };
  const sim = createDemoSim({ store, buzz, quiet });
  watchHive(store, buzz, quiet);
  return { store, buzz, sim, quiet };
}

test('Demo seats the simulated crowd and its two services; stopping shows them the door', async () => {
  const { store, sim } = board();
  sim.start();
  assert.equal(sim.running, true);
  const names = store.snapshot().map((m) => m.name);
  for (const n of SIM_NAMES) assert.ok(names.includes(n), `${n} is seated`);
  assert.ok(names.includes('DSL Service') && names.includes('Index Worker'));
  sim.stop();
  assert.equal(sim.running, false);
  assert.deepEqual(store.snapshot(), []);
});

test('Work mode only removes the simulation: a real agent and a real service stay, and keep what they said', async () => {
  const { store, buzz, sim } = board();
  store.observe(ev('Tom', 'SessionStart'), { project: 'rebarui', chatty: true });
  store.heartbeat({ id: 'billing', name: 'Billing API' });
  buzz.post({ from: 'Tom', kind: 'agent', text: 'a real line' });
  sim.start();
  await settle();
  assert.ok(store.snapshot().length > 20);
  sim.stop();
  assert.deepEqual(store.snapshot().map((m) => m.name).sort(), ['Billing API', 'Tom']);
  assert.ok(buzz.list(50).some((m) => m.from === 'Tom' && m.text === 'a real line'));
});

test('everything the simulated bees said is taken back, including the announcements about them', async () => {
  const { buzz, sim } = board();
  sim.start();
  await settle();
  assert.ok(buzz.list(50).some((m) => m.from === 'Barry'), 'the simulation spoke');
  sim.stop();
  await settle();
  assert.deepEqual(buzz.list(50), []);
});

test('seating or removing the whole crowd does not flood the buzz with joined and left lines', async () => {
  const { buzz, sim } = board();
  sim.start();
  await settle();
  assert.equal(buzz.list(50).filter((m) => /joined the hive|reporting in/.test(m.text)).length, 0);
  sim.stop();
  await settle();
  assert.equal(buzz.list(50).filter((m) => /left the hive|signed off|drifted away/.test(m.text)).length, 0);
});

test('a real agent joining while the simulation runs is still announced', async () => {
  const { store, buzz, sim } = board();
  sim.start();
  await settle(120);
  store.observe(ev('Nina', 'SessionStart'), { chatty: true });
  assert.ok(buzz.list(50).some((m) => m.text === 'Nina joined the hive.'));
  sim.stop();
});

test('it can be started again after being stopped, and starting twice does nothing extra', async () => {
  const { store, sim } = board();
  sim.start(); sim.start();
  const first = store.snapshot().length;
  sim.stop(); sim.stop();
  sim.start();
  assert.equal(store.snapshot().length, first);
  sim.stop();
});

test('a stopped simulation does not keep acting: nothing reappears afterwards', async () => {
  const { store, sim } = board();
  sim.start();
  await settle(100);
  sim.stop();
  await settle(300);
  assert.deepEqual(store.snapshot(), []);
});
