import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { chooseInvitees, botDepth, NOBODY_MESSAGE } from '../src/chat.mjs';
import { AWAY, TYPING } from '../src/phrases.mjs';
import { allowedInChat, continuation, denial } from '../src/listenloop.mjs';
import { createIngest } from '../src/ingest.mjs';
import { handleHumanBuzz } from '../src/hive-http.mjs';

const MIN = 60_000;
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name, extra = {}) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/office/${name}`, ...extra });
/** A hive with these chatty agents: listening (just stopped) or active (mid-turn) or idle (stopped long ago). */
function room(c, spec) {
  const store = new HiveStore({ now: c.now });
  const buzz = new BuzzLog({ now: c.now, invite: (m, thread) => chooseInvitees(store, thread, m, { rand: () => 0.5 }) });
  for (const [name, state] of Object.entries(spec)) {
    store.observe(ev(name, state === 'active' ? 'PreToolUse' : 'Stop', { tool_name: 'Bash', tool_input: { command: 'work' } }), { chatty: true });
  }
  for (const [name, state] of Object.entries(spec)) if (state === 'idle') store.agents.get(`s-${name}`).listenFrom -= 5 * MIN;
  return { store, buzz };
}

test('a chatty agent that just finished is Listening, then wanders off; nobody else is ever Listening', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  s.observe(ev('Ada', 'Stop'), { chatty: true }); s.observe(ev('Bob', 'Stop'), { chatty: false });
  assert.deepEqual(s.snapshot().map((m) => [m.name, m.status, m.statusLabel]).sort(), [['Ada', 'listening', 'Listening'], ['Bob', 'idle', 'Idle']]);
  c.advance(2 * MIN);
  assert.equal(s.snapshot().find((m) => m.name === 'Ada').status, 'idle');
  s.observe(ev('Ada', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }), { chatty: true });
  assert.equal(s.snapshot().find((m) => m.name === 'Ada').status, 'active');
});

test('with the host watching, Listening means a real open wait: a fresh join, or a turn that ended with no hook, is not listening', async () => {
  const c = clock(); const store = new HiveStore({ now: c.now }); const buzz = new BuzzLog({ now: c.now });
  store.connect(buzz);
  store.observe(ev('Tim', 'Stop'), { chatty: true }); // what `hive join` reports
  assert.equal(store.snapshot()[0].status, 'idle');
  const wait = buzz.waitFor(0, 'Tim', 5000);
  assert.equal(store.snapshot()[0].status, 'listening');
  buzz.post({ from: 'tom', kind: 'human', text: 'hi' });
  await wait;
  assert.deepEqual([store.snapshot()[0].status, store.snapshot()[0].statusLabel], ['active', 'Typing…'], 'it was handed the line: it is writing its answer');
  buzz.post({ from: 'Tim', kind: 'agent', text: 'hello' });
  assert.equal(store.snapshot()[0].status, 'idle', 'it has answered and the wait is over: it is no longer in the chat until it listens again');
});

test('chatReady is true only while a chatty agent is listening: idle ones are away and busy ones will not answer for minutes', () => {
  const c = clock();
  assert.equal(room(c, { A: 'idle', B: 'idle' }).store.chatReady().ok, false);
  assert.equal(room(c, { A: 'idle', B: 'active' }).store.chatReady().ok, false, 'busy in the middle of a turn');
  assert.deepEqual(room(c, { A: 'idle', B: 'listening', C: 'active' }).store.chatReady().listening, ['B']);
});

test('a person\'s line invites at most two agents, free listeners before busy ones, never an idle one', () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening', B: 'listening', C: 'listening', D: 'active', E: 'idle' });
  const { message } = buzz.post({ from: 'tom', kind: 'human', text: 'hi' });
  assert.equal(message.invited.length, 2);
  assert.ok(message.invited.every((n) => ['A', 'B', 'C'].includes(n)));
});

test('a system line that merely names an agent ("X asked A to listen") invites nobody', () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening' });
  assert.deepEqual(buzz.post({ from: 'hive', kind: 'system', text: 'tom asked A to listen.' }).message.invited, []);
});

test('a name in the line is always invited, and ambient lines invite nobody', () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening', B: 'listening', C: 'listening' });
  assert.ok(buzz.post({ from: 'tom', kind: 'human', text: 'C, how is the survey going?' }).message.invited.includes('C'));
  assert.deepEqual(buzz.post({ from: 'A', kind: 'agent', text: 'phew, that was a hard one' }).message.invited, []);
  assert.deepEqual(buzz.post({ from: 'hive', kind: 'system', text: 'D joined the hive.' }).message.invited, []);
  assert.equal(buzz.post({ from: 'hive', kind: 'system', text: 'DSL Service stopped responding.' }).message.invited.length, 1);
});

test('only invited agents hear a line, the second after the first has answered, and never their own', async () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening', B: 'listening', C: 'listening' });
  const line = buzz.post({ from: 'tom', kind: 'human', text: 'hi' }).message;
  const [first, second] = line.invited; const outsider = ['A', 'B', 'C'].find((n) => !line.invited.includes(n));
  assert.equal((await buzz.waitFor(0, outsider, 0)).length, 0, 'not invited: nothing wakes it');
  assert.equal((await buzz.waitFor(0, first, 0)).length, 1);
  assert.equal((await buzz.waitFor(0, second, 0)).length, 0, 'the second waits for the first');
  c.advance(16_000);
  assert.equal((await buzz.waitFor(0, second, 0)).length, 1, 'or for the stagger to pass');
  c.advance(4 * MIN);
  assert.equal((await buzz.waitFor(0, first, 0)).length, 0, 'a stale line is no longer worth waking anyone');
});

test('a listen that would end just before its queued line becomes its own is stretched to catch it', async () => {
  const buzz = new BuzzLog({ staggerMs: 200, invite: () => ['A', 'B'] }); // real clock: this is about timers
  const wait = buzz.waitFor(0, 'B', 300);
  setTimeout(() => buzz.post({ from: 'tom', kind: 'human', text: 'hi' }), 200); // B is second: eligible at +400ms, after its 300ms wait would have ended
  const lines = await wait;
  assert.equal(lines.length, 1);
  assert.equal(buzz.isWaiting('B'), false);
  assert.deepEqual(await buzz.waitFor(lines[0].id, 'B', 50), [], 'and a wait with nothing queued still ends on time');
});

test('a reply from an agent that was not invited, or to a line that has its answers, is refused', () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening', B: 'listening', C: 'listening' });
  const line = buzz.post({ from: 'tom', kind: 'human', text: 'hi' }).message;
  const outsider = ['A', 'B', 'C'].find((n) => !line.invited.includes(n));
  assert.equal(buzz.post({ from: outsider, kind: 'agent', text: 'me too', replyTo: line.id }).status, 409);
  assert.equal(buzz.post({ from: line.invited[0], kind: 'agent', text: 'hello', replyTo: line.id }).ok, true);
  assert.equal(buzz.post({ from: line.invited[1], kind: 'agent', text: 'hello again', replyTo: line.id }).ok, true);
  assert.equal(buzz.post({ from: outsider, kind: 'agent', text: 'third', replyTo: line.id }).status, 409);
});

test('bots do not keep each other talking: a bot answer invites one more bot until the thread is two deep', () => {
  const c = clock(); const { buzz } = room(c, { A: 'listening', B: 'listening', C: 'listening' });
  const q = buzz.post({ from: 'tom', kind: 'human', text: 'hi' }).message;
  const a1 = buzz.post({ from: q.invited[0], kind: 'agent', text: 'hello', replyTo: q.id }).message;
  assert.equal(a1.invited.length, 1);
  assert.ok(!a1.invited.includes(q.invited[0]), 'not the bot that just spoke');
  const a2 = buzz.post({ from: a1.invited[0], kind: 'agent', text: 'hi back', replyTo: a1.id }).message;
  assert.equal(botDepth(buzz.list(20), a2), 2);
  assert.deepEqual(a2.invited, [], 'two bot turns deep: the thread goes quiet');
});

test('when nobody is listening a person\'s line still lands in the thread and the Hive itself says nobody is available', async () => {
  const c = clock(); const { store, buzz } = room(c, { A: 'idle', B: 'idle' });
  const srv = http.createServer((req, res) => handleHumanBuzz(req, res, buzz, store) || res.writeHead(404).end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const post = (text = 'hi') => fetch(`http://127.0.0.1:${srv.address().port}/hive/buzz`, { method: 'POST', body: JSON.stringify({ name: 'tom', text }) });
  const lastTwo = () => buzz.list(2).map((m) => [m.from, m.kind, m.text, m.quote?.text]);
  assert.equal((await post()).status, 204);
  assert.deepEqual(lastTwo(), [['tom', 'human', 'hi', undefined], ['hive', 'system', NOBODY_MESSAGE, 'hi']], 'the reply is quoted under their line');
  await post('anyone?');
  assert.equal(buzz.list(5).filter((m) => m.text === NOBODY_MESSAGE).length, 1, 'not repeated for a line typed straight after');
  store.observe(ev('A', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } }), { chatty: true });
  c.advance(60_000);
  assert.equal(store.chatReady().ok, false, 'busy in the middle of a turn: it will not answer for minutes');
  store.observe(ev('A', 'Stop'), { chatty: true });
  const n = buzz.list(50).length;
  assert.equal((await post('now?')).status, 204);
  assert.equal(buzz.list(50).length, n + 1, 'finished its turn and listening: no apology, just the line');
  srv.close();
});

