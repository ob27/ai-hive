import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { createIngest } from '../src/ingest.mjs';
import { startProxy, toolCallsFrom } from '../src/proxy.mjs';
import { runWrapped } from '../src/run.mjs';

const KEY = 'adapter-key';
const store = new HiveStore(); const buzz = new BuzzLog();
const seen = [];                                 // every hook event the ingest received
let ingest, ingestUrl;
const closers = [];

before(async () => {
  ingest = http.createServer(createIngest({ hive: store, buzz, key: KEY, defaultBase: () => 'x', onHook: async (p) => { seen.push(p); return 200; } }));
  await new Promise((r) => ingest.listen(0, '127.0.0.1', r));
  ingestUrl = `http://127.0.0.1:${ingest.address().port}`;
});
after(() => { ingest.close(); closers.forEach((c) => c()); });

const seat = (name) => ({ name, url: ingestUrl, token: KEY, project: 'adapters', hooks: [], sessionId: `s-${name}`, cwd: `/office/${name}` });
const member = (name) => store.snapshot().find((m) => m.name === name);
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => { closers.push(() => s.close()); r(s.address().port); }); });

test('toolCallsFrom reads tool calls from a plain JSON completion and from a streamed one', () => {
  const json = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'run_shell_command', arguments: '{"command":"ls -la"}' } }] } }] });
  assert.deepEqual(toolCallsFrom(json), [{ name: 'run_shell_command', args: '{"command":"ls -la"}' }]);
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/a/b.ts\\"}"}}]}}]}',
    'data: [DONE]',
  ].join('\n');
  assert.deepEqual(toolCallsFrom(sse), [{ name: 'read_file', args: '{"path":"/a/b.ts"}' }]);
  assert.deepEqual(toolCallsFrom(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })), []);
});

test('hive proxy: a model behind it shows as thinking, then as each tool it calls, then idle, with no cooperation from the model', async () => {
  let reply = { choices: [{ message: { tool_calls: [{ function: { name: 'run_shell_command', arguments: '{"command":"pnpm test"}' } }] } }] };
  const upstream = await listen((req, res) => { req.resume(); req.on('end', () => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)), 150)); });
  const proxy = startProxy(seat('ProxyBee'), { listen: 0, target: `http://127.0.0.1:${upstream}/v1` });
  await new Promise((r) => proxy.once('listening', r));
  closers.push(() => proxy.close());
  const call = () => fetch(`http://127.0.0.1:${proxy.address().port}/chat/completions`, { method: 'POST', body: '{}' }).then((r) => r.text());

  const pending = call();
  assert.ok(await until(() => member('ProxyBee')?.status === 'active' && member('ProxyBee')?.activity === 'thinking…'), 'thinking while the request is in flight');
  assert.match(await pending, /run_shell_command/, 'the model\'s answer passes through untouched');
  assert.ok(await until(() => member('ProxyBee')?.activity === 'pnpm test'), 'the tool call it made shows as its activity');

  reply = { choices: [{ message: { content: 'All done.' } }] };
  await call();
  assert.ok(await until(() => member('ProxyBee')?.status === 'idle'), 'a reply with no tool calls means idle');
});

test('hive run: a command shows as working while it prints, and its seat leaves when it exits; its exit code is passed on', async () => {
  const code = await runWrapped(seat('RunBee'), [process.execPath, '-e', 'console.log("crawling the planning site"); setTimeout(() => process.exit(3), 120)']);
  assert.equal(code, 3);
  const work = seen.find((p) => p.session_id === 's-RunBee' && p.hook_event_name === 'PreToolUse');
  assert.equal(work.tool_input.command, 'crawling the planning site');
  assert.equal(seen.filter((p) => p.session_id === 's-RunBee').at(-1).hook_event_name, 'SessionEnd');
  assert.equal(member('RunBee'), undefined);
});
