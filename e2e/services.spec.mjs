// Services (anything that is not an agent): heartbeats, the host's rules over machine metrics, and silence.
import { test, expect } from './harness/fixtures.mjs';
import { ServiceAgent } from './harness/agents.mjs';
import { runCli, until } from './harness/hive.mjs';

test('a healthy service, a degraded one with its message, and a failed one show as such', async ({ hive, wall }) => {
  const ok = new ServiceAgent(hive, 'svc-ok', { name: 'Billing' });
  await ok.beat();
  await wall.expectStatus('Billing', 'Healthy');
  await ok.beat({ status: 'degraded', message: 'queue is backing up' });
  await wall.expectStatus('Billing', 'Degraded');
  await wall.expectText('Billing', /queue is backing up/);
  await ok.beat({ status: 'failure', message: 'down' });
  await expect.poll(async () => (await hive.member('Billing')).status).toBe('failure');
  await ok.beat({ status: 'gone' });
  await wall.expectGone('Billing');
});

test('machine metrics that break a rule turn the service Degraded, with the reason; and the gauges appear in its details', async ({ hive, wall }) => {
  const s = new ServiceAgent(hive, 'svc-disk', { name: 'Archive' });
  await runCli(hive, ['heartbeat', '--id', 'svc-disk', '--name', 'Archive', '--url', hive.ingest, '--key', hive.key, '--metric', 'disk=95', '--metric', 'net=250', '--metric', 'temp=60']);
  await expect.poll(async () => (await hive.member('Archive'))?.status).toBe('failure');
  const m = await hive.member('Archive');
  expect(m.metrics.net).toBe(250);
  expect(m.signs.join(' ')).toMatch(/Disk is 95% full/);
  await wall.page.reload();
  await wall.openDetails('Archive');
  await expect(wall.page.getByRole('group', { name: 'Machine readings' })).toContainText('250M');
  await s.beat({ status: 'gone' });
});

test('the host refuses a per-core list of metrics rather than guess', async ({ hive }) => {
  const r = await fetch(`http://${hive.ingest}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${hive.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', metrics: { cpu: [10, 20] } }) });
  expect(r.status).toBe(400);
  expect(await r.text()).toMatch(/one number/);
});

// --- the <ai-hive-buzz> convention: a service's own logs speak in Hive Chat -----------------------------------------------------------------------
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCli } from './harness/hive.mjs';

const chatLines = async (hive) => (await hive.buzz()).filter((m) => m.from.startsWith('🤖'));

test('a service whose log file gains <ai-hive-buzz> lines speaks in the chat as 🤖, once each, and never re-announces what was already in the log', async ({ hive, wall }) => {
  const log = join(hive.home, 'etl.log');
  writeFileSync(log, 'booting\n<ai-hive-buzz>OLD LINE FROM BEFORE</ai-hive-buzz>\n');
  const s = spawnCli(hive, ['heartbeat', '--id', 'etl', '--name', 'Nightly ETL', '--url', hive.ingest, '--key', hive.key, '--follow', log, '--every', '1']);
  await wall.expectStatus('Nightly ETL', 'Healthy');
  appendFileSync(log, 'step 4 ok\n<ai-hive-buzz>migration 50% complete</ai-hive-buzz>\nnoise\n');
  await expect(wall.thread().getByText('🤖 Nightly ETL: migration 50% complete')).toBeVisible({ timeout: 15_000 });
  appendFileSync(log, '<ai-hive-buzz>migration 100% complete</ai-hive-buzz>\n');
  await expect(wall.thread().getByText('🤖 Nightly ETL: migration 100% complete')).toBeVisible({ timeout: 15_000 });
  const lines = (await chatLines(hive)).map((m) => m.text);
  expect(lines).toEqual(['migration 50% complete', 'migration 100% complete']); // the OLD line was in the file before it was followed
  const line = (await chatLines(hive))[0];
  expect(line.kind).toBe('system');
  expect(line.invited ?? []).toEqual([]); // nobody is asked to answer a progress line
  s.child.kill('SIGTERM');
  await wall.expectGone('Nightly ETL');
});

test('piping a service into hive heartbeat --stdin announces its tags promptly, passes its output through, and reports it gone when it ends', async ({ hive, wall }) => {
  const s = spawnCli(hive, ['heartbeat', '--id', 'worker', '--name', 'Worker', '--url', hive.ingest, '--key', hive.key, '--stdin']);
  await wall.expectStatus('Worker', 'Healthy');
  s.child.stdin.write('starting up\n<ai-hive-buzz>queue has 12 jobs</ai-hive-buzz>\n');
  await expect(wall.thread().getByText('🤖 Worker: queue has 12 jobs')).toBeVisible({ timeout: 8_000 }); // not waiting for the next beat (30 s)
  s.child.stdin.write('<ai-hive-buzz>half');
  s.child.stdin.write(' way</ai-hive-buzz>\n');
  await expect(wall.thread().getByText('🤖 Worker: half way')).toBeVisible({ timeout: 8_000 });
  s.child.stdin.end(); // the service ended
  const out = await s.done;
  expect(out.stdout).toContain('starting up'); // its output still reaches the terminal
  await wall.expectGone('Worker');
});

test('any HTTP client can do the same: a buzz array, or a tag in the message; the chat shows the service\'s name, and repeats are said once', async ({ hive, wall }) => {
  const post = (body) => fetch(`http://${hive.ingest}/api/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${hive.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post({ id: 'cron', name: 'Backup', buzz: ['snapshot taken'] })).status).toBe(204);
  expect((await post({ id: 'cron', name: 'Backup', buzz: ['snapshot taken'] })).status).toBe(204); // a loop saying the same thing
  expect((await post({ id: 'cron', name: 'Backup', message: 'ok <ai-hive-buzz>uploaded to s3</ai-hive-buzz>' })).status).toBe(204);
  await expect(wall.thread().getByText('🤖 Backup: uploaded to s3')).toBeVisible({ timeout: 10_000 });
  expect((await chatLines(hive)).filter((m) => m.text === 'snapshot taken')).toHaveLength(1);
  expect((await post({ id: 'cron', buzz: 'not an array' })).status).toBe(400);
  await post({ id: 'cron', status: 'gone' });
});
