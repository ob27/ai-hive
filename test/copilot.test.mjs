import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsFromLine, coalesce, watchCopilot } from '../src/copilot.mjs';

const tool = (toolId, id, file) => ({ kind: 'toolInvocationSerialized', toolId, toolCallId: id, isComplete: true, invocationMessage: { value: 'x', uris: file ? { [`file://${file}#1-1`]: { path: file } } : {} } });
const response = (n, items) => ({ kind: 2, k: ['requests', n, 'response'], v: items });

test('tool calls become actions with file names; repeats are not re-reported', () => {
  const st = { seen: new Set() };
  const a = actionsFromLine(response(0, [tool('copilot_readFile', 'c1', '/p/a.tsx'), tool('run_in_terminal', 'c2')]), st);
  assert.deepEqual(a, [{ type: 'pre', tool: 'Read', input: { file_path: '/p/a.tsx' } }, { type: 'pre', tool: 'Bash', input: { command: 'running a command' } }]);
  // the response array is rewritten in overlapping batches
  assert.deepEqual(actionsFromLine(response(0, [tool('copilot_readFile', 'c1', '/p/a.tsx'), tool('copilot_replaceString', 'c3', '/p/b.ts')]), st).map((x) => x.tool), ['Edit']);
});

test('turn start, turn end, history ignored', () => {
  const st = { seen: new Set() };
  assert.deepEqual(actionsFromLine({ kind: 2, k: ['requests'], v: [{}] }, st), [{ type: 'prompt' }]);
  assert.deepEqual(actionsFromLine({ kind: 1, k: ['requests', 0, 'result'], v: {} }, st), [{ type: 'stop' }]);
  assert.deepEqual(actionsFromLine({ kind: 0, v: { requests: [{}] } }, st), []);
  assert.deepEqual(actionsFromLine({ kind: 1, k: ['requests', 0, 'completionTokens'], v: 5 }, st), []);
});

test('commands are never put on the screen', () => {
  const [a] = actionsFromLine(response(0, [{ ...tool('run_in_terminal', 'c9'), invocationMessage: { value: 'Running `curl -H "Authorization: SECRET"`' } }]), { seen: new Set() });
  assert.doesNotMatch(JSON.stringify(a), /SECRET|curl/);
});

test('a burst is coalesced to: prompt, then the latest thing', () => {
  const burst = [{ type: 'prompt' }, { type: 'pre', tool: 'Read' }, { type: 'pre', tool: 'Edit' }];
  assert.deepEqual(coalesce(burst).map((x) => x.tool ?? x.type), ['prompt', 'Edit']);
});

test('watcher: ignores history, reports a new turn written after it started', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => server.listen(0, r));
  const root = mkdtempSync(join(tmpdir(), 'wo-'));
  const dir = join(root, 'workspaceStorage', 'abc', 'chatSessions');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 's1.jsonl');
  writeFileSync(log, JSON.stringify({ kind: 0, v: { requests: [] } }) + '\n' + JSON.stringify(response(0, [tool('copilot_readFile', 'old', '/old.ts')])) + '\n');

  const seat = { url: `http://127.0.0.1:${server.address().port}`, token: 't', sessionId: 'sid', cwd: '/office/Test' };
  const w = watchCopilot(seat, { user: 'tom', userDirs: [root], pollMs: 3_600_000 });
  await w.tick();
  assert.equal(seen.length, 0, 'history must not be replayed');

  appendFileSync(log, JSON.stringify({ kind: 2, k: ['requests'], v: [{}] }) + '\n');
  appendFileSync(log, JSON.stringify(response(1, [tool('copilot_replaceString', 'n1', '/p/new.ts')])) + '\n');
  appendFileSync(log, JSON.stringify({ kind: 1, k: ['requests', 1, 'result'], v: {} }).slice(0, 20)); // half-written line: must wait for its newline
  await w.tick();
  const names = seen.map((e) => e.hook_event_name + (e.tool_name ? `:${e.tool_name}` : '') + (e.tool_input?.command ? `(${e.tool_input.command})` : ''));
  assert.ok(names.includes('PreToolUse:Bash(responding to tom)'), names.join(' '));
  assert.ok(names.includes('PreToolUse:Edit'), names.join(' '));
  assert.ok(!names.some((n) => n === 'Stop'), 'half-written result line must not count yet');

  appendFileSync(log, JSON.stringify({ kind: 1, k: ['requests', 1, 'result'], v: {} }).slice(20) + '\n');
  await w.tick();
  assert.equal(seen.at(-1).hook_event_name, 'Stop');
  w.stop(); server.close();
});
