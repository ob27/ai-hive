import { defineConfig } from '@playwright/test';

// No webServer here: each worker starts its own real hive (e2e/harness/hive.mjs) on free ports in a throwaway home, so spec files
// run in parallel and nothing touches your real hive or any project's hook files.
// Build the screen first: cd hive-ui && pnpm install && pnpm build        Browsers once: npx playwright install chromium
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 3,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