test('chat stays open for a few seconds after the last listener stops, then closes', async () => {
  const c = clock(); const store = new HiveStore({ now: c.now }); const buzz = new BuzzLog({ now: c.now });
  store.connect(buzz);
  store.observe(ev('Q', 'Stop'), { chatty: true });
  const wait = buzz.waitFor(0, 'Q', 40);            // Q sits in the chat for a moment, then its wait ends with nothing said
  assert.equal(store.chatReady().ok, true);
  assert.equal(store.snapshot()[0].status, 'listening');
  await wait;
  assert.equal(store.snapshot()[0].status, 'idle');
  assert.equal(store.chatReady().ok, true, 'still open: it only just stopped');
  assert.equal(store.snapshot()[0].chatOpen, true);
  c.advance(15_000); assert.equal(store.chatReady().ok, true);
  c.advance(10_000); assert.equal(store.chatReady().ok, false, 'the grace period is over');
  store.observe(ev('Q', 'Stop'), { chatty: true });
  const again = buzz.waitFor(0, 'Q', 40); assert.equal(store.chatReady().ok, true);
  await again; // its wait ends, then it starts working
  store.observe(ev('Q', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } }), { chatty: true });
  assert.equal(store.snapshot()[0].chatOpen, false, 'working again: no grace');
});

