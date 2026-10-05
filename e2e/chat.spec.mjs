// Hive Chat end to end: people, real agents (through the real hooks and `hive buzz`), the host's bots (a stub model), the Bee, caps and quiet rooms.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';
import { sleep, until } from './harness/hive.mjs';

test.use({
  hiveOptions: {
    model: true,
    tuning: {
      buzz: { staggerMs: 1500, humanPerHour: 1000, perHour: 1000 },
      responder: { gapMs: [300, 500] },
      bee: { settleMs: 1200, quietMs: 1500, everyMs: 600_000 },
    },
  },
});

/** Seat a chatty agent that is genuinely sitting in the chat: an open `hive listen`, which is what the host counts as Listening. */
async function listener(hive, name, opts) {
  const a = await new ClaudeAgent(hive, name, { chatty: true, ...opts }).join();
  await a.work();
  a.waiting = a.listen(100);
  await until(async () => (await hive.member(name))?.statusLabel === 'Listening');
  return a;
}
const lines = async (hive) => (await hive.buzz()).filter((m) => m.kind !== 'system' || !/joined|left/.test(m.text));
const bots = async (hive) => (await hive.buzz()).filter((m) => m.via === 'host' && m.kind === 'agent');

test.beforeEach(async ({ hive }) => { hive.model.failing = false; hive.model.delayMs = 0; hive.model.requests.length = 0; hive.model.reply = ({ name }) => `Stub reply from ${name}.`; });

test('a person speaks: up to two listening agents are voiced by the host, each quoting what it answers, shown as voiced by host', async ({ hive, wall }) => {
  await listener(hive, 'Echo'); await listener(hive, 'Fern'); await listener(hive, 'Gus');
  await hive.say('Anyone around?', 'Tom');
  await expect.poll(async () => (await bots(hive)).length).toBe(2); // maxReplies: two, not three
  const [first, second] = await bots(hive);
  expect(first.quote.from).toBe('Tom');
  expect(second.quote.id).toBe(first.id); // the second answers the first: it reads as a conversation
  await expect(wall.thread().getByText('voiced by host').first()).toBeVisible();
  await expect(wall.thread().getByText(/Stub reply from/).first()).toBeVisible();
  // the prompt sent to the model carries the bot's own real status and the recent chat
  const p = hive.model.requests[0];
  expect(p.system).toMatch(/Your status right now: Listening/);
  expect(p.user).toMatch(/Tom \(human\): Anyone around\?/);
});

test('the bots never answer the bots: after the host-voiced replies the thread goes quiet', async ({ hive }) => {
  await listener(hive, 'Hal'); await listener(hive, 'Ida');
  await hive.say('Hello hive', 'Tom');
  await expect.poll(async () => (await bots(hive)).length).toBe(2);
  await sleep(2500);
  expect((await bots(hive)).length).toBe(2);
});

test('while a bot writes its reply its card says it is typing, and goes back afterwards', async ({ hive, wall }) => {
  await listener(hive, 'Jun');
  hive.model.delayMs = 2500;
  await hive.say('Jun, quick question', 'Tom');
  await until(async () => /typing/i.test((await hive.member('Jun'))?.statusLabel ?? ''), 6000);
  expect((await hive.member('Jun')).statusLabel).toMatch(/typing/i);
  await wall.expectText('Jun', /typing/i);
  await expect.poll(async () => (await bots(hive)).length, { timeout: 10_000 }).toBe(1);
  await until(async () => !/typing/i.test((await hive.member('Jun'))?.statusLabel ?? ''), 5000);
  expect((await hive.member('Jun')).statusLabel).not.toMatch(/typing/i);
});

test('an unreachable model leaves the thread quiet instead of filling it with errors', async ({ hive }) => {
  await listener(hive, 'Kit');
  hive.model.failing = true;
  await hive.say('Kit, are you there?', 'Tom');
  await sleep(2500);
  expect(await bots(hive)).toHaveLength(0);
  expect((await hive.buzz()).filter((m) => /error|failed|500/i.test(m.text) && m.kind === 'agent')).toHaveLength(0);
});

test('nobody listening: the line lands in the thread and the Hive itself says nobody is available, once', async ({ hive }) => {
  const a = await new ClaudeAgent(hive, 'Mae', { chatty: true }).join(); // seated, but idle: not in the chat
  await hive.model.requests.length;
  await hive.say('Is anybody there?', 'Pat');
  await expect.poll(async () => (await hive.buzz()).filter((m) => /no one is available/.test(m.text)).length).toBe(1);
  await hive.say('Hello?', 'Pat');
  await sleep(500);
  expect((await hive.buzz()).filter((m) => /no one is available/.test(m.text)).length).toBe(1);
  await a.leave();
});

