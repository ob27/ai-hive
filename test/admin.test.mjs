import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore, modelFamily } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { Ledger } from '../src/production.mjs';
import { createIngest } from '../src/ingest.mjs';
import { chooseInvitees } from '../src/chat.mjs';
import { handleAdmin, handleHiveRead } from '../src/hive-http.mjs';

const MIN = 60_000;
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name, extra = {}) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/office/${name}`, ...extra });
const find = (store, name) => store.snapshot().find((m) => m.name === name);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'hive-ledger-')), 'production.json');

/** One finished turn: the tools it used (Edit for real work, nothing for a chat answer), `ms` long, ending with Stop. */
const turn = (store, c, name, tools = [], ms = 1000, extra = {}, meta = {}) => {
  for (const t of tools) store.observe(ev(name, 'PreToolUse', { tool_name: t, tool_input: t === 'Bash' ? { command: 'npm test' } : { file_path: 'a.js' }, ...extra }), meta);
  c.advance(ms);
  store.observe(ev(name, 'Stop', extra), meta);
};

test('turns are counted per agent by what they were worth, kept across a restart, and pooled as the Hive\'s production', () => {
  const file = tmp(); const c = clock();
  const store = new HiveStore({ now: c.now, ledger: new Ledger({ file, saveMs: 0 }) });
  for (let i = 0; i < 3; i++) turn(store, c, 'Quill', ['Edit']);   // three turns that edited a file: a whole cell each
  turn(store, c, 'Clio');                                           // a chat answer, no tools: a sliver
  assert.deepEqual([find(store, 'Quill').turns, find(store, 'Clio').turns], [3, 0.15]);
  assert.equal(store.production().total, 3.15);
  store.ledger.save();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).turns.Quill, 3);
  const later = new HiveStore({ now: c.now, ledger: new Ledger({ file }) }); // the host restarted
  turn(later, c, 'Quill', ['Edit']);
  assert.equal(find(later, 'Quill').turns, 4);
  assert.deepEqual(later.production().agents.map((a) => [a.name, a.turns]), [['Quill', 4], ['Clio', 0.15]]);
  assert.equal(later.production().total, 4.15, 'an agent who has left still counts in the pool');
});

test('the demo\'s pretend agents count in memory only and never reach the ledger', () => {
  const c = clock();
  const store = new HiveStore({ now: c.now, ledger: new Ledger({ file: tmp(), saveMs: 0 }) });
  turn(store, c, 'Barry', ['Edit'], 1000, {}, { sim: true }); turn(store, c, 'Barry', ['Edit'], 1000, {}, { sim: true });
  assert.equal(find(store, 'Barry').turns, 2);
  assert.equal(store.ledger.total(), 0);
  assert.equal(store.production().total, 2);
});

test('the model: the name a hook reports wins, else the tool the seat was joined with, else other', () => {
  const store = new HiveStore();
  store.observe(ev('A', 'SessionStart', { model: 'claude-haiku-4-5-20251001' }), { hooks: ['claude'] });
  store.observe(ev('B', 'SessionStart'), { hooks: ['qwen'] });
  store.observe(ev('C', 'SessionStart', { model: { id: 'qwen3.7-plus', display_name: 'Qwen 3.7 Plus' } }), { hooks: [] });
  store.observe(ev('D', 'SessionStart'), { model: 'gemini-2.5-pro' });
  store.observe(ev('E', 'SessionStart'), {});
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map((n) => [find(store, n).modelFamily, find(store, n).modelName]),
    [['claude', 'claude-haiku-4-5-20251001'], ['qwen', undefined], ['qwen', 'Qwen 3.7 Plus'], ['gemini', 'gemini-2.5-pro'], ['other', undefined]]);
  assert.equal(modelFamily('gpt-5', []), 'gpt');
});

test('composing shows while an agent is writing its answer, clears when it speaks, and expires on its own', () => {
  const c = clock(); const store = new HiveStore({ now: c.now });
  const buzz = new BuzzLog({ now: c.now });
  buzz.onDelivered = (name, lines) => store.setComposing(name, lines[lines.length - 1].kind === 'human' ? 'human' : 'agent');
  buzz.onPosted = (name) => store.clearComposing(name);
  store.observe(ev('Quill', 'Stop'), { chatty: true });
  buzz.post({ from: 'tom', kind: 'human', text: 'hi' });
  return buzz.waitFor(0, 'Quill', 0).then(() => {
    assert.equal(find(store, 'Quill').composing, 'human');
    buzz.post({ from: 'Quill', kind: 'agent', text: 'hello' });
    assert.equal(find(store, 'Quill').composing, undefined);
    store.setComposing('Quill', 'agent');
    assert.equal(find(store, 'Quill').composing, 'agent');
    c.advance(2 * MIN);
    assert.equal(find(store, 'Quill').composing, undefined, 'a reply that never came does not leave the bubble up');
  });
});

test('boot takes the agent off the wall, ignores it from then on, and tells it once; a tap queues a message once', () => {
  const store = new HiveStore();
  store.observe(ev('Quill', 'Stop'), { chatty: true });
  const tap = store.tap('s-Quill', 'tom');
  assert.match(tap.text, /tom tapped you on the shoulder[\s\S]*hive status --members/);
  assert.equal(store.takeNotice('s-Quill'), tap.text);
  assert.equal(store.takeNotice('s-Quill'), null, 'once');
  assert.equal(store.boot('s-Quill').name, 'Quill');
  assert.equal(find(store, 'Quill'), undefined);
  store.observe(ev('Quill', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }));
  assert.equal(find(store, 'Quill'), undefined, 'its next event does not seat it again');
  assert.match(store.takeNotice('s-Quill'), /removed you from the Hive/);
  assert.equal(store.takeNotice('s-Quill'), null);
  assert.equal(store.boot('nobody'), null);
});

test('the tap asks for what is actually wrong: no hooks, stalled, or gone quiet', () => {
  const c = clock(); const store = new HiveStore({ now: c.now });
  store.observe(ev('NoHooks', 'Stop'), { hooks: [] });
  store.observe(ev('Stuck', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }), { hooks: ['claude'] });
  c.advance(6 * MIN);
  assert.match(store.tap('s-NoHooks').text, /joined without hooks[\s\S]*--claude/);
  assert.match(store.tap('s-Stuck').text, /look stalled[\s\S]*hive idle/);
});

const KEY = 'admin-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
let store, buzz, ingest, wall, ingestAddr, wallAddr, home;
before(async () => {
  store = new HiveStore({ ledger: new Ledger({ file: tmp(), saveMs: 0 }) }); buzz = new BuzzLog({ invite: (m, thread) => chooseInvitees(store, thread, m) });
  store.probe = (name) => buzz.isWaiting(name); buzz.onListenChange = () => store.emit();
  ingest = http.createServer(createIngest({ hive: store, buzz, key: KEY, defaultBase: () => ingestAddr }));
  wall = http.createServer((req, res) => handleAdmin(req, res, { hive: store, buzz, key: KEY }) || handleHiveRead(req, res, store, '/nonexistent', buzz, {}) || res.writeHead(404).end());
  await Promise.all([ingest, wall].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  ingestAddr = `127.0.0.1:${ingest.address().port}`; wallAddr = `127.0.0.1:${wall.address().port}`;
  home = mkdtempSync(join(tmpdir(), 'hive-admin-'));
});
after(() => { ingest.close(); wall.close(); });

const run = (args, stdin, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, OFFICE_HOME: home, OFFICE_SEAT: '', HIVE_SEAT: '', ...env } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => resolve({ status, out, err }));
  if (stdin !== undefined) child.stdin.end(JSON.stringify(stdin)); else child.stdin.end();
});
const admin = (body) => fetch(`http://${wallAddr}/hive/admin`, { method: 'POST', body: JSON.stringify(body) });
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(fn(), 'timed out'); };

