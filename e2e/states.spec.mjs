// Time-based states, with the host's clocks shortened (HIVE_TUNING): Focusing, Stalled and recovery, Ghost and drop-off, services that stop reporting.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent, ServiceAgent } from './harness/agents.mjs';
import { runCli, sleep, until } from './harness/hive.mjs';

test.use({ hiveOptions: { tuning: { hive: { focusMs: 1200, focusMinMs: 800, stallMs: 4000, ghostAfterMs: 6000, ghostDropMs: 5000, tickMs: 250 } } } });

const label = async (hive, name) => (await hive.member(name))?.statusLabel;

test('a tool call that stays open goes from Active to Focusing to Stalled, and reporting again brings it back', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Slow1').join();
  await a.working();
  await wall.expectStatus('Slow1', 'Active Now');
  expect(await until(async () => (await label(hive, 'Slow1')) === 'Focusing', 4000), 'Focusing: quiet, but probably deep in something big').toBeTruthy();
  expect(await until(async () => (await label(hive, 'Slow1')) === 'Stalled', 8000), 'Stalled after the limit').toBeTruthy();
  await wall.expectStatus('Slow1', 'Stalled');
  expect((await hive.member('Slow1')).statusReason).toMatch(/has not reported finishing/);
  await a.hook('PostToolUse', { tool_name: 'Read' });
  await wall.expectStatus('Slow1', 'Active Now');
});

test('an agent that finishes and then says nothing goes Idle, then Ghost, then drops off the wall', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Fade1').join();
  await a.work();
  await a.idle();
  await wall.expectStatus('Fade1', 'Idle');
  await wall.expectStatus('Fade1', 'Ghost', 15_000);
  expect((await hive.member('Fade1')).statusReason).toMatch(/not a failure/);
  await wall.expectGone('Fade1', 20_000);
});

test('a ghost that reports again is a live agent again, not a new card', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Fade2').join();
  await a.work(); await a.idle();
  await wall.expectStatus('Fade2', 'Ghost', 15_000);
  await a.work();
  await wall.expectStatus('Fade2', 'Active Now');
  expect((await hive.state()).filter((m) => m.name === 'Fade2')).toHaveLength(1);
});

test('a service that stops sending heartbeats shows Not responding, and recovers when it reports again', async ({ hive, wall }) => {
  const s = new ServiceAgent(hive, 'svc-ttl', { name: 'Mailer' });
  await s.beat({ ttl: 5 });
  await wall.expectStatus('Mailer', 'Healthy');
  await wall.expectStatus('Mailer', 'Not responding', 15_000);
  expect((await hive.member('Mailer')).status).toBe('failure');
  await s.beat({ ttl: 5 });
  await wall.expectStatus('Mailer', 'Healthy');
  await s.beat({ status: 'gone' });
});

test('a service that said it is struggling stays Degraded until it says otherwise', async ({ hive }) => {
  const s = new ServiceAgent(hive, 'svc-deg', { name: 'Indexer' });
  await s.beat({ status: 'degraded', message: 'slow disk', ttl: 60 });
  await sleep(1500);
  expect((await hive.member('Indexer')).statusLabel).toBe('Degraded');
  await s.beat({ ttl: 60 });
  await until(async () => (await label(hive, 'Indexer')) === 'Healthy', 3000);
  expect(await label(hive, 'Indexer')).toBe('Healthy');
  await s.beat({ status: 'gone' });
});
