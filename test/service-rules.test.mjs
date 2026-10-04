import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, evaluateRules, parseRules } from '../src/service-rules.mjs';

const MIN = 60_000;
const NOW = 10_000_000;
/** One reading a minute for `minutes`, the last at NOW, each value from fn(minutesAgo). */
const series = (metric, minutes, fn) => Array.from({ length: minutes + 1 }, (_, i) => ({ at: NOW - (minutes - i) * MIN, [metric]: fn(minutes - i) }));
const run = (text, samples) => evaluateRules(parseRules(text).rules, samples, NOW);

test('the default rules parse, and a line that does not is reported with its number and why', () => {
  const ok = parseRules(DEFAULT_RULES);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rules.length, 11);
  const bad = parseRules('cpu >> 3\nfoo > 3 -> degraded\nmem > 5 for xx -> failure\n# a comment\n\ncpu > 1 -> degraded');
  assert.deepEqual(bad.errors.map((e) => e.line), [1, 2, 3]);
  assert.match(bad.errors[1].error, /unknown metric "foo"/);
  assert.equal(bad.rules.length, 1);
});

test('a threshold fires at once, and one with "for" only after it has held for that long', () => {
  assert.equal(run('mem > 97 -> failure "gone ({value}%)"', [{ at: NOW, mem: 98 }]).reasons[0].text, 'gone (98%)');
  assert.equal(run('mem > 97 -> failure', [{ at: NOW, mem: 90 }]).status, 'ok');
  const rule = 'cpu > 90 for 2m -> degraded "hot cpu"';
  assert.equal(run(rule, series('cpu', 3, () => 95)).status, 'degraded', 'three minutes over 90');
  assert.equal(run(rule, series('cpu', 1, () => 95)).status, 'ok', 'only a minute of history: too early to say');
  assert.equal(run(rule, series('cpu', 4, (ago) => (ago === 1 ? 50 : 95))).status, 'ok', 'it dipped inside the window');
});

test('a steady climb is a leak, a spike or a saw-tooth is not', () => {
  const rule = 'mem rises 15 in 10m -> degraded "up {delta} points"';
  const leak = run(rule, series('mem', 10, (ago) => 40 + (10 - ago) * 3));
  assert.deepEqual([leak.status, leak.reasons[0].text], ['degraded', 'up 30 points']);
  assert.equal(run(rule, series('mem', 10, (ago) => (ago === 0 ? 80 : 40))).status, 'ok', 'a spike at the end');
  assert.equal(run(rule, series('mem', 10, (ago) => (ago % 2 ? 40 : 60))).status, 'ok', 'a saw-tooth');
  assert.equal(run(rule, series('mem', 2, (ago) => 40 + (2 - ago) * 10)).status, 'ok', 'too little history');
});

test('the worst rule sets the status, every rule that fired is listed, and each metric is marked for the screen', () => {
  const r = run(DEFAULT_RULES, [{ at: NOW, cpu: 50, mem: 98, temp: 120, disk: 92 }]);
  assert.equal(r.status, 'failure');
  assert.deepEqual(r.reasons.map((x) => [x.metric, x.status]).sort(), [['disk', 'degraded'], ['mem', 'failure'], ['temp', 'degraded'], ['temp', 'failure']]);
  assert.deepEqual(r.states, { mem: 'bad', temp: 'bad', disk: 'warn' });
});

test('a reading that is too old is not judged', () => {
  assert.equal(run('temp > 100 -> failure', [{ at: NOW - 10 * MIN, temp: 120 }]).status, 'ok');
});

import { HiveStore } from '../src/hive.mjs';

test('a service that streams its machine stats is judged by the rules, and the status says why', () => {
  let t = 1_000_000; const store = new HiveStore({ now: () => t });
  const beat = (metrics, extra = {}) => store.heartbeat({ id: 'dsl', name: 'DSL Service', metrics, ttlSec: 120, ...extra });
  const m = () => store.snapshot().find((x) => x.id === 'dsl');
  beat({ cpu: 30, mem: 50, load: 40, disk: 60, temp: 55 });
  assert.deepEqual([m().statusLabel, m().status], ['Healthy', 'active']);
  assert.deepEqual(m().metrics, { cpu: 30, mem: 50, load: 40, disk: 60, temp: 55, at: t });
  t += 30_000; beat({ cpu: 30, mem: 50, temp: 120 });
  assert.deepEqual([m().statusLabel, m().status, m().activity], ['Failure', 'failure', 'Overheating (120°C)']);
  assert.match(m().statusReason, /The Hive's rules saw: Running hot \(120°C\); Overheating \(120°C\)/);
  assert.deepEqual(m().metricStates, { temp: 'bad' });
  t += 30_000; beat({ cpu: 30, mem: 50, temp: 60 });
  assert.equal(m().statusLabel, 'Healthy', 'it cools down: the status follows');
  // memory climbing a few points a beat for ten minutes is called a leak, though the service itself says everything is fine
  for (let i = 0; i < 21; i++) { t += 30_000; beat({ cpu: 30, mem: 40 + i * 1.5, temp: 60 }); }
  assert.deepEqual([m().statusLabel, m().status], ['Degraded', 'failure']);
  assert.match(m().activity, /^Memory climbing: up [\d.]+ points in 10 minutes/);
  assert.deepEqual(m().metricStates, { mem: 'warn' });
});

test('a service that reports itself degraded stays degraded whatever the machine readings say, and one with no readings is as before', () => {
  const store = new HiveStore();
  store.heartbeat({ id: 'a', name: 'A', status: 'degraded', message: 'I am slow', metrics: { cpu: 10 } });
  store.heartbeat({ id: 'b', name: 'B', message: 'plain' });
  const [a, b] = ['a', 'b'].map((id) => store.snapshot().find((x) => x.id === id));
  assert.deepEqual([a.statusLabel, a.activity], ['Degraded', 'I am slow']);
  assert.deepEqual([b.statusLabel, b.activity, b.metrics], ['Healthy', 'plain', undefined]);
});

test('a heartbeat\'s metrics are checked: numbers only, clamped, unknown keys ignored', async () => {
  const { parseHeartbeat } = await import('../src/hive-http.mjs');
  assert.deepEqual(parseHeartbeat({ id: 'x', metrics: { cpu: 41.5, temp: 999, junk: 1, mem: -5 } }).value.metrics, { cpu: 41.5, mem: 0, temp: 250 });
  assert.match(parseHeartbeat({ id: 'x', metrics: { cpu: 'high' } }).error, /metrics\.cpu must be a number/);
  assert.match(parseHeartbeat({ id: 'x', metrics: [1] }).error, /metrics must be an object/);
  assert.match(parseHeartbeat({ id: 'x', metrics: { cpu: [10, 20, 30, 40] } }).error, /metrics\.cpu must be one number: send the average across all of them/, 'several CPUs or GPUs: one aggregated number, not one per core');
  assert.equal(parseHeartbeat({ id: 'x', metrics: { gpu: 55 } }).value.metrics.gpu, 55);
  assert.equal(parseHeartbeat({ id: 'x', metrics: { junk: 1 } }).value.metrics, undefined);
});
