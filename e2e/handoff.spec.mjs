// Crew handoff end to end: agents on one project, notes for whoever finishes last, a free helper, and a person when nobody can.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';
import { sleep, until } from './harness/hive.mjs';

test.use({
  hiveOptions: {
    model: false,
    tuning: {
      crew: { graceMs: 1500, ackMs: 6000, sweepMs: 300 },
      buzz: { staggerMs: 1500, humanPerHour: 1000, perHour: 1000 },
      bee: { everyMs: 3_600_000 }, // no conversation starters in these tests
    },
  },
});

test.beforeEach(async ({ hive }) => { await hive.fresh(); }); // caps and crew notes live in the host: every test gets a new one

const crewMate = (hive, name, project) => new ClaudeAgent(hive, name, { chatty: true, project }).join();
const notice = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? JSON.parse(r.stdout).reason ?? ''; } catch { return r.stdout; } };
const systemLines = async (hive) => (await hive.buzz()).filter((m) => m.kind === 'system');

test('two agents working on one project are told about each other, once', async ({ hive }) => {
  const a = await crewMate(hive, 'Ann1', 'proj-aware'); const b = await crewMate(hive, 'Bob1', 'proj-aware');
  await a.working(); await b.working();
  const told = notice(await a.hook('PostToolUse', { tool_name: 'Read' }));
  expect(told).toMatch(/Bob1 is working on this project at the same time as you/);
  expect(told).toMatch(/hive handoff/);
  expect(notice(await a.hook('PostToolUse', { tool_name: 'Read' }))).toBe(''); // only once
});

test('agents on different projects are not a crew', async ({ hive }) => {
  const a = await crewMate(hive, 'Ann2', 'proj-x'); const b = await crewMate(hive, 'Bob2', 'proj-y');
  await a.working(); await b.working();
  expect(notice(await a.hook('PostToolUse', { tool_name: 'Read' }))).toBe('');
});

test('an agent that finishes first while a crewmate still works is asked for a note; the last to finish is handed it to test and integrate', async ({ hive, wall }) => {
  const a = await crewMate(hive, 'Ann3', 'proj-last'); const b = await crewMate(hive, 'Bob3', 'proj-last');
  await a.working(); await b.working();
  await a.hook('PostToolUse', { tool_name: 'Read' }); // takes its "aware" notice
  const askedOut = notice(await a.idle({ HIVE_LISTEN_WAIT: '1' }));
  expect(askedOut).toMatch(/Bob3 is still working on this project/); // ASK: leave a note before you stop
  expect((await a.handoff('Added the export button. Needs testing with big files; please commit and push.')).code).toBe(0);
  await expect(wall.thread().getByText(/Ann3 left a handoff note/)).toBeVisible();
  await b.working();
  const last = notice(await b.idle({ HIVE_LISTEN_WAIT: '1' }));
  expect(last).toMatch(/You are the last one working on proj-last/);
  expect(last).toMatch(/Ann3: Added the export button/);
  expect(last).toMatch(/commit and push/);
});

test('a note is cut to its length limit, and only a chatty seat on a project may leave one', async ({ hive }) => {
  const a = await crewMate(hive, 'Ann4', 'proj-limits');
  const long = await a.handoff('x'.repeat(400));
  expect(long.code).toBe(0);
  const note = (await systemLines(hive)).find((m) => /Ann4 left a handoff note/.test(m.text));
  expect(note, 'the announcement fits a buzz line, so it is not refused').toBeTruthy();
  expect(note.text.length).toBeLessThanOrEqual(280);
  const quiet = await new ClaudeAgent(hive, 'Quiet4', { project: 'proj-limits' }).join(); // not chatty
  const r = await quiet.handoff('no');
  expect(r.code).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/chatty/i);
});

test('nobody picks the notes up: a free listening agent on the same machine is asked to take them, by name, and hears it', async ({ hive }) => {
  const author = await crewMate(hive, 'Ann5', 'proj-help');
  const helper = await crewMate(hive, 'Hel5', 'proj-other');
  await helper.work();
  const heard = helper.listen(100);
  await until(async () => (await hive.member('Hel5'))?.statusLabel === 'Listening');
  await author.working();
  await author.handoff('Please run the integration tests on the new parser.');
  await author.idle(); // it finished and nobody else is working on the project
  const line = await heard.done;
  expect(line.stdout).toMatch(/Hel5, you are free and on the same machine/);
  expect(line.stdout).toMatch(/Ann5: Please run the integration tests/);
});

test('nobody at all: the Hive answers on the idle agents\' behalf and posts the notes with a Copy button for a person', async ({ hive, wall, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: hive.base });
  const author = await crewMate(hive, 'Ann6', 'proj-human');
  await author.working();
  await author.handoff('Check the nightly job still runs; commit and push if green.');
  await author.idle();
  const alert = await until(async () => (await systemLines(hive)).find((m) => m.handoffAlert), 15_000);
  expect(alert, 'the not-picked-up announcement').toBeTruthy();
  expect(alert.handoffAlert.copy).toMatch(/Ann6: Check the nightly job/);
  const declined = (await hive.buzz()).find((m) => m.from === 'Ann6' && m.via === 'host');
  expect(declined, 'the idle agent declines on its own behalf, host-voiced').toBeTruthy();
  await wall.open();
  await expect(wall.thread().getByText(/were not picked up/).first()).toBeVisible();
  await wall.page.getByRole('button', { name: 'Copy to clipboard' }).click();
  await expect(wall.page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await wall.page.evaluate(() => navigator.clipboard.readText())).toMatch(/Ann6: Check the nightly job/);
});
