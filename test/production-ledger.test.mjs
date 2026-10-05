import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, localDay } from '../src/production.mjs';
import { HiveStore } from '../src/hive.mjs';

const file = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'production.json');
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('production is kept per day (the host\'s local day) and survives a restart', () => {
  const f = file(); let t = at(2026, 10, 4);
  const l = new Ledger({ file: f, now: () => t });
  l.add('site#0', 1.5, 'Ann'); l.add('site#1', 0.5, 'Bo');
  t = at(2026, 10, 5, 23); l.add('site#0', 2, 'Ann');
  assert.deepEqual(l.daily(), [{ date: '2026-10-04', value: 2 }, { date: '2026-10-05', value: 2 }]);
  l.save();
  assert.deepEqual(new Ledger({ file: f }).daily(), l.daily());
  assert.equal(localDay(at(2026, 1, 9)), '2026-01-09');
});

test('projects are summed over their agents, biggest first, top five, and a count made before slots existed is its own entry', () => {
  const l = new Ledger({ file: file() });
  for (const [k, n] of [['alpha#0', 3], ['alpha#1', 4], ['beta#0', 5], ['gamma#0', 1], ['delta#0', 2], ['eps#0', 0.5], ['zeta#0', 0.2], ['LegacyName', 6]]) l.add(k, n);
  assert.deepEqual(l.projects(5), [{ name: 'alpha', turns: 7 }, { name: 'LegacyName', turns: 6 }, { name: 'beta', turns: 5 }, { name: 'delta', turns: 2 }, { name: 'gamma', turns: 1 }]);
});

test('the store reports the top projects (demo agents grouped by their project too) and the daily series', () => {
  const l = new Ledger({ file: file() });
  const s = new HiveStore({ ledger: l });
  l.add('site#0', 3, 'Ann');
  const p = s.production();
  assert.deepEqual(p.projects, [{ name: 'site', turns: 3 }]);
  assert.equal(s.productionDays().length, 1);
  assert.equal(new HiveStore().productionDays().length, 0, 'no ledger, no history');
});
