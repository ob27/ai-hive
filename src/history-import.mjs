// `hive import-history`: production the Hive never dated. The ledger only ever kept lifetime totals, so the heatmap starts empty. Most agent tools keep a
// local record of every session with a timestamp on each step, so the past can be re-scored with the same rules as live turns (production-score.mjs) and
// sent to the host as per-day estimates. Re-running replaces that tool's earlier import on this machine: it never double counts.
//
// One adapter per tool. What each reads, and how far it has been checked:
//   claude   ~/.claude/projects/*/*.jsonl                       Claude Code (CLI and the VS Code extension)       checked against real transcripts
//   qwen     ~/.qwen/projects/*/chats/*.jsonl                   Qwen Code                                         checked against real transcripts
//   copilot  <VS Code User dir>/workspaceStorage/*/chatSessions VS Code Copilot Chat (any model it is set to)     checked against real chat logs
//   gemini   ~/.gemini/tmp/*/chats/session-*.json               Gemini CLI                                        written from its documented session format, not run on one
//   codex    ~/.codex/sessions/**/rollout-*.jsonl               Codex CLI                                         written from its documented rollout format, not run on one
// Not possible: Cursor (its history is inside a SQLite database), and browser chat apps (nothing on this machine).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { actionsFromLine, toolAction, userDataDirs } from './copilot.mjs';
import { toolClass, turnWeight } from './production-score.mjs';
import { localDay } from './production.mjs';

const MAX_GAP = 10 * 60_000; // a pause longer than this is the person (or a permission prompt) keeping the turn waiting, not the agent working
const host = () => hostname().replace(/\.local$/, '');
export const importSource = (tool) => `${tool}-history@${host()}`;

/** Collects one turn's facts as events arrive in time order; `close()` scores it. */
function turnBuilder(out) {
  let cur = null;
  const close = () => {
    if (!cur) return;
    const model = [...cur.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? cur.model;
    const active = cur.elapsed ?? cur.active;
    out.push({ day: localDay(cur.start), at: cur.start, project: cur.project, weight: turnWeight({ calls: cur.calls, startAt: 0, endAt: active, model }) });
    cur = null;
  };
  return {
    start(at, project, model) { close(); cur = { start: at, last: at, active: 0, calls: [], models: new Map(), project: project || 'unknown', model }; },
    /** Something happened at `at` within the turn (advances its working time unless the gap was a wait). */
    tick(at) { if (!cur) return; const gap = at - cur.last; if (gap > 0 && gap <= MAX_GAP) cur.active += gap; if (at > cur.last) cur.last = at; },
    call(cls) { cur?.calls.push(cls); },
    model(m) { if (cur && m) cur.models.set(m, (cur.models.get(m) ?? 0) + 1); },
    elapsed(ms) { if (cur && Number.isFinite(ms) && ms >= 0) cur.elapsed = ms; }, // a tool that records how long the turn took says so exactly
    open: () => cur !== null,
    close,
  };
}

const lines = (text) => String(text).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ts = (v) => (typeof v === 'number' ? v : Date.parse(v));
const proj = (cwd) => basename(String(cwd ?? '')) || 'unknown';

// --- Claude Code ------------------------------------------------------------------------------------------------------------------------------------
function claudePrompt(j) {
  if (j.type !== 'user' || j.isMeta || j.isSidechain) return false;
  const c = j.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b) => b?.type === 'text' && String(b.text ?? '').trim()) && !c.some((b) => b?.type === 'tool_result');
}
export function claudeTurns(text) {
  const out = [], t = turnBuilder(out);
  const events = lines(text).map((j) => ({ j, at: ts(j.timestamp) })).filter((e) => Number.isFinite(e.at) && ['user', 'assistant', 'system'].includes(e.j.type)).sort((a, b) => a.at - b.at);
  for (const { j, at } of events) {
    if (claudePrompt(j)) { t.start(at, proj(j.cwd)); continue; }
    t.tick(at);
    if (j.type === 'assistant') {
      const m = j.message?.model; if (m && m !== '<synthetic>') t.model(m);
      for (const b of Array.isArray(j.message?.content) ? j.message.content : []) if (b?.type === 'tool_use') t.call(toolClass(b.name, b.input));
    }
  }
  t.close();
  return out;
}

