// Claude Code specifics: sub-agents, windows sharing a folder, the chat loop at Stop, asks to listen, boots, host restarts, agents that die.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';
import { runCli, sleep, until } from './harness/hive.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ hiveOptions: { prefillKey: true } }); // the cog's boot needs no key typed in this file

test('sub-agents: a robot icon and count on the parent card, from Start/Stop and from their own tool calls, gone when they stop', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Sub1').join();
  await a.work();
  await expect(wall.helpers('Sub1')).toHaveCount(0);
  await a.subagentStart('h1'); await a.subagentStart('h2', 'Plan');
  await expect(wall.helpers('Sub1')).toHaveText('2');
  await expect(wall.helpers('Sub1')).toHaveAttribute('title', 'These are the sub-agents helping Sub1.');
  await a.subagentTool('h3'); // its start was missed: a tool call still proves it is there
  await expect(wall.helpers('Sub1')).toHaveText('3');
  await a.subagentStop('h1'); await a.subagentStop('h2'); await a.subagentStop('h3');
  await expect(wall.helpers('Sub1')).toHaveCount(0);
  await a.leave();
});

test('a sub-agent\'s tool calls keep the parent card Active, and are not a second card', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Sub2').join();
  await a.subagentStart('x1');
  await a.subagentTool('x1', 'deep.js');
  await wall.expectStatus('Sub2', 'Active Now');
  expect((await hive.state()).filter((m) => m.name === 'Sub2')).toHaveLength(1);
  await a.leave();
});

test('two windows in one folder become two seats; one window closing leaves only its own', async ({ hive, wall }) => {
  const dir = hive.project('Shared');
  const join = (name) => runCli(hive, ['join', hive.ingest, name, '--key', hive.key, '--claude'], { cwd: dir });
  await join('Ada'); await join('Bex'); // the folder's hook file ends up naming one of them
  const ev = (sid, event, extra = {}) => runCli(hive, ['hook', '--seat', 'Bex'], { cwd: dir, input: JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: event, ...extra }) });
  await ev('w1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  await ev('w2', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  await wall.expectStatus('Ada', 'Active Now'); await wall.expectStatus('Bex', 'Active Now');
  await ev('w1', 'SessionEnd');
  await wall.expectGone('Bex');
  await wall.expectStatus('Ada', 'Active Now');
  await ev('w2', 'SessionEnd');
});

test('a chatty agent\'s Stop hook listens, hands over a line from the chat, and locks the turn to chat tools until a real prompt', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Chat1', { chatty: true }).join();
  await a.work();
  const stop = a.stopListening(20);
  await wall.expectStatus('Chat1', 'Listening', 20_000).catch(async () => { await expect(wall.tile('Chat1')).toBeVisible(); }); // the wall paints Listening as Active
  await until(async () => (await hive.member('Chat1'))?.status === 'listening');
  await sleep(800);
  await hive.say('Chat1, are you there?', 'Tom');
  const handed = JSON.parse((await stop).stdout);
  expect(handed.decision).toBe('block');
  expect(handed.reason).toMatch(/Chat1, are you there\?/);
  expect(handed.reason).toMatch(/--seat Chat1/);
  const pre = async (tool_name, tool_input) => (await a.hook('PreToolUse', { tool_name, tool_input })).stdout;
  expect(JSON.parse(await pre('Read', { file_path: 'secrets.env' })).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(await pre('Bash', { command: 'hive buzz --reply 3 "hi" --seat Chat1' })).toBe('');
  await a.prompt('please fix the build'); // a real prompt lifts the lock
  expect(await pre('Read', { file_path: 'a' })).toBe('');
  await a.leave();
});

test('Listening is real: it shows while hive listen waits, and ends at once if that process dies', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Chat2', { chatty: true }).join();
  await a.work();
  const l = a.listen(100);
  await until(async () => (await hive.member('Chat2'))?.statusLabel === 'Listening');
  expect((await hive.member('Chat2')).statusLabel).toBe('Listening');
  l.child.kill('SIGKILL');
  expect(await until(async () => (await hive.member('Chat2'))?.statusLabel !== 'Listening', 5000)).toBe(true);
  await a.leave();
});

test('a saved chat place from before a host restart does not hide the new thread', async ({ hive }) => {
  const a = await new ClaudeAgent(hive, 'Chat3', { chatty: true }).join();
  await hive.restart(); // the thread numbers begin again at 1
  await a.join();
  writeFileSync(join(hive.env.HIVE_HOME, 'seats', 'Chat3.cursor'), '83'); // what it saved in the host's previous life
  const l = a.listen(15);
  await sleep(800);
  await hive.say('after the restart', 'Tom');
  expect((await l.done).stdout).toContain('after the restart');
  await a.leave();
});

test('the cog\'s Ask to listen reaches a working agent on its next event, once', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Chat4', { chatty: true }).join();
  await a.working();
  const id = (await hive.member('Chat4')).id;
  const res = await hive.admin('listen', id, 'tom');
  expect(res.status).toBe(204);
  const r = await a.hook('PostToolUse', { tool_name: 'Read' });
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/tom would like you in Hive Chat[\s\S]*hive listen --seat Chat4/);
  expect((await a.hook('PostToolUse', { tool_name: 'Read' })).stdout).toBe('');
  await a.leave();
});

test('booting an agent from the cog removes it, tells it once on its next event, and it stays gone', async ({ hive, wall }) => {
  const a = await new ClaudeAgent(hive, 'Boot1').join();
  await a.work();
  await wall.openDetails('Boot1');
  await wall.page.getByRole('button', { name: 'Agent actions' }).click();
  await wall.page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await wall.page.getByRole('menuitem', { name: 'Boot', exact: true }).click();
  await wall.expectGone('Boot1');
  expect(JSON.parse((await a.hook('PostToolUse', { tool_name: 'Read' })).stdout).hookSpecificOutput.additionalContext).toMatch(/removed you from the Hive/);
  await a.working();
  await wall.expectGone('Boot1');
});
