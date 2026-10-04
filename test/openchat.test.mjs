import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_OPEN_URI, openChatPlan, openClaudeChat } from '../src/openchat.mjs';

test('plan: focus the folder in VS Code, then open the extension link, per platform', () => {
  const mac = openChatPlan('/p/x', 'darwin');
  assert.deepEqual(mac.steps, [['code', ['/p/x']], ['open', [CLAUDE_OPEN_URI]]]);
  assert.equal(openChatPlan('/p', 'win32').steps[0][0], 'code.cmd');
  assert.equal(openChatPlan('/p', 'linux').steps[1][0], 'xdg-open');
  assert.equal(CLAUDE_OPEN_URI, 'vscode://anthropic.claude-code/open'); // no session parameter: a new conversation
});

test('runs the steps in order with a pause between them', async () => {
  const log = [];
  const r = await openClaudeChat('/p', { platform: 'darwin', runStep: async ([c]) => { log.push(c); return true; }, wait: async (ms) => log.push(`wait${ms}`) });
  assert.deepEqual(log, ['code', 'wait2500', 'open']);
  assert.equal(r.ok, true);
});

test('never throws: a missing `code` command comes back as a reason', async () => {
  const r = await openClaudeChat('/p', { platform: 'darwin', runStep: async () => false, wait: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /code/);
});
