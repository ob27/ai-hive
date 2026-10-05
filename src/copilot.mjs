import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { applyAction } from './chirp.mjs';

// VS Code Copilot Chat keeps each chat as an append-only JSONL *patch log* (not an event stream):
//   {kind:0, v:<full state>}                     initial state
//   {kind:1, k:[path…], v}                       set a value at a path
//   {kind:2, k:[path…], v:[items], i?}           write array items at a path
// What matters here (verified against real sessions, VS Code 1.10x):
//   kind 2, k=['requests']                        a new user turn started
//   kind 2, k=['requests', n, 'response']         the response array was (re)written; items include
//                                                 toolInvocationSerialized / thinking / textEditGroup / confirmation
//   kind 1, k=['requests', n, 'result']           the turn finished
// The response array is rewritten in overlapping batches, so tool calls are keyed by toolCallId, never by position.

// Copilot tool ids → [tool name shown on the wall, label shown when the tool has no file]. Anything not listed becomes a
// generic step. Labels never include commands or arguments: the screen is public and commands can hold secrets.
const TOOLS = {
  copilot_readFile: ['Read'], copilot_viewImage: ['Read'], read_page: ['Read'],
  copilot_listDirectory: ['Glob'], copilot_findFiles: ['Glob'],
  copilot_findTextInFiles: ['Grep'], copilot_githubTextSearch: ['Grep'], copilot_getErrors: ['Grep'],
  copilot_createFile: ['Write'], copilot_createDirectory: ['Write'],
  copilot_replaceString: ['Edit'], copilot_multiReplaceString: ['Edit'],
  run_in_terminal: ['Bash', 'running a command'], get_terminal_output: ['Bash', 'reading terminal output'], kill_terminal: ['Bash', 'stopping a command'],
  copilot_fetchWebPage: ['WebFetch'], vscode_fetchWebPage_internal: ['WebFetch'],
  run_playwright_code: ['WebFetch'], click_element: ['WebFetch'], navigate_page: ['WebFetch'], screenshot_page: ['WebFetch'], open_browser_page: ['WebFetch'],
  manage_todo_list: ['Bash', 'updating the todo list'], runSubagent: ['Bash', 'running a sub-agent'],
  copilot_sessionStoreSql: ['Bash', 'checking memory'], copilot_memory: ['Bash', 'checking memory'],
  vscode_askQuestions: ['AskUserQuestion'],
};

/** First file:// path mentioned by a tool item's invocation message, if any. */
function filePathOf(item) {
  const uris = item.invocationMessage?.uris ?? item.pastTenseMessage?.uris ?? {};
  for (const key of Object.keys(uris)) {
    if (!key.startsWith('file://')) continue;
    try { return decodeURIComponent(new URL(key).pathname); } catch { /* next */ }
  }
  return null;
}

export function toolAction(item) {
  const [tool, label] = TOOLS[item.toolId] ?? ['Bash', 'working'];
  const file = filePathOf(item);
  if (['Read', 'Write', 'Edit'].includes(tool)) return { type: 'pre', tool, input: { file_path: file ?? 'a file' } };
  if (tool === 'AskUserQuestion') return { type: 'pre', tool, input: {} };
  return { type: 'pre', tool, input: { command: label ?? tool } };
}

/** One parsed log line → zero or more actions. `state.seen` (a Set) remembers toolCallIds already reported. */
export function actionsFromLine(line, state) {
  if (!line || line.kind === 0) return []; // full state: history, not news
  const k = line.k ?? [];
  if (line.kind === 2 && k.length === 1 && k[0] === 'requests') return [{ type: 'prompt' }];
  if (line.kind === 1 && k.length === 3 && k[0] === 'requests' && k[2] === 'result') return [{ type: 'stop' }];
  if (line.kind === 2 && k.length === 3 && k[0] === 'requests' && k[2] === 'response' && Array.isArray(line.v)) {
    const out = [];
    for (const item of line.v) {
      if (item?.kind === 'toolInvocationSerialized') {
        const id = item.toolCallId ?? `${item.toolId}:${out.length}`;
        if (state.seen.has(id)) continue;
        state.seen.add(id);
        out.push(toolAction(item));
      } else if (item?.kind === 'textEditGroup') {
        out.push({ type: 'pre', tool: 'Edit', input: { file_path: item.uri?.path ?? 'a file' } });
      } else if (item?.kind === 'confirmation') {
        out.push({ type: 'pre', tool: 'AskUserQuestion', input: {} });
      } else if (item?.kind === 'thinking') {
        out.push({ type: 'pre', tool: 'Bash', input: { command: 'thinking…' } });
      }
    }
    return out;
  }
  return [];
}

