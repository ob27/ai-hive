import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/office.mjs', import.meta.url));
const { E2E_HOME: home, E2E_KEY: key, E2E_INGEST: ingest } = process.env;
const env = { ...process.env, HOME: home, HIVE_HOME: `${home}/.workspace-office` };
const hive = (...args) => run('node', [cli, ...args], { env }).catch((e) => e); // a failing command is a result, not a throw
const hook = (seat, payload) => new Promise((resolve) => {
  const p = execFile('node', [cli, 'hook', '--seat', seat], { env: { ...env, HIVE_LISTEN_WAIT: '1' } }, (_e, stdout) => resolve(stdout));
  p.stdin.end(JSON.stringify({ cwd: home, ...payload }));
});
const tile = (page, name) => page.getByText(name, { exact: true }).first();

test.beforeEach(async () => { await hive('leave', '--all').catch(() => {}); });

test('the wall loads, the bee logos render, and it starts empty in work mode', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/hive/');
  await expect(page).toHaveTitle(/hive/i);
  for (const f of ['aihive-bee-halo.svg', 'aihive-bee.svg']) {
    const r = await page.request.get(`/hive/${f}`);
    expect(r.ok(), f).toBeTruthy();
    expect(await r.text()).toContain('<svg');
  }
  expect(errors).toEqual([]);
});

test('an agent that joins takes a seat on the wall, and leaving removes it', async ({ page }) => {
  await page.goto('/hive/');
  const j = await hive('join', ingest, 'Wren', '--key', key, '--claude');
  expect(j.code ?? 0).toBe(0);
  await expect(tile(page, 'Wren')).toBeVisible({ timeout: 10_000 });
  await hive('leave', '--seat', 'Wren');
  await expect(tile(page, 'Wren')).toBeHidden({ timeout: 10_000 });
});