// --- Qwen Code (a Gemini CLI fork: parts with text / functionCall) ---------------------------------------------------------------------------------
export function qwenTurns(text) {
  const out = [], t = turnBuilder(out);
  const events = lines(text).map((j) => ({ j, at: ts(j.timestamp) })).filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  for (const { j, at } of events) {
    if (j.type === 'user' && j.provenance !== 'system') { t.start(at, proj(j.cwd)); continue; }
    if (j.type === 'system' && j.subtype !== 'ui_telemetry') continue;
    t.tick(at);
    if (j.type === 'assistant') {
      if (j.model) t.model(j.model);
      for (const p of j.message?.parts ?? []) if (p?.functionCall) t.call(toolClass(p.functionCall.name, p.functionCall.args));
    }
  }
  t.close();
  return out;
}

// --- VS Code Copilot Chat: a patch log of the chat's state (see copilot.mjs); each request has a timestamp, a model and how long it took ---------------
export function copilotTurns(text, project = 'copilot') {
  const out = [], t = turnBuilder(out);
  const reqs = []; // { at, model, calls: Set(toolCallId)->class, elapsed }
  const seen = new Map();
  for (const line of lines(text)) {
    const k = line.k ?? [];
    if (line.kind === 0) { for (const r of line.v?.requests ?? []) reqs.push(copilotRequest(r)); continue; }
    if (line.kind === 2 && k.length === 1 && k[0] === 'requests' && Array.isArray(line.v)) { for (const r of line.v) reqs.push(copilotRequest(r)); continue; }
    if (line.kind === 2 && k.length === 3 && k[0] === 'requests' && k[2] === 'response' && reqs[k[1]]) {
      const st = seen.get(k[1]) ?? { seen: new Set() }; seen.set(k[1], st);
      for (const a of actionsFromLine(line, st)) if (a.type === 'pre') reqs[k[1]].calls.push(toolClass(a.tool, a.input));
      continue;
    }
    if (line.kind === 1 && k.length === 3 && k[0] === 'requests' && k[2] === 'result' && reqs[k[1]]) {
      const ms = line.v?.timings?.totalElapsed; if (Number.isFinite(ms)) reqs[k[1]].elapsed = ms;
    }
  }
  for (const r of reqs) {
    if (!Number.isFinite(r.at)) continue;
    t.start(r.at, project, r.model);
    for (const c of r.calls) t.call(c);
    t.elapsed(r.elapsed ?? (Number.isFinite(r.completedAt) ? r.completedAt - r.at : 0));
    t.close();
  }
  return out;
}
function copilotRequest(r) {
  const calls = [];
  const st = { seen: new Set() };
  for (const item of Array.isArray(r?.response) ? r.response : []) {
    if (item?.kind === 'toolInvocationSerialized' && item.toolCallId && !st.seen.has(item.toolCallId)) { st.seen.add(item.toolCallId); const a = toolAction(item); calls.push(toolClass(a.tool, a.input)); }
  }
  return { at: ts(r?.timestamp), model: String(r?.modelId ?? '').replace(/^copilot\//, ''), calls, elapsed: r?.result?.timings?.totalElapsed, completedAt: r?.modelState?.completedAt };
}

// --- Gemini CLI: one JSON file per session { messages: [{ timestamp, type: 'user' | 'gemini', toolCalls?: [{ name, args }], model? }] } (unverified) --------------
export function geminiTurns(text, project = 'gemini') {
  let session; try { session = JSON.parse(text); } catch { return []; }
  const out = [], t = turnBuilder(out);
  for (const m of Array.isArray(session?.messages) ? session.messages : []) {
    const at = ts(m.timestamp); if (!Number.isFinite(at)) continue;
    if (m.type === 'user') { t.start(at, project); continue; }
    t.tick(at);
    if (m.model) t.model(m.model);
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) t.call(toolClass(c.name, c.args));
  }
  t.close();
  return out;
}

// --- Codex CLI: rollout lines { timestamp, type, payload } (unverified) ----------------------------------------------------------------------------------
export function codexTurns(text) {
  const out = [], t = turnBuilder(out);
  let cwd = '', model;
  for (const j of lines(text)) {
    const at = ts(j.timestamp); if (!Number.isFinite(at)) continue;
    const p = j.payload ?? {};
    if (j.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (j.type === 'turn_context') { if (p.cwd) cwd = p.cwd; if (p.model) model = p.model; }
    if (j.type === 'event_msg' && p.type === 'user_message') { t.start(at, proj(cwd), model); continue; }
    t.tick(at);
    if (j.type === 'response_item' && ['function_call', 'local_shell_call', 'custom_tool_call'].includes(p.type)) {
      let args = {}; try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments ?? {}); } catch { /* not JSON */ }
      const name = p.name === 'apply_patch' ? 'apply_patch' : p.name === 'shell' || p.type === 'local_shell_call' ? 'shell' : p.name;
      t.call(toolClass(name, { command: Array.isArray(args.command) ? args.command.join(' ') : args.command }));
    }
  }
  t.close();
  return out;
}