test('the cog actions need the hive key, and say so in the thread', async () => {
  assert.equal((await run(['join', ingestAddr, 'Tess', '--key', KEY, '--chatty', '--claude', '--model', 'claude-haiku-4-5-20251001'])).status, 0);
  const m = find(store, 'Tess');
  assert.deepEqual([m.modelFamily, m.modelName], ['claude', 'claude-haiku-4-5-20251001']);
  assert.equal((await admin({ action: 'boot', id: m.id })).status, 401);
  assert.equal((await admin({ action: 'boot', id: m.id, key: 'wrong' })).status, 401);
  assert.ok(find(store, 'Tess'), 'still seated');
  assert.equal((await admin({ action: 'nope', id: m.id, key: KEY })).status, 400);
  assert.equal((await admin({ action: 'tap', id: 'ghost', key: KEY })).status, 404);
});

test('a tap reaches an agent that is not in the chat on its next hook event, once', async () => {
  const id = find(store, 'Tess').id;
  assert.equal((await admin({ action: 'tap', id, key: KEY, by: 'tom' })).status, 204);
  assert.ok(buzz.list(5).some((l) => l.kind === 'system' && /tom tapped Tess on the shoulder/.test(l.text)));
  const r = await run(['hook', '--seat', 'Tess'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'x', cwd: home });
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^\[Hive\] tom tapped you on the shoulder/);
  assert.equal((await run(['hook', '--seat', 'Tess'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'x', cwd: home })).out, '', 'only once');
});

