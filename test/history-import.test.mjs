import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, claudeTurns, codexTurns, collectHistory, copilotTurns, geminiTurns, importSource, qwenTurns } from '../src/history-import.mjs';
import { Ledger, localDay } from '../src/production.mjs';
import { HiveStore } from '../src/hive.mjs';
import { handleHistoryPost } from '../src/hive-http.mjs';

const T0 = Date.UTC(2026, 8, 14, 3, 0, 0); // a fixed moment
const iso = (ms) => new Date(ms).toISOString();
const min = (n) => n * 60_000;
const jl = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n');

// --- Claude Code ---------------------------------------------------------------------------------------------------------------------------------
const cPrompt = (at, text = 'do it', extra = {}) => ({ type: 'user', timestamp: iso(at), cwd: '/work/site', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const cTool = (at, name, input, model = 'claude-sonnet-5-5') => ({ type: 'assistant', timestamp: iso(at), cwd: '/work/site', message: { model, content: [{ type: 'tool_use', name, input }] } });
const cResult = (at) => ({ type: 'user', timestamp: iso(at), cwd: '/work/site', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });

test('claude: a prompt starts a turn, tool results do not, and the turn is scored like a live one (edit = a whole hexagon)', () => {
  const turns = claudeTurns(jl(cPrompt(T0), cTool(T0 + 5000, 'Edit', { file_path: 'a.js' }), cResult(T0 + 6000), cTool(T0 + 9000, 'Read', { file_path: 'b.js' })));
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].project, turns[0].weight, turns[0].day], ['site', 1, localDay(T0)]);
});

test('claude: chat-only turn is a sliver, meta lines and sub-agent chatter are not prompts, sub-agent tool calls count toward the turn', () => {
  const chat = claudeTurns(jl(cPrompt(T0), { type: 'assistant', timestamp: iso(T0 + 3000), message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }] } }));
  assert.equal(chat[0].weight, 0.15);
  const t = claudeTurns(jl(cPrompt(T0), cPrompt(T0 + 1000, 'meta', { isMeta: true }), cPrompt(T0 + 2000, 'side', { isSidechain: true }), { ...cTool(T0 + 3000, 'Edit', { file_path: 'x' }), isSidechain: true }));
  assert.equal(t.length, 1);
  assert.equal(t[0].weight, 1, 'the sub-agent\'s edit made it a real turn');
});

test('claude: a long pause (waiting on the person) is not working time, but real working time grows the score; a big model counts more', () => {
  const waited = claudeTurns(jl(cPrompt(T0), cTool(T0 + 1000, 'Edit', { file_path: 'a' }), cTool(T0 + min(120), 'Edit', { file_path: 'b' })));
  assert.equal(waited[0].weight, 1, 'two hours of waiting between two edits is 1 hexagon, not 5');
  const worked = claudeTurns(jl(cPrompt(T0), ...Array.from({ length: 6 }, (_, i) => cTool(T0 + min(1 + i * 5), 'Edit', { file_path: `f${i}` }))));
  assert.ok(worked[0].weight > 2, `a half-hour of steady work is worth more (${worked[0].weight})`);
  const opus = claudeTurns(jl(cPrompt(T0), cTool(T0 + 1000, 'Edit', { file_path: 'a' }, 'claude-opus-5-5')));
  assert.equal(opus[0].weight, 1.5);
});

test('claude: two prompts are two turns, in time order even if the file is not', () => {
  const turns = claudeTurns(jl(cTool(T0 + min(11), 'Edit', { file_path: 'b' }), cPrompt(T0 + min(10)), cPrompt(T0), cTool(T0 + 1000, 'Edit', { file_path: 'a' })));
  assert.deepEqual(turns.map((t) => t.weight), [1, 1]);
});

