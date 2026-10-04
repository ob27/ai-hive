import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Monitor } from '../src/monitor.mjs';

const fakeRes = () => Object.assign(new EventEmitter(), { statusCode: 200 });
const clock = () => { let t = 1_000; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('requests are counted and logged once answered, and a key in the address is never kept', () => {
  const c = clock(); const m = new Monitor({ now: c.now, files: () => new Map() });
  const res = fakeRes(); m.track({ method: 'GET', url: '/agent?key=SECRET123&x=1' }, res, 'ingest'); c.advance(12); res.emit('close');
  const bad = fakeRes(); bad.statusCode = 404; m.track({ method: 'GET', url: '/nope' }, bad, 'screen'); bad.emit('close');
  const s = m.status();
  assert.deepEqual([s.requests.total, s.requests.byStatus['ingest 200'], s.requests.byStatus['screen 404']], [2, 1, 1]);
  const log = m.tail().map((e) => e.text).join('\n');
  assert.match(log, /ingest GET \/agent\?key=…&x=1 -> 200 \(12ms\)/);
  assert.equal(log.includes('SECRET123'), false);
});

test('a server error is logged as an error and shows up in the status', () => {
  const m = new Monitor({ files: () => new Map() });
  const res = fakeRes(); res.statusCode = 500; m.track({ method: 'POST', url: '/api/buzz' }, res, 'ingest'); res.emit('close');
  assert.match(m.status().errors.at(-1).text, /POST \/api\/buzz -> 500/);
});

test('the host knows when it is running older code than is on disk', () => {
  let files = new Map([['src/hive.mjs', '1:100'], ['src/buzz.mjs', '1:50']]);
  const m = new Monitor({ files: () => files });
  assert.deepEqual(m.status().code, { stale: false, changedSinceStart: [] });
  files = new Map([['src/hive.mjs', '2:120'], ['src/buzz.mjs', '1:50'], ['src/ingest.mjs', '2:10']]);
  assert.deepEqual(m.status().code, { stale: true, changedSinceStart: ['src/hive.mjs', 'src/ingest.mjs'] });
});

test('the log keeps only the newest entries and can be read from a point', () => {
  const m = new Monitor({ keep: 3, files: () => new Map() });
  for (let i = 1; i <= 5; i++) m.log('event', `e${i}`);
  assert.deepEqual(m.tail().map((e) => e.text), ['e3', 'e4', 'e5']);
  assert.deepEqual(m.tail(4).map((e) => e.text), ['e5']);
});