test('a tap wakes an agent sitting in the chat at once, and hands it over without the chat-only lock', async () => {
  const id = find(store, 'Tess').id;
  const stop = run(['hook', '--seat', 'Tess'], { hook_event_name: 'Stop', session_id: 'x', cwd: home }, { HIVE_LISTEN_WAIT: '20' });
  await until(() => find(store, 'Tess').status === 'listening');
  const t0 = Date.now();
  assert.equal((await admin({ action: 'tap', id, key: KEY, by: 'tom' })).status, 204);
  const handed = JSON.parse((await stop).out);
  assert.ok(Date.now() - t0 < 5000, 'woken, not timed out');
  assert.equal(handed.decision, 'block');
  assert.match(handed.reason, /^\[Hive\] tom tapped you on the shoulder/);
  const read = await run(['hook', '--seat', 'Tess'], { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, session_id: 'x', cwd: home });
  assert.equal(read.out, '', 'a tap turn is not chat-locked: the agent has to be able to fix its seating');
});

test('boot removes the agent, and its next event brings it the news once and seats it no more', async () => {
  const id = find(store, 'Tess').id;
  assert.equal((await admin({ action: 'boot', id, key: KEY, by: 'tom' })).status, 204);
  assert.equal(find(store, 'Tess'), undefined);
  assert.ok(buzz.list(5).some((l) => /Tess was booted from the hive by tom/.test(l.text)));
  const r = await run(['hook', '--seat', 'Tess'], { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'x', cwd: home });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /removed you from the Hive/);
  await run(['hook', '--seat', 'Tess'], { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, session_id: 'x', cwd: home });
  assert.equal(find(store, 'Tess'), undefined);
  const prod = await (await fetch(`http://${wallAddr}/hive/production`)).json();
  assert.equal(typeof prod.total, 'number');
});

test('"responding to" names the person the agent works for: --user at join, else $HIVE_USER, else the machine\'s account name', async () => {
  assert.equal((await run(['join', ingestAddr, 'Dana', '--key', KEY, '--claude', '--user', 'Dana Whitfield'])).status, 0);
  assert.equal(find(store, 'Dana').user, 'Dana Whitfield');
  const prompt = (env) => run(['hook', '--seat', 'Dana'], { hook_event_name: 'UserPromptSubmit', prompt: 'do it', session_id: 'x', cwd: home }, env);
  await prompt({});
  assert.equal(find(store, 'Dana').activity, 'responding to Dana Whitfield');
  await prompt({ HIVE_USER: 'Sam' });
  assert.equal(find(store, 'Dana').activity, 'responding to Sam', 'the environment can override it for one run');
  assert.equal((await run(['join', ingestAddr, 'Eve', '--key', KEY, '--claude'])).status, 0);
  await run(['hook', '--seat', 'Eve'], { hook_event_name: 'UserPromptSubmit', prompt: 'do it', session_id: 'x', cwd: home });
  assert.match(find(store, 'Eve').activity, /^responding to \S+/, 'no --user: falls back to the account name');
  assert.equal(find(store, 'Eve').user, undefined);
  await run(['leave', '--seat', 'Dana']); await run(['leave', '--seat', 'Eve']);
});

