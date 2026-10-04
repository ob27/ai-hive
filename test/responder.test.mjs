import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuzzLog, watchHive } from '../src/buzz.mjs';
import { HiveStore } from '../src/hive.mjs';
import { anthropicComplete, buildUserPrompt, cleanReply, createResponder } from '../src/responder.mjs';

const ev = (n, e, extra = {}) => ({ session_id: `s-${n}`, hook_event_name: e, cwd: `/office/${n}`, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 20));

function room({ rand = () => 0.5, ...cfg } = {}) {
  const store = new HiveStore(); const buzz = new BuzzLog({ perHour: 100 });
  store.observe(ev('Barry', 'Stop'), { project: 'Dm-Archive', chatty: true });
  store.observe(ev('Alice', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'reading drawings' } }), { project: 'Reports', chatty: true });
  store.observe(ev('Quiet', 'Stop'), { chatty: false });   // not chatty: must never be voiced
  store.observe(ev('Ghosty', 'Stop'), { chatty: true });
  store.agents.get('s-Ghosty').lastAt -= 40 * 60_000;      // a ghost: not voiced either
  const calls = [];
  const complete = async (req) => { calls.push(req); return { text: `reply ${calls.length}`, outputTokens: 10 }; };
  const r = createResponder({ store, buzz, complete, rand, wait: async () => {}, ...cfg });
  return { store, buzz, calls, r };
}
const lines = (b) => b.list(50).map((m) => `${m.from}${m.via ? '*' : ''}: ${m.text}`);

test('a person speaks: up to two chatty, non-ghost agents answer, marked as voiced by the host', async () => {
  const { buzz, calls } = room();
  buzz.post({ from: 'Tom', kind: 'human', text: 'how is everyone doing?' });
  await settle();
  assert.equal(calls.length, 2);
  const replies = buzz.list(50).filter((m) => m.via === 'host');
  assert.equal(replies.length, 2);
  assert.ok(replies.every((m) => m.kind === 'agent' && ['Barry', 'Alice'].includes(m.from)), 'only chatty, non-ghost agents speak');
  assert.notEqual(replies[0].from, replies[1].from);
});

test('the prompt gives the bot its own status, the honesty rules and the recent chat, including real events', async () => {
  const { buzz, calls } = room();
  buzz.post({ from: 'hive', kind: 'system', text: 'DSL Service stopped responding and has likely failed.' });
  buzz.post({ from: 'Tom', kind: 'human', text: 'what happened?' });
  await settle();
  const first = calls[0];
  assert.match(first.system, /Your status right now:/);
  assert.match(first.system, /Never say you fixed, restarted or retried anything/);
  assert.match(first.user, /\[hive\]: DSL Service stopped responding/);
  assert.match(first.user, /Tom \(human\): what happened\?/);
  assert.match(calls[1].user, /reply 1/, 'the second bot sees the first bot\'s reply');
});

test('the bots never answer the bots, so it cannot run on by itself', async () => {
  const { buzz, calls } = room();
  buzz.post({ from: 'Tom', kind: 'human', text: 'hello' });
  await settle(); await settle();
  assert.equal(calls.length, 2);
});

test('a real failure gets one bot reaction some of the time, and a recovery too; chance decides', async () => {
  const lucky = room({ rand: () => 0.1 });
  lucky.buzz.post({ from: 'hive', kind: 'system', text: 'DSL Service stopped responding and has likely failed.' });
  await settle();
  assert.equal(lucky.calls.length, 1);
  const unlucky = room({ rand: () => 0.9 });
  unlucky.buzz.post({ from: 'hive', kind: 'system', text: 'DSL Service stopped responding and has likely failed.' });
  await settle();
  assert.equal(unlucky.calls.length, 0);
  lucky.buzz.post({ from: 'hive', kind: 'system', text: 'Barry joined the hive.' }); // not an event worth a comment
  await settle();
  assert.equal(lucky.calls.length, 1);
});

