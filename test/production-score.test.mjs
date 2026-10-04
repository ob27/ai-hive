import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HiveStore } from '../src/hive.mjs';
import { modelTier, toolClass, turnWeight } from '../src/production-score.mjs';

const MIN = 60_000;
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const ev = (name, hook_event_name, extra = {}) => ({ session_id: `s-${name}`, hook_event_name, cwd: `/office/${name}`, ...extra });
const find = (s, name) => s.snapshot().find((m) => m.name === name);

test('tool calls are classed as code, research, reading, running, or the agent just talking to the Hive', () => {
  assert.equal(toolClass('Edit', { file_path: 'a.js' }), 'code');
  assert.equal(toolClass('write_file', {}), 'code');
  assert.equal(toolClass('WebSearch', {}), 'research');
  assert.equal(toolClass('google_web_search', {}), 'research');
  assert.equal(toolClass('Read', {}), 'read');
  assert.equal(toolClass('Bash', { command: 'npm test' }), 'run');
  assert.equal(toolClass('Bash', { command: 'hive buzz --reply 3 "hi"' }), 'chat', 'the Hive\'s own commands are not work');
  assert.equal(toolClass('Bash', { command: 'responding to tom' }), 'chat');
  assert.equal(toolClass('Mystery', {}), 'other');
});

test('model size: small, standard or large from the name, and Gemini is not "mini"', () => {
  const tier = (n) => modelTier(n);
  for (const n of ['claude-haiku-4-5-20251001', 'gemini-2.5-flash', 'gpt-4o-mini', 'qwen3-8b']) assert.equal(tier(n), 'small', n);
  for (const n of ['claude-opus-5-5', 'claude-fable-5-1', 'gemini-2.5-pro', 'gpt-5', 'llama-3.1-405b', 'qwen-max']) assert.equal(tier(n), 'large', n);
  for (const n of ['claude-sonnet-5-5', 'qwen3.7-plus', 'qwen3-coder-30b', 'Claude', undefined]) assert.equal(tier(n), 'standard', String(n));
});

test('what a turn did sets its base: a chat answer is a sliver, light looking-around a bit more, edits and research a whole cell', () => {
  const w = (calls, extra = {}) => turnWeight({ calls, startAt: 0, endAt: 30_000, ...extra });
  assert.equal(w([]), 0.15);
  assert.equal(w(['chat', 'chat']), 0.15, 'only talking to the Hive');
  assert.equal(w(['read']), 0.35);
  assert.equal(w(['read', 'run', 'read']), 0.45);
  assert.equal(w(['code']), 1);
  assert.equal(w(['research']), 1);
  assert.equal(w(['read', 'read', 'run', 'read']), 1, 'four or more reads and commands is real work');
});

test('a long turn is presumed to be a big piece of work and is worth several cells', () => {
  const w = (minutes) => turnWeight({ calls: ['code'], startAt: 0, endAt: minutes * MIN });
  assert.equal(w(1), 1);
  assert.equal(w(2), 1, 'up to two minutes is the normal turn');
  assert.ok(w(9) > w(2) && w(9) < w(30));
  assert.equal(w(30), 5);
  assert.equal(w(240), 5, 'capped: leaving a turn open all night does not farm production');
});

test('the same turn is worth more from a bigger model: Fable beats Haiku', () => {
  const turn = (model, minutes = 20) => turnWeight({ calls: ['code'], startAt: 0, endAt: minutes * MIN, model });
  assert.ok(turn('claude-haiku-4-5') < turn('claude-sonnet-5-5') && turn('claude-sonnet-5-5') < turn('claude-fable-5-1'));
  assert.equal(turnWeight({ calls: ['read', 'code'], startAt: 0, endAt: MIN, model: 'claude-haiku-4-5' }), 0.6);
  assert.equal(turnWeight({ calls: ['read', 'code'], startAt: 0, endAt: MIN, model: 'claude-opus-5-5' }), 1.5);
  assert.equal(turnWeight({ calls: ['code'], startAt: 0, endAt: 30 * MIN, model: 'claude-fable-5-1' }), 7.5);
  assert.ok(turnWeight({ calls: [], startAt: 0, endAt: 0 }) >= 0.05, 'never nothing');
});

test('the Hive scores a turn from the events it saw: its tools, how long it ran, and the agent\'s model', () => {
  const c = clock(); const s = new HiveStore({ now: c.now });
  const work = (name, model, minutes) => {
    s.observe(ev(name, 'SessionStart', { model }), { chatty: true });
    s.observe(ev(name, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
    s.observe(ev(name, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.js' } }));
    c.advance(minutes * MIN);
    s.observe(ev(name, 'Stop'));
  };
  work('Small', 'claude-haiku-4-5', 1); work('Big', 'claude-fable-5-1', 20);
  assert.equal(find(s, 'Small').turns, 0.6);
  assert.equal(find(s, 'Big').turns, 5.36, 'fable x (1 + 18/7) = 3.5714 x 1.5');
  // a chat turn afterwards (the agent only runs hive commands) is a sliver, and a new turn starts fresh
  s.observe(ev('Small', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'hive buzz --reply 4 "hello"' } }));
  c.advance(5_000);
  s.observe(ev('Small', 'Stop'));
  assert.equal(find(s, 'Small').turns, 0.69, '0.6 + 0.15 x 0.6');
  assert.equal(s.production().total, 6.05);
});
