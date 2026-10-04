import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMode, saveMode } from '../src/mode-store.mjs';

test('the last chosen mode is remembered across restarts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wo-mode-')), 'sub', 'mode.json');
  assert.equal(loadMode(file), null, 'nothing remembered yet');
  saveMode(file, 'work');
  assert.equal(loadMode(file), 'work');
  saveMode(file, 'demo');
  assert.equal(loadMode(file), 'demo');
});

test('a corrupt or foreign file is ignored, never fatal', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wo-mode-')), 'mode.json');
  writeFileSync(file, '{"mode":"banana"}');
  assert.equal(loadMode(file), null);
  writeFileSync(file, 'not json');
  assert.equal(loadMode(file), null);
});