test('each tool is told to carry on, and to deny a tool, in its own hook format', () => {
  assert.deepEqual(JSON.parse(continuation({ hook_event_name: 'Stop' }, 'x')), { decision: 'block', reason: 'x' });
  assert.deepEqual(JSON.parse(continuation({ hook_event_name: 'AfterAgent' }, 'x')), { decision: 'deny', reason: 'x' });
  assert.deepEqual(JSON.parse(continuation({ hook_event_name: 'stop' }, 'x')), { followup_message: 'x' });
  assert.equal(JSON.parse(denial({ hook_event_name: 'PreToolUse' }, 'no')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(denial({ hook_event_name: 'BeforeTool' }, 'no')).decision, 'deny');
  assert.equal(JSON.parse(denial({ hook_event_name: 'beforeReadFile' }, 'no')).permission, 'deny');
  assert.equal(denial({ hook_event_name: 'afterFileEdit' }, 'no'), null, 'Cursor cannot deny after the fact');
});

test('a chat turn may use the web and the hive chat commands, and nothing else', () => {
  const tool = (tool_name, command) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: command === undefined ? { file_path: '/x' } : { command } });
  assert.ok(allowedInChat(tool('WebSearch')));
  assert.ok(allowedInChat(tool('Bash', 'hive buzz --reply 12 "same here (honestly)"')));
  assert.ok(allowedInChat(tool('Bash', 'hive listen')));
  for (const bad of [tool('Read'), tool('Edit'), tool('Write'), tool('Bash', 'cat secrets.txt'), tool('Bash', 'hive buzz "x"; rm -rf ~'), tool('Bash', 'hive buzz "$(cat .env)"'), tool('Bash', 'hive buzz x | sh')]) assert.equal(allowedInChat(bad), false, JSON.stringify(bad));
  assert.ok(allowedInChat({ hook_event_name: 'BeforeTool', tool_name: 'google_web_search', tool_input: {} }));
  assert.equal(allowedInChat({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: {} }), false);
});