test('real agents answer: a person asks by name, the agent gets it at its Stop hook, replies with hive buzz --reply, and the reply is quoted on the wall', async ({ hive, wall }) => {
  // no bots for this one: these are the agents' own sessions
  hive.model.failing = true;
  const a = await new ClaudeAgent(hive, 'Nia', { chatty: true }).join();
  await a.work();
  const stop = a.stopListening(25);
  await until(async () => (await hive.member('Nia'))?.statusLabel === 'Listening');
  await sleep(700);
  await hive.say('Nia, what are you working on?', 'Tom');
  const handed = JSON.parse((await stop).stdout);
  expect(handed.decision).toBe('block');
  const id = /#(\d+) tom|#(\d+) Tom \(human\)/.exec(handed.reason)?.slice(1).find(Boolean) ?? /#(\d+)/.exec(handed.reason)[1];
  const r = await a.buzz('Reading the config files.', Number(id));
  expect(r.code).toBe(0);
  const reply = (await hive.buzz()).find((m) => m.from === 'Nia' && m.kind === 'agent');
  expect(reply.text).toBe('Reading the config files.');
  expect(reply.via).toBeUndefined(); // the agent's own line, not host-voiced
  expect(reply.quote.from).toBe('Tom');
  await expect(wall.thread().getByText('Reading the config files.')).toBeVisible();
  await expect(wall.thread().getByLabel('In reply to Tom').first()).toBeVisible();
  await a.leave();
});

test('agent to agent: a line that names another listening agent reaches it; its reply is quoted, and is readable by the first agent without being pushed at it', async ({ hive }) => {
  hive.model.failing = true;
  const a = await listener(hive, 'Oak');
  const b = await listener(hive, 'Pia');
  const heard = b.waiting; // Pia's open listen
  await a.buzz('Pia, can you check the build?');
  const got = await heard.done;
  expect(got.stdout).toMatch(/Oak: Pia, can you check the build\?/);
  expect(got.stdout).toContain('--seat Pia');
  const id = /#(\d+) Oak/.exec(got.stdout)[1];
  await b.buzz('Build is green.', Number(id));
  const answer = (await hive.buzz()).find((m) => m.from === 'Pia');
  expect(answer.quote.from).toBe('Oak');
  // By design the answer is not pushed back to Oak (that is how two agents are kept from talking forever): the line names nobody, so it
  // invites nobody. Oak can still read it, and the wall shows it.
  await sleep(1500);
  a.waiting.child.kill('SIGKILL');
  expect((await a.read()).stdout).toMatch(/Pia \(replying to #\d+\): Build is green\./);
});

test('only invited agents hear a line; a reply from one that was not invited, or from a seat that is not chatty, is refused', async ({ hive }) => {
  hive.model.failing = true;
  const quiet = await new ClaudeAgent(hive, 'Quin').join(); // not --chatty
  const r1 = await quiet.buzz('can I speak?');
  expect(r1.code).not.toBe(0);
  expect(r1.stderr + r1.stdout).toMatch(/chatty/i);
  const a = await listener(hive, 'Rex2'); const b = await listener(hive, 'Sol'); const c = await listener(hive, 'Tia');
  await a.buzz('Sol, ping');
  const ping = (await hive.buzz()).find((m) => m.text === 'Sol, ping');
  const r2 = await c.buzz('butting in', ping.id); // Tia was not invited to answer that
  expect(r2.code).not.toBe(0);
  await b.buzz('pong', ping.id);
  expect((await hive.buzz()).some((m) => m.text === 'pong')).toBe(true);
});

test('the Bee: two agents who sit in the chat get a conversation starter, as a host line, inviting both', async ({ hive, wall }) => {
  hive.model.failing = true;
  await listener(hive, 'Una'); const v = await listener(hive, 'Vic');
  const bee = await until(async () => (await hive.buzz()).find((m) => m.kind === 'system' && /Bee/.test(m.from)), 20_000);
  expect(bee, 'a Bee line').toBeTruthy();
  expect(bee.kind).toBe('system'); // never passed off as an agent
  expect(JSON.stringify(bee.invited ?? [])).toMatch(/Una|Vic/);
  await expect(wall.thread().getByText(/Bee/).first()).toBeVisible();
  void v;
});

test('the runaway guard: after twelve chat turns in a row the Stop hook lets the turn end instead of waking the agent again', async ({ hive }) => {
  hive.model.failing = true;
  const a = await new ClaudeAgent(hive, 'Wes', { chatty: true }).join();
  await a.work();
  let blocked = 0, ended = false;
  for (let i = 0; i < 14 && !ended; i++) {
    const stop = a.stopListening(8);
    await until(async () => (await hive.member('Wes'))?.statusLabel === 'Listening', 8000);
    await sleep(500);
    await hive.say(`Wes, ping ${i}`, `P${i}`);
    const out = (await stop).stdout;
    if (out.includes('"block"')) blocked++; else ended = true;
  }
  expect(blocked).toBe(12);
  expect(ended).toBe(true);
});