// --- Qwen ----------------------------------------------------------------------------------------------------------------------------------------------
test('qwen: a real_user line starts a turn; functionCall parts are its tool calls; system lines are not prompts', () => {
  const q = jl(
    { type: 'user', provenance: 'real_user', timestamp: iso(T0), cwd: '/work/rebarui', message: { parts: [{ text: 'fix it' }] } },
    { type: 'system', provenance: 'system', subtype: 'attribution_snapshot', timestamp: iso(T0 + 100) },
    { type: 'assistant', timestamp: iso(T0 + 4000), model: 'qwen3.8-flash', message: { parts: [{ functionCall: { name: 'write_file', args: { file_path: 'a.js' } } }] } },
    { type: 'tool_result', timestamp: iso(T0 + 5000) },
  );
  const turns = qwenTurns(q);
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].project, turns[0].weight], ['rebarui', 0.6], 'an edit on a small (flash) model');
});

// --- Copilot -------------------------------------------------------------------------------------------------------------------------------------------
const cpTool = (id, toolId) => ({ kind: 'toolInvocationSerialized', toolId, toolCallId: id, isComplete: true, invocationMessage: { value: 'x', uris: { 'file:///p/a.ts#1-1': { path: '/p/a.ts' } } } });
test('copilot: requests from the opening state and appended later, each with its own time, model, tool calls and recorded length', () => {
  const log = jl(
    { kind: 0, v: { requests: [{ timestamp: T0, modelId: 'copilot/gpt-4.1', response: [cpTool('c1', 'copilot_replaceString')], result: { timings: { totalElapsed: 30_000 } } }] } },
    { kind: 2, k: ['requests'], v: [{ timestamp: T0 + min(5), modelId: 'copilot/claude-haiku-4.5', response: [] }] },
    { kind: 2, k: ['requests', 1, 'response'], v: [cpTool('c2', 'copilot_readFile')] },
    { kind: 1, k: ['requests', 1, 'result'], v: { timings: { totalElapsed: 8000 } } },
  );
  const turns = copilotTurns(log);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].weight, 1, 'an edit on a standard model');
  assert.equal(turns[1].weight, 0.21, 'one read on a small model: 0.35 x 0.6');
  assert.equal(turns[1].day, localDay(T0 + min(5)));
});

test('copilot: a request with no timestamp is skipped, and a tool call repeated across rewrites is counted once', () => {
  const log = jl({ kind: 0, v: { requests: [{ modelId: 'x' }, { timestamp: T0, response: [cpTool('c1', 'copilot_readFile'), cpTool('c1', 'copilot_readFile')] }] } });
  const turns = copilotTurns(log);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].weight, 0.35);
});

// --- Gemini and Codex (formats from their docs, not run on a real install) -------------------------------------------------------------------------
test('gemini: a session file of messages: user starts a turn, gemini messages carry the tool calls', () => {
  const s = JSON.stringify({ messages: [{ type: 'user', timestamp: iso(T0), content: 'go' }, { type: 'gemini', timestamp: iso(T0 + 3000), model: 'gemini-2.5-pro', toolCalls: [{ name: 'replace', args: { file_path: 'a' } }] }] });
  const turns = geminiTurns(s);
  assert.deepEqual(turns.map((t) => t.weight), [1.5], 'an edit on a large model');
  assert.deepEqual(geminiTurns('not json'), []);
});

test('codex: a rollout file: user_message starts a turn, shell and apply_patch calls are its work, the model comes from turn_context', () => {
  const r = jl(
    { timestamp: iso(T0 - 1000), type: 'session_meta', payload: { cwd: '/work/api' } },
    { timestamp: iso(T0), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { timestamp: iso(T0 + 100), type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
    { timestamp: iso(T0 + 2000), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) } },
    { timestamp: iso(T0 + 4000), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', arguments: '{}' } },
  );
  const turns = codexTurns(r);
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].project, turns[0].weight], ['api', 1.5]);
});