// --- finding the files -------------------------------------------------------------------------------------------------------------------------------
function walk(dir, match, depth = 4, out = []) {
  let names; try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) walk(p, match, depth - 1, out); } else if (match(p)) out.push(p);
  }
  return out;
}

export const ADAPTERS = {
  claude: { name: 'Claude Code', verified: true, parse: claudeTurns, files: (d = join(homedir(), '.claude', 'projects')) => walk(d, (p) => p.endsWith('.jsonl'), 2) },
  qwen: { name: 'Qwen Code', verified: true, parse: qwenTurns, files: (d = join(homedir(), '.qwen', 'projects')) => walk(d, (p) => p.endsWith('.jsonl') && p.includes(`${'/'}chats${'/'}`), 3) },
  copilot: {
    name: 'VS Code Copilot Chat', verified: true, parse: copilotTurns,
    files: (d) => (d ? [d] : userDataDirs()).flatMap((u) => walk(join(u, 'workspaceStorage'), (p) => p.endsWith('.jsonl') && p.includes('chatSessions'), 3).concat(walk(join(u, 'globalStorage', 'emptyWindowChatSessions'), (p) => p.endsWith('.jsonl'), 1))),
  },
  gemini: { name: 'Gemini CLI', verified: false, parse: geminiTurns, files: (d = join(homedir(), '.gemini', 'tmp')) => walk(d, (p) => /session-.*\.json$/.test(p) || (p.includes(`${'/'}chats${'/'}`) && p.endsWith('.json')), 3) },
  codex: { name: 'Codex CLI', verified: false, parse: codexTurns, files: (d = join(homedir(), '.codex', 'sessions')) => walk(d, (p) => /rollout-.*\.jsonl$/.test(p), 5) },
};

/** Score one tool's history on this machine. -> { tool, name, verified, days: {date: n}, turns, files, projects: {name: n} } */
export function collectHistory(tool, { dir, since } = {}) {
  const a = ADAPTERS[tool];
  const days = {}, projects = {};
  let turns = 0, files = 0;
  for (const f of a.files(dir)) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    files++;
    for (const t of a.parse(text)) {
      if (since && t.day < since) continue;
      days[t.day] = Math.round(((days[t.day] ?? 0) + t.weight) * 100) / 100;
      projects[t.project] = Math.round(((projects[t.project] ?? 0) + t.weight) * 100) / 100;
      turns++;
    }
  }
  return { tool, name: a.name, verified: a.verified, days, turns, files, projects };
}