test('a working agent shows its activity; a chatty one waiting in listen shows Listening', async ({ page }) => {
  await page.goto('/hive/');
  await hive('join', ingest, 'Lark', '--key', key, '--chatty', '--claude');
  await hook('Lark', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' }, session_id: 'Lark' });
  await expect(tile(page, 'Lark')).toBeVisible({ timeout: 10_000 });
  const listening = hive('listen', '--seat', 'Lark'); // waits in the chat (about 100s unless someone speaks)
  await expect(page.getByText(/listening/i).first()).toBeVisible({ timeout: 15_000 });
  listening.catch(() => {});
});

test('the cog boots an agent after confirmation (the host pre-fills the key)', async ({ page }) => {
  await page.goto('/hive/');
  await hive('join', ingest, 'Finch', '--key', key, '--claude');
  await tile(page, 'Finch').click(); // selecting a tile opens its details, where the cog lives
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await expect(page.getByRole('group', { name: 'Confirm boot' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Cancel' }).click();
  await expect(tile(page, 'Finch')).toBeVisible();
  await page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await page.getByRole('menuitem', { name: 'Boot', exact: true }).click();
  await expect(tile(page, 'Finch')).toBeHidden({ timeout: 10_000 });
});

test('without a pre-filled key the cog asks for it, refuses a wrong one, and boots on the right one', async ({ page }) => {
  await page.route('**/hive/join-info', (r) => r.fulfill({ json: { ingest: 3292, key: null } }));
  await page.goto('/hive/');
  await hive('join', ingest, 'Rook', '--key', key, '--claude');
  await tile(page, 'Rook').click();
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await page.getByRole('menuitem', { name: 'Boot', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Actions for Rook' });
  await menu.getByLabel('Hive key').fill('wrong');
  await menu.getByRole('button', { name: 'Boot' }).click();
  await expect(tile(page, 'Rook')).toBeVisible();
  await expect(menu.getByText(/not the hive key|not accepted/i)).toBeVisible();
  await menu.getByLabel('Hive key').fill(key);
  await menu.getByRole('button', { name: 'Boot' }).click();
  await expect(tile(page, 'Rook')).toBeHidden({ timeout: 10_000 });
});

test('a human line posted through the chat box appears in the thread', async ({ page }) => {
  await page.goto('/hive/');
  const r = await page.request.post('/hive/buzz', { data: { from: 'Tom', text: 'hello hive' } });
  expect([200, 201, 202, 204]).toContain(r.status());
  await expect(page.getByText('hello hive')).toBeVisible({ timeout: 10_000 });
});

test('an agent that dies mid-listen does not stay Listening on the wall', async ({ page }) => {
  await page.goto('/hive/');
  await hive('join', ingest, 'Pike', '--key', key, '--chatty', '--claude');
  await hook('Pike', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' }, session_id: 'Pike' });
  const p = spawn('node', [cli, 'listen', '--seat', 'Pike', '--wait', '100'], { env });
  await expect(page.getByText(/listening/i).first()).toBeVisible({ timeout: 15_000 });
  p.kill('SIGKILL'); // the agent's process is gone: the host sees the wait close
  await expect(page.getByText(/listening/i)).toHaveCount(0, { timeout: 20_000 });
});

test('the chat thread shows senders, quotes, system lines and a working Reply', async ({ page }) => {
  await page.goto('/hive/');
  await hive('join', ingest, 'Sage', '--key', key, '--chatty', '--claude');
  await page.request.post('/hive/buzz', { data: { name: 'Tom', text: 'first line' } });
  await expect(page.getByText('first line')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Tom · human')).toBeVisible();
  await expect(page.getByText(/Sage joined the hive/)).toBeVisible(); // a system line, not a bubble
  await page.getByRole('button', { name: 'Reply to Tom' }).click();
  await expect(page.getByLabel('In reply to Tom').first()).toBeVisible(); // the quote chip above the chat box
  await page.screenshot({ path: 'test-results/chat-thread.png' });
});

test('the Config page is reachable, switches theme, and the Join page renders', async ({ page }) => {
  await page.goto('/hive/config');
  await expect(page.getByLabel('Hive key')).toBeVisible();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/hive/join');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Join the hive' })).toBeVisible();
});

test('seats: two windows in one folder become two seats, and one window closing leaves only its own', async ({ page }) => {
  await page.goto('/hive/');
  await hive('join', ingest, 'Ada', '--key', key, '--claude');
  await hive('join', ingest, 'Bex', '--key', key, '--claude');
  const ev = (sid) => hook('Bex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sid });
  await ev('w1'); await ev('w2'); // the hook file names Bex; the second window is given Ada
  await expect(tile(page, 'Ada')).toBeVisible({ timeout: 10_000 });
  await expect(tile(page, 'Bex')).toBeVisible();
  await hook('Bex', { hook_event_name: 'SessionEnd', session_id: 'w1' }); // w1 sat in Bex
  await expect(tile(page, 'Bex')).toBeHidden({ timeout: 10_000 });
  await expect(tile(page, 'Ada')).toBeVisible();
});

test('a host restart: the wall recovers, and a seat whose saved chat place predates the restart still hears new lines', async ({ page }) => {
  const port = 3390, ingestPort = 3392, at = `127.0.0.1:${ingestPort}`;
  const start = async () => {
    const child = spawn('node', [fileURLToPath(new URL('../scripts/hive-demo.mjs', import.meta.url)), '--port', String(port), '--ingest', String(ingestPort), '--work'], { env: { ...env, HIVE_DEMO_KEY: key }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if ((await fetch(`http://127.0.0.1:${port}/hive/`).catch(() => null))?.ok) return child; await new Promise((r) => setTimeout(r, 100)); }
    child.kill(); throw new Error('host did not start');
  };
  const post = (text) => fetch(`http://127.0.0.1:${port}/hive/buzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Tom', text }) });
  let host = await start();
  try {
    await page.goto(`http://127.0.0.1:${port}/hive/`);
    await hive('join', at, 'Moss', '--key', key, '--chatty', '--claude');
    host.kill(); await new Promise((r) => host.once('exit', r));
    host = await start(); // its ids begin again at 1
    await hive('join', at, 'Moss', '--key', key, '--chatty', '--claude');
    writeFileSync(`${home}/.workspace-office/seats/Moss.cursor`, '83'); // the place Moss saved in the host's previous life
    const heard = hive('listen', '--seat', 'Moss', '--wait', '10');
    await new Promise((r) => setTimeout(r, 800));
    await post('after the restart');
    expect((await heard).stdout).toContain('after the restart');
    await page.reload();
    await expect(tile(page, 'Moss')).toBeVisible({ timeout: 10_000 });
  } finally { host.kill(); }
});