// --- finding files ---------------------------------------------------------------------------------------------------------------------------------------
test('collectHistory reads every file of a tool under its folder, sums per day and per project, and can start from a date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  mkdirSync(join(dir, 'proj-a')); mkdirSync(join(dir, 'proj-b'));
  writeFileSync(join(dir, 'proj-a', 's1.jsonl'), jl(cPrompt(T0), cTool(T0 + 1000, 'Edit', { file_path: 'a' })));
  writeFileSync(join(dir, 'proj-b', 's2.jsonl'), jl(cPrompt(T0 + min(30)), cTool(T0 + min(30) + 1000, 'Edit', { file_path: 'b' }), cPrompt(T0 + 5 * 86_400_000), cTool(T0 + 5 * 86_400_000 + 1000, 'Edit', { file_path: 'c' })));
  writeFileSync(join(dir, 'proj-b', 'notes.txt'), 'ignored');
  const h = collectHistory('claude', { dir });
  assert.deepEqual([h.files, h.turns, Object.keys(h.days).length, h.projects.site], [2, 3, 2, 3]);
  assert.equal(h.days[localDay(T0)], 2);
  const later = collectHistory('claude', { dir, since: localDay(T0 + 3 * 86_400_000) });
  assert.deepEqual([later.turns, Object.keys(later.days).length], [1, 1]);
  assert.deepEqual(collectHistory('claude', { dir: join(dir, 'nope') }).files, 0);
  assert.deepEqual(Object.keys(ADAPTERS), ['claude', 'qwen', 'copilot', 'gemini', 'codex']);
  assert.match(importSource('qwen'), /^qwen-history@/);
});

// --- the host side -------------------------------------------------------------------------------------------------------------------------------------
const file = () => join(mkdtempSync(join(tmpdir(), 'hist-ledger-')), 'production.json');
const day = (ms) => localDay(ms);

test('imported history is per source and replaced, never added to, when a source is sent again; and it survives a restart', () => {
  const f = file(); const l = new Ledger({ file: f });
  assert.equal(l.setHistory('claude-history@m', { '2026-09-01': 2, '2026-09-02': 3 }), 2);
  assert.equal(l.setHistory('claude-history@m', { '2026-09-01': 5 }), 1, 'the second send replaces the first');
  l.setHistory('qwen-history@m', { '2026-09-01': 1 });
  assert.deepEqual(l.daily(), [{ date: '2026-09-01', value: 6 }], 'sources add up on a day');
  assert.deepEqual(new Ledger({ file: f }).daily(), l.daily());
});

test('imported estimates stop where live dating began, and bad days are dropped', () => {
  const l = new Ledger({ file: file(), now: () => new Date(2026, 8, 10, 12).getTime() });
  l.add('site#0', 4, 'Ann'); // live production on 2026-09-10
  l.setHistory('claude-history@m', { '2026-09-09': 2, '2026-09-10': 99, '2026-09-11': 99, 'garbage': 5, '2026-09-08': -1, '2026-09-07': 'x' });
  assert.deepEqual(l.daily(), [{ date: '2026-09-09', value: 2 }, { date: '2026-09-10', value: 4 }]);
});

test('POST /api/history needs the key, a good source and days; and stores them in the ledger', async () => {
  const ledger = new Ledger({ file: file() }); const store = new HiveStore({ ledger });
  const server = http.createServer((req, res) => { if (!handleHistoryPost(req, res, store, 'k')) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (body, key = 'k') => fetch(`http://127.0.0.1:${server.address().port}/api/history`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ source: 'a@b', days: {} }, 'nope')).status, 401);
    assert.equal((await post({ source: 'bad source!', days: {} })).status, 400);
    assert.equal((await post({ source: 'a@b', days: [1] })).status, 400);
    const ok = await post({ source: 'claude-history@m', days: { '2026-01-02': 1.5 } });
    assert.deepEqual([ok.status, await ok.json()], [200, { days: 1 }]);
    assert.deepEqual(ledger.daily(), [{ date: '2026-01-02', value: 1.5 }]);
    const big = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 1]));
    assert.equal((await post({ source: 'claude-history@m', days: big })).status, 200, 'a year of days fits (the body limit is bigger here than for a heartbeat)');
    assert.equal(new HiveStore().ledger, null);
  } finally { server.close(); }
  void day;
});
