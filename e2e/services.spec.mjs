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
