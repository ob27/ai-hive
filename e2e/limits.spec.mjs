// The caps: a person per hour, an agent per hour, and the bots' hourly reply budget. Tight limits, so this file has its own host.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';
import { sleep, until } from './harness/hive.mjs';

test.use({ hiveOptions: { model: true, tuning: { buzz: { humanPerHour: 5, perHour: 3 }, responder: { gapMs: [100, 200], repliesPerHour: 2 } } } });

test.beforeEach(async ({ hive }) => { await hive.fresh(); }); // caps and crew notes live in the host: every test gets a new one

async function listener(hive, name) {
  const a = await new ClaudeAgent(hive, name, { chatty: true }).join();
  await a.work();
  a.waiting = a.listen(100);
  await until(async () => (await hive.member(name))?.statusLabel === 'Listening');
  return a;
}
const bots = async (hive) => (await hive.buzz()).filter((m) => m.via === 'host' && m.kind === 'agent');

test('an agent\'s own hourly cap is reported as a clear error', async ({ hive }) => {
  const a = await listener(hive, 'Xan');
  hive.model.failing = true; // keep the bots out of the count
  let last;
  for (let i = 0; i < 6 && (last = await a.buzz(`line ${i}`)).code === 0; i++);
  expect(last.code).not.toBe(0);
  expect(last.stderr + last.stdout).toMatch(/too|limit|cap|hour|many/i);
});

test('a person is capped per hour, separately from the agents: the line is refused with a reason', async ({ hive }) => {
  hive.model.failing = true;
  let last, n = 0;
  while ((last = await hive.say(`spam ${n}`, 'Spammer')).status === 204 && n++ < 20);
  expect(n).toBe(5);
  expect(last.status).toBe(429);
  expect((await last.json()).error).toBeTruthy();
});

test('the bots\' hourly reply budget stops them and says so once', async ({ hive }) => {
  await listener(hive, 'Lou');
  hive.model.failing = false;
  for (let i = 0; i < 4; i++) { await hive.say(`Lou, question ${i}`, `Q${i}`); await sleep(1200); }
  await expect.poll(async () => (await hive.buzz()).filter((m) => /reply budget is used up/.test(m.text)).length, { timeout: 15_000 }).toBe(1);
  expect((await bots(hive)).length).toBe(2);
});