test('a Cursor-only agent cannot be tapped (Cursor has no hook that carries text back), and the wall says so', () => {
  const s = new HiveStore();
  s.observe(ev('Cur', 'Stop'), { hooks: ['cursor'] });
  s.observe(ev('Both', 'Stop'), { hooks: ['cursor', 'claude'] });
  assert.deepEqual(find(s, 'Cur').tools, ['cursor']);
  assert.equal(s.tap('s-Cur').unsupported, true);
  assert.equal(s.takeNotice('s-Cur'), null, 'nothing was queued');
  assert.match(s.tap('s-Both').text, /tapped you on the shoulder/);
});

test('"Ask to listen" is only for a working, chatty agent; anyone else is told why not', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Busy', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } }), { chatty: true, hooks: ['claude'] });
  s.observe(ev('Quiet', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } }), { chatty: false, hooks: ['claude'] });
  s.observe(ev('Idle', 'Stop'), { chatty: true, hooks: ['claude'] });
  s.observe(ev('Cur', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } }), { chatty: true, hooks: ['cursor'] });
  c.advance(2 * MIN); // long enough for the one that stopped to be idle (no longer listening) rather than just-finished
  s.observe(ev('Busy', 'PostToolUse')); s.observe(ev('Quiet', 'PostToolUse')); s.observe(ev('Cur', 'PostToolUse'));
  const ok = s.askToListen('s-Busy', 'tom');
  assert.match(ok.text, /^tom would like you in Hive Chat[\s\S]*hive listen[\s\S]*keep listening until the person you work for tells you to stop/);
  assert.equal(s.takeNotice('s-Busy'), ok.text, 'it reaches the agent on its next event');
  assert.match(s.askToListen('s-Quiet').refused, /did not join with --chatty/);
  assert.match(s.askToListen('s-Idle').refused, /not working right now/);
  s.observe(ev('Fresh', 'Stop'), { chatty: true, hooks: ['claude'] });
  assert.match(s.askToListen('s-Fresh').refused, /already listening/);
  assert.match(s.askToListen('s-Cur').refused, /Cursor/);
  assert.equal(s.askToListen('nobody'), null);
});

test('the cog\'s Ask to listen reaches a working agent on its next hook event, and refuses an idle one with a reason', async () => {
  assert.equal((await run(['join', ingestAddr, 'Lee', '--key', KEY, '--chatty', '--claude'])).status, 0);
  const id = find(store, 'Lee').id;
  assert.equal((await admin({ action: 'listen', id, key: KEY })).status, 409, 'idle: nothing running to receive it');
  await run(['hook', '--seat', 'Lee'], { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' }, session_id: 'x', cwd: home });
  assert.equal((await admin({ action: 'listen', id, key: KEY, by: 'tom' })).status, 204);
  assert.ok(buzz.list(5).some((l) => /tom asked Lee to listen/.test(l.text)));
  const r = await run(['hook', '--seat', 'Lee'], { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 'x', cwd: home });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /^\[Hive\] tom would like you in Hive Chat[\s\S]*hive listen/);
  assert.equal((await admin({ action: 'listen', id: 'ghost', key: KEY })).status, 404);
  await run(['leave', '--seat', 'Lee']);
});

test('a manual listen loop ends itself: after a few quiet listens the CLI tells the agent to go back to its task, and any chat resets it', async () => {
  assert.equal((await run(['join', ingestAddr, 'Pip', '--key', KEY, '--chatty', '--claude'])).status, 0);
  const listen = () => run(['listen', '--seat', 'Pip', '--wait', '1']);
  const first = await listen();
  assert.equal(first.status, 3);
  assert.match(first.out, /^\(quiet: nothing new in the buzz\. Run `hive listen` again/);
  const second = await listen();
  assert.match(second.out, /^Nobody has spoken in Hive Chat for about \d+ minutes?\. Stop listening now and go back to what you were doing/);
  assert.match((await listen()).out, /^\(quiet/, 'it starts counting again');
  // someone speaks: the count is reset, so the next quiet one is just quiet again
  const pending = listen();
  await until(() => buzz.isWaiting('Pip'));
  buzz.post({ from: 'tom', kind: 'human', text: 'hi Pip' });
  assert.match((await pending).out, /tom \(human\): hi Pip/);
  assert.match((await listen()).out, /^\(quiet/);
  await run(['leave', '--seat', 'Pip']);
});
