import { test as base, expect } from '@playwright/test';
import { startHive } from './hive.mjs';

/** The wall as a user sees it: a thin page object so scenarios read like what a person would check. */
export class Wall {
  constructor(page, hive) { this.page = page; this.hive = hive; }
  async open(path = '/hive/') { await this.page.goto(`${this.hive.base}${path}`); return this; }
  tile(name) { return this.page.getByRole('button', { name: new RegExp(`^${name}, `) }); }
  async expectStatus(name, status, timeout = 15_000) { await expect(this.tile(name)).toHaveAccessibleName(new RegExp(`^${name}, ${status}`), { timeout }); }
  async expectGone(name, timeout = 15_000) { await expect(this.tile(name)).toHaveCount(0, { timeout }); }
  /** A tile's text (name, project, activity). */
  async expectText(name, re, timeout = 15_000) { await expect(this.tile(name)).toContainText(re, { timeout }); }
  helpers(name) { return this.tile(name).locator('[data-rebar-part="helpers"]'); }
  thread() { return this.page.getByRole('list', { name: 'Conversation' }); }
  async openDetails(name) { await this.tile(name).click(); return this; }
}

/** `hive` is one real host per worker (so files can run in parallel); `wall` is a page already pointed at it. */
export const test = base.extend({
  hive: [async ({}, use) => { const h = await startHive(); await h.start(); await use(h); await h.stop(); }, { scope: 'worker' }],
  wall: async ({ page, hive }, use) => { await use(await new Wall(page, hive).open()); },
});
export { expect };
