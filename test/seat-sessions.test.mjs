import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'hive-sessions-'));
process.env.HIVE_HOME = HOME;
const { createSeat, loadSeat, rebindSession, releaseSession, seatForSession, windows } = await import('../src/seat.mjs');

test('two windows in one folder speak as two seats, and closing one leaves only its own seat', () => {
  for (const name of ['Ann', 'Bo']) createSeat({ url: 'http://x', token: 't', name, project: 'p', hooks: ['claude'] });
  // the folder's hook file names Bo only
  assert.equal(seatForSession('w1', 'p', 'Bo').name, 'Bo');
  assert.equal(seatForSession('w2', 'p', 'Bo').name, 'Ann', 'the second window takes the free seat');
  assert.equal(seatForSession('w1', 'p', 'Bo').name, 'Bo', 'a window keeps its seat');
  assert.equal(releaseSession('w1', 'Bo'), true, 'Bo has no window left: it may leave');
  assert.equal(releaseSession('w2', 'Bo'), true);
  assert.equal(seatForSession('w3', 'p', 'Bo').name, 'Bo');
  releaseSession('w3', 'Bo');
});

test('a seat shared by two windows (more windows than seats) stays until the last closes', () => {
  assert.equal(seatForSession('a', 'p', 'Bo').name, 'Bo');
  assert.equal(seatForSession('b', 'p', 'Bo').name, 'Ann');
  assert.equal(seatForSession('c', 'p', 'Bo').name, 'Bo', 'no free seat: shares the named one');
  assert.equal(releaseSession('a', 'Bo'), false, 'c still sits in Bo');
  assert.equal(releaseSession('c', 'Bo'), true);
});

test('two windows that start at the same instant never end up speaking as the same seat', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const seatMod = fileURLToPath(new URL('../src/seat.mjs', import.meta.url));
  const run = (home, sid) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', `const { seatForSession } = await import(${JSON.stringify(seatMod)}); console.log(seatForSession(${JSON.stringify(sid)}, 'p', 'Ann').name);`, '--input-type=module'], { env: { ...process.env, HIVE_HOME: home } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out.trim()));
  });
  for (let round = 0; round < 25; round++) {
    const home = mkdtempSync(join(tmpdir(), 'hive-race-'));
    process.env.HIVE_HOME = home;
    const { createSeat: make } = await import(`../src/seat.mjs?round=${round}`);
    for (const name of ['Ann', 'Bo']) make({ url: 'http://x', token: 't', name, project: 'p', hooks: ['claude'] });
    const [a, b] = await Promise.all([run(home, `wa${round}`), run(home, `wb${round}`)]);
    assert.notEqual(a, b, `round ${round}: both windows took ${a}`);
  }
});

test('rebind puts a window back on its own seat, and the hook keeps resolving it there', () => {
  for (const name of ['Dee', 'Don']) createSeat({ url: 'http://x', token: 't', name, project: 'q', hooks: ['claude'] });
  // the folder's hook file names Don; window r1 was handed the wrong seat after its own went missing
  assert.equal(seatForSession('r2', 'q', 'Don').name, 'Don');
  assert.equal(seatForSession('r1', 'q', 'Don').name, 'Dee');
  rebindSession('r1', 'Don');
  assert.equal(seatForSession('r1', 'q', 'Don').name, 'Don', 'it speaks as the seat it was put on');
  assert.equal(windows().find((w) => w.sid === 'r1').seat, 'Don');
  assert.equal(releaseSession('r2', 'Don'), false, 'r1 now sits in Don too, so closing r2 does not free it');
  releaseSession('r1', 'Don');
});

test('rebind refuses a seat that does not exist and leaves the window where it was', () => {
  assert.equal(seatForSession('r3', 'q', 'Don').name, 'Don');
  assert.throws(() => rebindSession('r3', 'Nobody'));
  assert.equal(windows().find((w) => w.sid === 'r3').seat, 'Don');
  releaseSession('r3', 'Don');
});

test('rebind --fresh gives the seat a new session id (a booted seat is ignored by its old one) and keeps the rest', () => {
  const before = loadSeat('Dee');
  rebindSession('r4', 'Dee');
  assert.equal(loadSeat('Dee').sessionId, before.sessionId, 'a plain rebind keeps the session id');
  rebindSession('r4', 'Dee', { fresh: true });
  const after = loadSeat('Dee');
  assert.notEqual(after.sessionId, before.sessionId);
  assert.match(after.sessionId, /^office-Dee-[0-9a-f]{8}$/);
  assert.deepEqual({ ...after, sessionId: 0 }, { ...before, sessionId: 0 }, 'name, host, token, project and slot are untouched');
  assert.equal(seatForSession('r4', 'q', 'Don').name, 'Dee');
  releaseSession('r4', 'Dee');
});

test('`hive rebind` lists windows, rebinds one (with --fresh), and says so when the seat is unknown', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = join(import.meta.dirname, '..', 'bin', 'office.mjs');
  const home = HOME;
  const run = (...args) => spawnSync(process.execPath, [cli, 'rebind', ...args], { env: { ...process.env, HIVE_HOME: home }, encoding: 'utf8' });
  assert.equal(seatForSession('c1', 'q', 'Don').name, 'Don');
  assert.match(run().stdout, /c1\s+Don/, 'no arguments: the windows the hive knows');
  const ok = spawnSync(process.execPath, [cli, 'rebind', 'Dee', '--session', 'c1', '--fresh'], { env: { ...process.env, HIVE_HOME: home }, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /now speaks as Dee/);
  assert.equal(seatForSession('c1', 'q', 'Don').name, 'Dee');
  const bad = spawnSync(process.execPath, [cli, 'rebind', 'Nobody', '--session', 'c1'], { env: { ...process.env, HIVE_HOME: home }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no seat called Nobody/);
  releaseSession('c1', 'Dee');
});