test('the hourly reply budget stops the bots and says so once', async () => {
  const { buzz, calls } = room({ repliesPerHour: 2 });
  buzz.post({ from: 'Tom', kind: 'human', text: 'one' });
  await settle();
  buzz.post({ from: 'Tom', kind: 'human', text: 'two' });
  buzz.post({ from: 'Tom', kind: 'human', text: 'three' });
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(buzz.list(50).filter((m) => /resting/.test(m.text)).length, 1);
});

test('the daily token cap also stops them', async () => {
  const { buzz, calls } = room({ dailyOutputTokens: 15 });
  buzz.post({ from: 'Tom', kind: 'human', text: 'hi' });
  await settle();
  assert.equal(calls.length, 2);                       // 10 + 10 tokens crosses 15 after the second
  buzz.post({ from: 'Tom', kind: 'human', text: 'again' });
  await settle();
  assert.equal(calls.length, 2);
});

test('an unreachable model leaves the thread quiet instead of filling it with errors', async () => {
  const store = new HiveStore(); const buzz = new BuzzLog();
  store.observe(ev('Barry', 'Stop'), { chatty: true });
  createResponder({ store, buzz, complete: async () => { throw new Error('offline'); }, wait: async () => {} });
  buzz.post({ from: 'Tom', kind: 'human', text: 'hello' });
  await settle();
  assert.deepEqual(lines(buzz), ['Tom: hello']);
});

test('cleanReply tidies a model reply into one line', () => {
  assert.equal(cleanReply('  "Barry: phew,\n that was hard."  ', 'Barry'), 'phew, that was hard.');
  assert.equal(cleanReply('x'.repeat(400), 'B').length, 280);
  assert.equal(buildUserPrompt({ name: 'B' }, [{ at: 0, from: 'T', kind: 'human', text: 'hi' }]).includes('T (human): hi'), true);
});

test('anthropicComplete calls the Messages API with the key and returns the text and tokens', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'hi there' }], usage: { output_tokens: 4 } }) }; };
  const out = await anthropicComplete({ apiKey: 'sk-test', fetchFn })({ system: 'S', user: 'U', maxTokens: 50 });
  assert.deepEqual(out, { text: 'hi there', outputTokens: 4 });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'sk-test');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual([body.model, body.max_tokens, body.system], ['claude-haiku-4-5-20251001', 50, 'S']);
});

test('a person is capped per client, separately from the agents', () => {
  const b = new BuzzLog({ humanPerHour: 2 });
  assert.ok(b.post({ from: 'Tom', kind: 'human', text: 'a', limitKey: '1.2.3.4' }).ok);
  assert.ok(b.post({ from: 'Tom', kind: 'human', text: 'b', limitKey: '1.2.3.4' }).ok);
  assert.equal(b.post({ from: 'Tom', kind: 'human', text: 'c', limitKey: '1.2.3.4' }).status, 429);
  assert.ok(b.post({ from: 'Tom', kind: 'human', text: 'd', limitKey: '5.6.7.8' }).ok);
});

test('each bot quotes the message it answers: the first the person, the next the bot before it', async () => {
  const { buzz } = room();
  const human = buzz.post({ from: 'Tom', kind: 'human', text: 'how is everyone doing?' }).message;
  await settle();
  const [first, second] = buzz.list(50).filter((m) => m.via === 'host');
  assert.deepEqual([first.quote.id, first.quote.from], [human.id, 'Tom']);
  assert.deepEqual([second.quote.id, second.quote.from], [first.id, first.from]);
});

test('a bot reacting to a real event quotes that event, and its prompt names the message to answer', async () => {
  const { buzz, calls } = room({ rand: () => 0.1 });
  const event = buzz.post({ from: 'hive', kind: 'system', text: 'DSL Service stopped responding and has likely failed.' }).message;
  await settle();
  const reply = buzz.list(50).find((m) => m.via === 'host');
  assert.equal(reply.quote.id, event.id);
  assert.match(calls[0].user, /reply to this message \(it will be shown quoted above your reply\):\n\d\d:\d\d \[hive\]: DSL Service stopped responding/);
});
