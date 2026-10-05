import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), 'hive-sessions-'));
const { createSeat, releaseSession, seatForSession } = await import('../src/seat.mjs');

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
