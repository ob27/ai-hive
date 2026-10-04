import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliFiles } from '../src/bootstrap.mjs';

// What a seat machine gets from `curl <host>/join | node -` is exactly cliFiles() written into ~/.workspace-office/cli.
// The CLI must start from only those files. (It once crashed on import because bin/ statically pulled in host-only
// code from scripts/, which is not part of the download.)
test('the downloaded CLI starts from the served files alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wo-bundle-'));
  for (const [file, text] of Object.entries(cliFiles())) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'bin', 'office.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir, OFFICE_HOME: join(dir, 'home') } });
  const help = run();
  assert.doesNotMatch(help.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, help.stderr);
  assert.equal(help.status, 0, help.stderr);
  // an ordinary seat command gets past module loading too (it then fails for lack of a seat, which is fine)
  const say = run('say', 'hello', '--seat', 'nobody');
  assert.doesNotMatch(say.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, say.stderr);
});