/** Several lines arrive per poll, often a whole turn at once: say the turn started, then the latest thing. */
export function coalesce(actions) {
  const out = [];
  const prompt = actions.find((a) => a.type === 'prompt');
  if (prompt) out.push(prompt);
  const last = [...actions].reverse().find((a) => a.type !== 'prompt');
  if (last) out.push(last);
  return out;
}

// ---- locating and tailing the files ----------------------------------------------------------

export function userDataDirs(env = process.env, platform = process.platform) {
  // Escape hatch for portable/custom installs (and tests): a delimiter-separated list of VS Code `User` dirs.
  if (env.OFFICE_VSCODE_USER_DIR) return env.OFFICE_VSCODE_USER_DIR.split(delimiter).filter(existsSync);
  const flavours = ['Code', 'Code - Insiders', 'VSCodium'];
  const base = platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return flavours.map((f) => join(base, f, 'User')).filter(existsSync);
}

function chatFiles(userDirs) {
  const files = [];
  for (const u of userDirs) {
    const empty = join(u, 'globalStorage', 'emptyWindowChatSessions');
    const ws = join(u, 'workspaceStorage');
    try { for (const f of readdirSync(empty)) if (f.endsWith('.jsonl')) files.push(join(empty, f)); } catch { /* none */ }
    try {
      for (const d of readdirSync(ws)) {
        const dir = join(ws, d, 'chatSessions');
        try { for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(join(dir, f)); } catch { /* none */ }
      }
    } catch { /* none */ }
  }
  return files;
}

/** Reads bytes [from, to) of a file as a Buffer. Chat logs reach 100 MB+, so never read a whole file. */
function readRange(file, from, to) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf;
  } finally { closeSync(fd); }
}

/** Polls every Copilot Chat log and reports new activity on a seat. Starts at "now": history is ignored. */
export function watchCopilot(seat, { user = 'you', pollMs = 1500, userDirs = userDataDirs(), log = () => {} } = {}) {
  const files = new Map(); // path → { offset, rest: Buffer, state }
  let lastScan = 0;
  const track = (file, fromStart) => {
    try { files.set(file, { offset: fromStart ? 0 : statSync(file).size, rest: Buffer.alloc(0), state: { seen: new Set() } }); } catch { /* gone */ }
  };
  for (const f of chatFiles(userDirs)) track(f, false);

  const tick = async () => {
    if (Date.now() - lastScan > 10_000) {
      lastScan = Date.now();
      for (const f of chatFiles(userDirs)) if (!files.has(f)) track(f, true); // a chat opened after we started
    }
    const actions = [];
    for (const [file, st] of files) {
      let size;
      try { size = statSync(file).size; } catch { files.delete(file); continue; }
      if (size < st.offset) { st.offset = size; st.rest = Buffer.alloc(0); continue; } // rewritten/compacted
      if (size === st.offset) continue;
      const buf = Buffer.concat([st.rest, readRange(file, st.offset, size)]);
      st.offset = size;
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
        const text = buf.subarray(start, nl).toString('utf8');
        start = nl + 1;
        if (!text) continue;
        try { actions.push(...actionsFromLine(JSON.parse(text), st.state)); } catch { /* partial or foreign line */ }
      }
      st.rest = buf.subarray(start);
    }
    for (const a of coalesce(actions)) { log(a); await applyAction(seat, a, user); }
  };

  const timer = setInterval(() => tick().catch(() => {}), pollMs);
  return { stop: () => clearInterval(timer), tick, files };
}
