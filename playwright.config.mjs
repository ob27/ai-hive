import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// A real demo host (work mode: only real agents) on spare ports, with its state and seats in a throwaway home.
// Build the screen first: cd hive-ui && pnpm install && pnpm build
const home = mkdtempSync(join(tmpdir(), 'hive-e2e-'));
const env = { HOME: home, HIVE_HOME: join(home, '.workspace-office'), HIVE_DEMO_KEY: 'e2e-key' };
Object.assign(process.env, { E2E_HOME: home, E2E_KEY: env.HIVE_DEMO_KEY, E2E_INGEST: '127.0.0.1:3292' });

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3290' },
  webServer: {
    command: 'node scripts/hive-demo.mjs --port 3290 --ingest 3292 --work',
    url: 'http://127.0.0.1:3290/hive/',
    env,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