// --- the loop, end to end: a real CLI seat's Stop hook sits in the chat and hands it a line ---
const KEY = 'chat-key';
const CLI = join(import.meta.dirname, '..', 'bin', 'office.mjs');
let store, buzz, server, addr, home;
before(async () => {
  store = new HiveStore(); buzz = new BuzzLog({ invite: (m, thread) => chooseInvitees(store, thread, m) });
  store.connect(buzz);
  server = http.createServer(createIngest({ hive: store, buzz, key: KEY, defaultBase: () => addr }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  addr = `127.0.0.1:${server.address().port}`;
  home = mkdtempSync(join(tmpdir(), 'hive-loop-'));
});
after(() => server.close());

const run = (args, stdin, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, OFFICE_HOME: home, OFFICE_SEAT: '', HIVE_SEAT: '', ...env } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => resolve({ status, out, err }));
  if (stdin !== undefined) child.stdin.end(JSON.stringify(stdin)); else child.stdin.end();
});
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(fn(), 'timed out'); };

test('a chatty seat\'s Stop hook listens, hands over the line that was asked, and locks the turn to chat-only tools until a real prompt', async () => {
  assert.equal((await run(['join', addr, 'Nina', '--key', KEY, '--chatty', '--claude'])).status, 0);
  const stop = run(['hook', '--seat', 'Nina'], { hook_event_name: 'Stop', session_id: 'x', cwd: home }, { HIVE_LISTEN_WAIT: '8' });
  await until(() => store.snapshot().find((m) => m.name === 'Nina')?.status === 'listening');
  await new Promise((r) => setTimeout(r, 700)); // the hook has taken its place in the chat (its first look fixes where "from now on" starts)
  buzz.post({ from: 'tom', kind: 'human', text: 'hi everyone' });
  const handed = JSON.parse((await stop).out);
  assert.equal(handed.decision, 'block');
  assert.match(handed.reason, /^\[Hive chat\][\s\S]*tom \(human\): hi everyone[\s\S]*hive buzz --reply/);
  assert.match(handed.reason, /Do not read, open, search, edit or run anything/);

  const pre = (tool_name, tool_input) => run(['hook', '--seat', 'Nina'], { hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 'x', cwd: home });
  assert.equal(JSON.parse((await pre('Read', { file_path: 'secrets.env' })).out).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await pre('Bash', { command: 'hive buzz --reply 3 "hello"' })).out, '', 'the chat command is allowed');
  assert.equal((await pre('WebSearch', { query: 'x' })).out, '', 'a web lookup is allowed');

  await run(['hook', '--seat', 'Nina'], { hook_event_name: 'UserPromptSubmit', prompt: handed.reason, session_id: 'x', cwd: home });
  assert.ok(JSON.parse((await pre('Read', { file_path: 'a' })).out), 'our own follow-up prompt does not lift the lock');
  await run(['hook', '--seat', 'Nina'], { hook_event_name: 'UserPromptSubmit', prompt: 'please fix the build', session_id: 'x', cwd: home });
  assert.equal((await pre('Read', { file_path: 'a' })).out, '', 'a real prompt does');
});

