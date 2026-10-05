import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampFile, uiSourceHash } from '../scripts/stamp-ui.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'hive-ui', 'dist');

test('the committed screen is there, and every file its page loads exists', () => {
  assert.ok(existsSync(join(dist, 'index.html')), 'hive-ui/dist/index.html: build the screen (cd hive-ui && pnpm install && pnpm build) and commit hive-ui/dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/hive\/([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('http'));
  assert.ok(refs.length > 0);
  for (const r of refs) assert.ok(existsSync(join(dist, r)), `index.html loads ${r}, which is missing from hive-ui/dist`);
});

test('the committed screen was built from the current source: change hive-ui and forget to rebuild, and this fails', () => {
  assert.ok(existsSync(stampFile()), 'hive-ui/dist/.src-hash is missing: rebuild the screen (cd hive-ui && pnpm build)');
  assert.equal(readFileSync(stampFile(), 'utf8').trim(), uiSourceHash(), 'hive-ui/src (or its page, public files or build config) changed since hive-ui/dist was built: cd hive-ui && pnpm build, then commit hive-ui/dist');
});
