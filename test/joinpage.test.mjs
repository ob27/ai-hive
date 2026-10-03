import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinPage } from '../src/joinpage.mjs';

test('with a key the page embeds it (prefill on)', () => {
  const html = joinPage({ ingest: 3101, key: 'abc123' });
  assert.match(html, /var PREFILL = "abc123";/);
});

test('without a key the page never contains one (prefill off)', () => {
  const html = joinPage({ ingest: 3101, key: null });
  assert.match(html, /var PREFILL = null;/);
  assert.doesNotMatch(html, /abc123/);
});

test('a hostile key cannot break out of the script block', () => {
  const html = joinPage({ ingest: 3101, key: '</script><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<\/script><script>alert/);
});

test('host config: prefill defaults on, flags are remembered, key persists and rotates', async () => {
  process.env.OFFICE_HOME = mkdtempSync(join(tmpdir(), 'wo-cfg-'));
  const { loadHostConfig } = await import('../src/host.mjs');
  const first = loadHostConfig();
  assert.equal(first.prefillKey, true);
  assert.equal(loadHostConfig().key, first.key, 'key is stable across restarts');
  assert.equal(loadHostConfig({ prefillKey: false }).prefillKey, false);
  assert.equal(loadHostConfig().prefillKey, false, 'the choice is remembered');
  assert.equal(loadHostConfig({ prefillKey: true }).prefillKey, true);
  assert.notEqual(loadHostConfig({ rotate: true }).key, first.key);
  assert.equal(JSON.parse(readFileSync(join(process.env.OFFICE_HOME, 'host.json'), 'utf8')).prefillKey, true);
});
