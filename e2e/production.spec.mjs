// Hive Production: the header counter's leaderboard (top five projects) and the honeycomb heatmap page it leads to.
import { test, expect } from './harness/fixtures.mjs';
import { ClaudeAgent } from './harness/agents.mjs';

/** `turns` finished turns by one agent working in project `project` (each turn: some reading, then the turn ends). */
async function produce(hive, project, turns) {
  const a = await new ClaudeAgent(hive, `${project}-bot`, { project }).join();
  for (let i = 0; i < turns; i++) { await a.prompt(); await a.work(`f${i}.js`); await a.idle(); }
  return a;
}

// (first: production is kept in the host's home for good, so "nothing yet" can only be seen before the other tests add some)
test('with no production yet the popover says so, and still offers the heatmap', async ({ hive, wall, page }) => {
  await wall.open();
  await page.getByRole('button', { name: 'About Hive Production' }).click();
  await expect(page.getByText(/No production yet/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'See heatmap' })).toBeVisible();
});

test('the leaderboard shows the five most productive projects, biggest first, and a way to the heatmap', async ({ hive, wall, page }) => {
  const plan = [['alpha', 7], ['beta', 5], ['gamma', 4], ['delta', 3], ['epsilon', 2], ['zeta', 1]];
  for (const [project, turns] of plan) await produce(hive, project, turns);
  await expect.poll(async () => (await (await fetch(`${hive.base}/hive/production`)).json()).projects.length).toBeGreaterThanOrEqual(5);
  await wall.open();
  await page.getByRole('button', { name: 'About Hive Production' }).click();
  const board = page.getByRole('list', { name: 'Top projects by production' });
  await expect(board.getByRole('listitem')).toHaveCount(5);
  const names = await board.getByRole('listitem').evaluateAll((els) => els.map((e) => e.querySelector('[title]')?.getAttribute('title')));
  expect(names).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']); // zeta is sixth: not shown
  await expect(page.getByRole('link', { name: 'See heatmap' })).toBeVisible();
});

test('See heatmap opens the heatmap page: a year of honeycomb cells, today shaded, summary and the scoring explained', async ({ hive, wall, page }) => {
  await produce(hive, 'heat', 3);
  await wall.open();
  await page.getByRole('button', { name: 'About Hive Production' }).click();
  await page.getByRole('link', { name: 'See heatmap' }).click();
  await expect(page).toHaveURL(/\/hive\/heatmap$/);
  await expect(page.getByRole('heading', { name: 'Hive Production' })).toBeVisible();
  const chart = page.getByRole('img', { name: /Production per day/ });
  await expect(chart).toBeVisible();
  expect(await chart.locator('polygon').count()).toBeGreaterThan(360); // hexagons, not squares
  expect(await chart.locator('rect').count()).toBeLessThan(5);          // (the legend may use a few)
  const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const days = await (await fetch(`${hive.base}/hive/production-days`)).json();
  expect(days.at(-1).date).toBe(iso);
  expect(days.at(-1).value).toBeGreaterThan(0);
  await expect(page.getByRole('group', { name: 'Production summary' })).toContainText('Active days');
  await expect(page.getByRole('group', { name: 'Production summary' })).toContainText('1'); // one active day
  await expect(page.getByRole('region', { name: 'How a turn is worth' })).toBeVisible();
  await page.screenshot({ path: 'test-results/heatmap.png', fullPage: true });
  await page.getByRole('link', { name: /Back to the wall/ }).click();
  await expect(page).toHaveURL(/\/hive\/$/);
});

test('the heatmap page works in demo mode with made-up data and no host needed', async ({ hive, page }) => {
  await page.goto(`${hive.base}/hive/heatmap?demo`);
  await expect(page.getByRole('img', { name: /Production per day/ }).locator('polygon').first()).toBeVisible();
});