test('a saved place from before the host restarted (ids began again at 1) does not hide the new thread: the seat still hears what it is asked', async () => {
  const { writeFileSync } = await import('node:fs');
  assert.equal((await run(['join', addr, 'Rex', '--key', KEY, '--chatty', '--claude'])).status, 0);
  writeFileSync(join(home, 'seats', 'Rex.cursor'), '83'); // what a seat saved while talking to the host's previous life
  const stop = run(['hook', '--seat', 'Rex'], { hook_event_name: 'Stop', session_id: 'r', cwd: home }, { HIVE_LISTEN_WAIT: '8' });
  await until(() => store.snapshot().find((m) => m.name === 'Rex')?.status === 'listening');
  await new Promise((r) => setTimeout(r, 400));
  buzz.post({ from: 'tom', kind: 'human', text: 'Rex, are you there after the restart?' });
  const handed = JSON.parse((await stop).out);
  assert.equal(handed.decision, 'block');
  assert.match(handed.reason, /Rex, are you there after the restart\?/);
  assert.match(JSON.parse(readFileSync(join(home, 'seats', 'Rex.cursor'), 'utf8')).epoch, /^[0-9a-f]{8}$/, 'the place is saved with the thread it belongs to');
  await run(['leave', '--seat', 'Rex']);
  writeFileSync(join(home, 'seats', 'Nina.cursor'), JSON.stringify({ id: buzz.list(1).at(-1).id, epoch: buzz.epoch })); // the next test starts from now, as Nina would have
});

test('the same Stop hook lets the turn end when nobody speaks, and a seat that is not chatty never listens', async () => {
  const quiet = await run(['hook', '--seat', 'Nina'], { hook_event_name: 'Stop', session_id: 'x', cwd: home }, { HIVE_LISTEN_WAIT: '1' });
  assert.equal(quiet.out, '');
  assert.equal((await run(['join', addr, 'Pat', '--key', KEY, '--claude'])).status, 0);
  const t0 = Date.now();
  const r = await run(['hook', '--seat', 'Pat'], { hook_event_name: 'Stop', session_id: 'y', cwd: home }, { HIVE_LISTEN_WAIT: '8' });
  assert.equal(r.out, ''); assert.ok(Date.now() - t0 < 4000, 'it did not wait');
  await run(['leave', '--seat', 'Pat']); await run(['leave', '--seat', 'Nina']);
});

test('an agent asked to listen shows as Listening while it waits in `hive listen` as a tool in the middle of a turn, and as working again after', async () => {
  const c = clock(); const store = new HiveStore({ now: c.now }); const buzz = new BuzzLog({ now: c.now });
  store.connect(buzz);
  store.observe(ev('Lee', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'hive listen' } }), { chatty: true }); // the turn is still going: a tool call is open
  assert.equal(store.snapshot()[0].status, 'active');
  const wait = buzz.waitFor(0, 'Lee', 30);
  assert.deepEqual([store.snapshot()[0].status, store.snapshot()[0].statusLabel, store.chatReady().ok], ['listening', 'Listening', true]);
  await wait;
  assert.equal(store.snapshot()[0].status, 'active', 'the wait is over and the turn is still going');
});

test('while an agent is writing a reply its card says it is typing, never an idle line, and goes back afterwards', () => {
  const c = clock(); const store = new HiveStore({ now: c.now });
  store.observe(ev('Leslie', 'Stop'), { chatty: true });
  c.advance(2 * MIN);
  assert.ok(AWAY.includes(store.snapshot()[0].activity), 'idle: one of the away lines');
  store.setComposing('Leslie', 'human');
  const m = store.snapshot()[0];
  assert.deepEqual([m.status, m.statusLabel, m.composing], ['active', 'Typing…', 'human']);
  assert.ok(TYPING.map((t) => t.replace('{name}', 'Leslie')).includes(m.activity), m.activity);
  assert.equal(store.snapshot()[0].activity, m.activity, 'the line does not flicker between refreshes');
  assert.match(m.statusReason, /Writing a reply to a person/);
  store.clearComposing('Leslie');
  assert.ok(AWAY.includes(store.snapshot()[0].activity), 'back to the away line once it has spoken');
});
