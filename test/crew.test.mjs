import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiveStore } from '../src/hive.mjs';
import { BuzzLog } from '../src/buzz.mjs';
import { createCrew } from '../src/crew.mjs';
import { formatLine, continuation } from '../src/listenloop.mjs';
import { machineOf } from '../src/ingest.mjs';

const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/o/${name}`, tool_name: 'Bash', tool_input: { command: 'work' } });
function hive(c, spec) { // spec: name -> { project, addr, chatty }
  const store = new HiveStore({ now: c.now });
  const buzz = new BuzzLog({ now: c.now });
  const crew = createCrew({ store, buzz, now: c.now, rand: () => 0 });
  const seat = (name, hook, extra = {}) => store.observe(ev(name, hook), { chatty: true, project: 'Site', addr: 'host', ...spec[name], ...extra });
  return { store, buzz, crew, seat, notice: (name) => store.takeNotice(`s-${name}`) };
}

test('two agents working on one project are told about each other once', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {} });
  h.seat('Ann', 'PreToolUse');
  assert.equal(h.notice('Ann'), null, 'alone: nothing to say');
  h.seat('Bo', 'PreToolUse');
  assert.match(h.notice('Ann') ?? '', /Bo is working on this project/);
  assert.match(h.notice('Bo') ?? '', /Ann is working on this project/);
  h.seat('Bo', 'PostToolUse');
  assert.equal(h.notice('Bo'), null, 'not again');
});

test('the one who finishes first is asked for a note; the last is handed it', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {} });
  h.seat('Ann', 'PreToolUse'); h.seat('Bo', 'PreToolUse'); h.notice('Ann'); h.notice('Bo');
  h.seat('Ann', 'Stop');
  assert.match(h.notice('Ann'), /hive handoff .* --seat Ann/);
  assert.deepEqual(h.crew.addNote('Ann', 'added the pile schedule page; asked to commit and push'), { ok: true });
  assert.match(h.buzz.list()[0].text, /Ann left a handoff note/);
  assert.equal(h.buzz.list()[0].invited, undefined, 'a note wakes nobody');
  h.seat('Ann', 'Stop');
  assert.equal(h.notice('Ann'), null, 'asked once, and it has left its note');
  h.seat('Bo', 'Stop');
  const n = h.notice('Bo');
  assert.match(n, /last one working on Site/); assert.match(n, /Ann: added the pile schedule page/); assert.match(n, /commit and push/);
});

test('only chatty agents with a project can leave a note', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Dan: { chatty: false }, Eve: { project: undefined } });
  h.seat('Ann', 'PreToolUse'); h.seat('Dan', 'PreToolUse'); h.seat('Eve', 'PreToolUse', { project: undefined });
  assert.equal(h.crew.addNote('Dan', 'x').status, 403);
  assert.equal(h.crew.addNote('Eve', 'x').status, 400);
  assert.equal(h.crew.addNote('Ann', '').status, 400);
  assert.equal(h.crew.addNote('Nobody', 'x').status, 404);
});

test('a note nobody picks up goes to a free agent on the same machine, never one on another machine', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {}, Cy: { project: 'Other' }, Di: { project: 'Other', addr: '10.0.0.9' } });
  h.seat('Ann', 'PreToolUse'); h.seat('Bo', 'PreToolUse');
  h.seat('Bo', 'Stop'); h.seat('Ann', 'Stop'); // both resting when the note lands
  h.crew.addNote('Ann', 'wired the form');
  h.seat('Cy', 'Stop'); h.seat('Di', 'Stop');
  const open = (name) => { h.buzz.waiting.set(name, 1); }; // an open `hive listen`: what makes an agent Listening
  h.store.connect(h.buzz); open('Cy'); open('Di');
  c.advance(31_000); h.crew.sweep();
  const task = h.buzz.list().find((m) => m.task);
  assert.ok(task, 'a task went out');
  assert.deepEqual(task.invited, ['Cy']);
  assert.match(formatLine(task), /wired the form/);
  assert.match(continuation({ hook_event_name: 'Stop' }, 'x'), /block/);
});

test('nobody to take it: the idle agents decline in a canned line and a copyable announcement is posted', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {} });
  h.seat('Ann', 'PreToolUse'); h.seat('Bo', 'PreToolUse');
  h.seat('Bo', 'Stop'); h.seat('Ann', 'Stop');
  c.advance(70_000); // they have wandered off: nobody is in the chat
  h.crew.addNote('Ann', 'wired the form; asked to push');
  c.advance(31_000); h.crew.sweep();
  const lines = h.buzz.list();
  const decline = lines.find((m) => m.via === 'host');
  assert.ok(decline && decline.kind === 'agent' && decline.quote, 'host-voiced reply under the note');
  const alert = lines.find((m) => m.handoffAlert);
  assert.match(alert.handoffAlert.copy, /Ann: wired the form; asked to push/);
  assert.equal(h.crew.notes.size, 0);
  h.crew.sweep(); assert.equal(h.buzz.list().filter((m) => m.handoffAlert).length, 1, 'once');
});

test('a note given to the last agent but ignored (it never started working) is not lost', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {} });
  h.seat('Ann', 'PreToolUse'); h.seat('Bo', 'PreToolUse');
  h.seat('Ann', 'Stop'); h.crew.addNote('Ann', 'done page');
  h.seat('Bo', 'Stop'); assert.ok(h.notice('Bo'));
  c.advance(95_000); h.crew.sweep(); // Bo never woke
  c.advance(31_000); h.crew.sweep();
  assert.ok(h.buzz.list().some((m) => m.handoffAlert));
});

test('a note taken up (the agent starts working) is resolved', () => {
  const c = clock(); const h = hive(c, { Ann: {}, Bo: {} });
  h.seat('Ann', 'PreToolUse'); h.seat('Bo', 'PreToolUse');
  h.seat('Ann', 'Stop'); h.crew.addNote('Ann', 'done page');
  h.seat('Bo', 'Stop'); h.notice('Bo');
  c.advance(2_000); h.seat('Bo', 'PreToolUse');
  assert.equal(h.crew.notes.size, 0);
  c.advance(200_000); h.crew.sweep();
  assert.equal(h.buzz.list().filter((m) => m.handoffAlert).length, 0);
});

test('machineOf: loopback is the host; others keep their address', () => {
  assert.equal(machineOf('::ffff:127.0.0.1'), 'host');
  assert.equal(machineOf('::1'), 'host');
  assert.equal(machineOf('203.0.113.7'), '203.0.113.7');
});
