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
