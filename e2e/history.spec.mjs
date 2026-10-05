// `hive import-history`: one-off re-scoring of what this machine's agent tools kept, so the heatmap has a past.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';
import { runCli } from './harness/hive.mjs';
import { localDay } from '../src/production.mjs';

test.use({ hiveOptions: { key: 'history-key' } }); // its own host: production is kept for good, and other files make some of their own

const DAY = 86_400_000;
const daysAgo = (n, h = 10) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() - n * DAY; };
const jl = (...o) => o.map((x) => JSON.stringify(x)).join('\n');
const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

/** Fake histories under this hive's home: one Claude Code turn (an edit), one Qwen turn (a read), one Copilot turn (an edit), on separate days. */
function seedHistory(home, { claudeAt, qwenAt, copilotAt }) {
  put(join(home, '.claude', 'projects', 'p1', 's1.jsonl'), jl(
    { type: 'user', timestamp: new Date(claudeAt).toISOString(), cwd: '/work/site', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant', timestamp: new Date(claudeAt + 4000).toISOString(), cwd: '/work/site', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } }] } },
  ));
  put(join(home, '.qwen', 'projects', 'p1', 'chats', 'q1.jsonl'), jl(
    { type: 'user', provenance: 'real_user', timestamp: new Date(qwenAt).toISOString(), cwd: '/work/api', message: { parts: [{ text: 'go' }] } },
    { type: 'assistant', timestamp: new Date(qwenAt + 3000).toISOString(), model: 'qwen3-coder', message: { parts: [{ functionCall: { name: 'read_file', args: { path: 'x' } } }] } },
  ));
  const user = join(home, 'vscode-user');
  put(join(user, 'workspaceStorage', 'ws1', 'chatSessions', 'c1.jsonl'), jl({ kind: 0, v: { requests: [{ timestamp: copilotAt, modelId: 'copilot/gpt-4.1', response: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_replaceString', toolCallId: 'c1', isComplete: true, invocationMessage: { value: 'x', uris: { 'file:///p/a.ts#1-1': { path: '/p/a.ts' } } } }], result: { timings: { totalElapsed: 20_000 } } }] } }));
  return user;
}

const imp = (hive, args, user) => runCli(hive, ['import-history', ...args], { env: user ? { OFFICE_VSCODE_USER_DIR: user } : {} });
const days = async (hive) => (await (await fetch(`${hive.base}/hive/production-days`)).json());

test('a dry run reads the history of every tool it finds and reports it, but sends nothing', async ({ hive }) => {
  const user = seedHistory(hive.home, { claudeAt: daysAgo(3), qwenAt: daysAgo(10), copilotAt: daysAgo(40) });
  const r = await imp(hive, ['--dry-run'], user);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/Claude Code: 1 file\(s\), 1 turns over 1 day\(s\)/);
  expect(r.stdout).toMatch(/Qwen Code: 1 file\(s\), 1 turns/);
  expect(r.stdout).toMatch(/VS Code Copilot Chat: 1 file\(s\), 1 turns/);
  expect(r.stdout).not.toMatch(/Gemini|Codex/); // tools with no history on this machine are not listed
  expect(r.stdout).toContain('(dry run: nothing sent)');
  expect(await days(hive)).toEqual([]);
});

test('importing gives the heatmap its past: each tool\'s turns land on their own day, and the page shades those hexagons', async ({ hive, page }) => {
  const user = seedHistory(hive.home, { claudeAt: daysAgo(3), qwenAt: daysAgo(10), copilotAt: daysAgo(40) });
  const r = await imp(hive, ['--url', hive.ingest, '--key', hive.key], user);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/Sent 1 day\(s\) of Claude Code/);
  const got = Object.fromEntries((await days(hive)).map((d) => [d.date, d.value]));
  expect(got[localDay(daysAgo(3))]).toBe(1);      // an edit on a standard model: a whole hexagon
  expect(got[localDay(daysAgo(10))]).toBeCloseTo(0.35, 2); // one read on a standard-size model: a light turn
  expect(got[localDay(daysAgo(40))]).toBe(1);
  await page.goto(`${hive.base}/hive/heatmap`);
  const chart = page.getByRole('img', { name: /Production per day/ });
  await expect(chart).toBeVisible();
  const filled = await chart.locator('polygon:not([data-rebar-part="cell-missing"])').count(); // days with production, plus the five legend swatches
  expect(filled).toBeGreaterThanOrEqual(5 + 3);
  await expect(page.getByRole('group', { name: 'Production summary' })).toContainText('Active days');
});

test('running it again replaces the earlier import: nothing is counted twice', async ({ hive }) => {
  const user = seedHistory(hive.home, { claudeAt: daysAgo(3), qwenAt: daysAgo(10), copilotAt: daysAgo(40) });
  await imp(hive, ['--url', hive.ingest, '--key', hive.key], user);
  const first = await days(hive);
  await imp(hive, ['--url', hive.ingest, '--key', hive.key], user);
  await imp(hive, ['--url', hive.ingest, '--key', hive.key, '--tool', 'claude'], user);
  expect(await days(hive)).toEqual(first);
});

test('days the Hive dated live are left as recorded: an imported estimate never doubles them', async ({ hive }) => {
  const a = await new ClaudeAgent(hive, 'Liv', { project: 'live-proj' }).join();
  await a.prompt(); await a.work(); await a.idle(); // a live turn today
  const live = (await days(hive)).at(-1);
  expect(live.date).toBe(localDay(Date.now()));
  const user = seedHistory(hive.home, { claudeAt: Date.now() - 3600_000, qwenAt: daysAgo(10), copilotAt: daysAgo(40) }); // the same day: a transcript of the live work
  await imp(hive, ['--url', hive.ingest, '--key', hive.key], user);
  const after = await days(hive);
  expect(after.at(-1)).toEqual(live);
  expect(after.length).toBeGreaterThan(1);
});

test('mistakes are told plainly: an unknown tool, --dir with several tools, no host to send to, nothing found', async ({ hive }) => {
  expect((await imp(hive, ['--tool', 'notepad', '--dry-run'])).stderr).toMatch(/unknown tool "notepad"/);
  expect((await imp(hive, ['--dir', '/x', '--dry-run'])).stderr).toMatch(/--dir needs one --tool/);
  const empty = await imp(hive, ['--tool', 'codex']);
  expect(empty.code).toBe(0);
  expect(empty.stdout).toMatch(/Nothing to import/);
  seedHistory(hive.home, { claudeAt: daysAgo(3), qwenAt: daysAgo(10), copilotAt: daysAgo(40) });
  const nohost = await runCli(hive, ['import-history', '--tool', 'claude'], { env: { HIVE_URL: '', HIVE_KEY: '' } });
  expect(nohost.code).not.toBe(0);
  expect(nohost.stderr).toMatch(/no host or key/);
});
