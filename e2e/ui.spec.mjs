// The screen itself: chat box and thread, the config page, themes, the join page, the cog's key prompt.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';

test('the wall loads without errors, the bee logos render, and it starts empty in work mode', async ({ page, hive }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${hive.base}/hive/`);
  await expect(page.getByText('Nobody is on the wall yet.')).toBeVisible();
  for (const f of ['aihive-bee-halo.svg', 'aihive-bee.svg']) {
    const r = await page.request.get(`${hive.base}/hive/${f}`);
    expect(r.ok(), f).toBeTruthy();
    expect(await r.text()).toContain('<svg');
  }
  expect(errors).toEqual([]);
});

test('the chat thread shows senders, system lines and a working Reply that quotes', async ({ hive, wall }) => {
  await new ClaudeAgent(hive, 'Sage', { chatty: true }).join();
  await hive.say('first line', 'Tom');
  await expect(wall.thread().getByText('first line')).toBeVisible();
  await expect(wall.thread().getByText('Tom · human')).toBeVisible();
  await expect(wall.thread().getByText(/Sage joined the hive/)).toBeVisible();
  await wall.page.getByRole('button', { name: 'Reply to Tom' }).click();
  await expect(wall.page.getByLabel('In reply to Tom').first()).toBeVisible();
});

test('the cog boots after confirmation with the key pre-filled; without it the cog asks, refuses a wrong key, accepts the right one', async ({ hive, wall, page }) => {
  const a = await new ClaudeAgent(hive, 'Rook').join();
  await a.work();
  await wall.openDetails('Rook');
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await expect(page.getByRole('group', { name: 'Confirm boot' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Cancel' }).click();
  await wall.expectStatus('Rook', 'Active Now');
  await page.unrouteAll();
  await page.route('**/hive/join-info', (r) => r.fulfill({ json: { ingest: hive.ingestPort, key: null } }));
  await page.reload();
  await wall.openDetails('Rook');
  await page.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('menuitem', { name: /boot from hive/i }).click();
  await page.getByRole('menuitem', { name: 'Boot', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Actions for Rook' });
  await menu.getByLabel('Hive key').fill('wrong');
  await menu.getByRole('button', { name: 'Boot' }).click();
  await wall.expectStatus('Rook', 'Active Now');
  await menu.getByLabel('Hive key').fill(hive.key);
  await menu.getByRole('button', { name: 'Boot' }).click();
  await wall.expectGone('Rook');
});

test('the Config page switches theme and the Join page renders', async ({ page, hive }) => {
  await page.goto(`${hive.base}/hive/config`);
  await expect(page.getByLabel('Hive key')).toBeVisible();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto(`${hive.base}/hive/join`);
  await expect(page.getByRole('heading', { name: 'Join the hive' })).toBeVisible();
});
