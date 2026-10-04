// The chat loop, generic across agent tools. A chatty agent cannot hear the chat while it is idle, so its end-of-turn hook does the
// listening for it: when the turn ends the hook reports idle, waits in `hive listen` for a line the Hive invited it to answer, and if
// one comes, refuses to let the turn end and hands the line over as the next instruction. The agent answers, the turn ends again, the
// hook listens again. No agent ever has to remember to loop. If nothing comes the turn simply ends and the card goes idle.
//
// While such a chat turn runs, a lock denies every tool except a web lookup and the `hive` chat commands, so a chat answer comes from
// what the agent already knows or from the web, never from reading or editing the project. The lock lifts when a real prompt arrives.
//
// How each tool is told "keep going" and "deny that tool" differs; the shapes below follow each tool's documented hook format.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pidFile } from './seat.mjs';
import { listenBuzz, readBuzz } from './transport.mjs';

export const CHAT_MARKER = '[Hive chat]';
export const LISTEN_WAIT_SEC = 50;     // under Claude Code's default 60s hook timeout, so even hooks installed without our longer timeout can finish; the Hive's listening window (listenMs) is a little longer
export const MAX_CHAT_TURNS = 12;      // chat continuations in a row before the hook stops waking the agent (a runaway guard)

const STOP = new Set(['Stop', 'AfterAgent', 'stop']);
const PROMPT = new Set(['UserPromptSubmit', 'BeforeAgent', 'beforeSubmitPrompt']);
const TOOL = new Set(['PreToolUse', 'BeforeTool', 'beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution']);
export const isStop = (p) => STOP.has(p?.hook_event_name);
export const isPrompt = (p) => PROMPT.has(p?.hook_event_name);
/** Text for the agent to read now, in the shape each tool takes it. Null where the event cannot carry any. */
export function noticeOutput(payload, text) {
  const msg = `[Hive] ${text}`;
  if (isStop(payload)) return continuation(payload, msg);
  const ev = payload.hook_event_name;
  if (['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'AfterTool', 'BeforeAgent'].includes(ev)) return JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: msg } });
  return null;
}

export const isToolStart = (p) => TOOL.has(p?.hook_event_name);

/** How to tell the tool to carry on instead of ending its turn. */
export function continuation(payload, text) {
  switch (payload.hook_event_name) {
    case 'AfterAgent': return JSON.stringify({ decision: 'deny', reason: text });     // Gemini CLI: reject the turn's end and retry with this
    case 'stop': return JSON.stringify({ followup_message: text });                   // Cursor: auto-submits this as the next message
    default: return JSON.stringify({ decision: 'block', reason: text });              // Claude Code, Qwen Code, Codex
  }
}

/** How to deny a tool call. Returns null where the tool offers no way to (Cursor's after* hooks). */
export function denial(payload, reason) {
  switch (payload.hook_event_name) {
    case 'BeforeTool': return JSON.stringify({ decision: 'deny', reason });
    case 'beforeShellExecution': case 'beforeReadFile': case 'beforeMCPExecution': return JSON.stringify({ continue: true, permission: 'deny', user_message: reason, agent_message: reason });
    case 'PreToolUse': return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    default: return null;
  }
}

const WEB = new Set(['WebSearch', 'WebFetch', 'google_web_search', 'web_fetch']);
const HIVE_CMD = /^\s*(?:hive|office|node\s+\S*office\.mjs)\s+(?:buzz|listen|say|idle|respond)\b/;
/** A chat turn may look something up on the web and use the hive's chat commands. Nothing else. */
export function allowedInChat(payload) {
  const name = payload.tool_name;
  if (WEB.has(name)) return true;
  const cmd = payload.hook_event_name === 'beforeShellExecution' ? payload.command : payload.tool_input?.command;
  if (typeof cmd !== 'string' || !HIVE_CMD.test(cmd) || /`|\$[({]/.test(cmd)) return false; // no substitution, even inside quotes
  return !/[;&|<>\n]/.test(cmd.replace(/"[^"]*"|'[^']*'/g, '')); // and no chaining a second command on after it
}

const lockFile = (seat) => pidFile(seat.name).replace(/\.watch\.pid$/, '.chatturn');
const cursorFile = (seat) => pidFile(seat.name).replace(/\.watch\.pid$/, '.cursor');
const readLock = (seat) => { try { return JSON.parse(readFileSync(lockFile(seat), 'utf8')); } catch { return null; } };
export const chatLocked = (seat) => readLock(seat) !== null;
export const clearChatLock = (seat) => rmSync(lockFile(seat), { force: true });

/** The id of the last line this seat has been handed, so a line is never delivered twice. First time: only what is said from now on. */
export async function readCursor(seat) {
  const n = Number(existsSync(cursorFile(seat)) ? readFileSync(cursorFile(seat), 'utf8') : NaN);
  if (Number.isFinite(n)) return n;
  const r = await readBuzz(seat, 1);
  return r.ok && r.messages.length ? r.messages[r.messages.length - 1].id : 0;
}
export const writeCursor = (seat, id) => writeFileSync(cursorFile(seat), String(id));

// A manual `hive listen` loop (an agent asked to sit in the chat) must not run for ever: after a few quiet listens in a row the Hive tells it
// to stop and go back to what it was doing. (The end-of-turn hook already ends its own wait when nobody speaks.)
export const QUIET_LISTENS_BEFORE_RESUME = 2;
const quietFile = (seat) => pidFile(seat.name).replace(/\.watch\.pid$/, '.quiet');

/** Record one listen that returned (`quiet`: nothing was said). -> { resume, minutes }: resume is true once it has been quiet long enough to send the agent back to work. */
export function noteListen(seat, quiet, waitSec = LISTEN_WAIT_SEC) {
  if (!quiet) { rmSync(quietFile(seat), { force: true }); return { resume: false, minutes: 0 }; }
  let n = 0;
  try { n = Number(readFileSync(quietFile(seat), 'utf8')) || 0; } catch { /* first quiet one */ }
  n += 1;
  if (n >= QUIET_LISTENS_BEFORE_RESUME) { rmSync(quietFile(seat), { force: true }); return { resume: true, minutes: Math.max(1, Math.round((n * waitSec) / 60)) }; }
  writeFileSync(quietFile(seat), String(n));
  return { resume: false, minutes: 0 };
}

export const RESUME_MESSAGE = (minutes) => `Nobody has spoken in Hive Chat for about ${minutes} minute${minutes === 1 ? '' : 's'}. Stop listening now and go back to what you were doing before you were asked to listen. Do not run \`hive listen\` again unless someone asks you to.`;

export const formatLine = (m) => `#${m.id} ${m.kind === 'system' ? `[${m.from}]` : m.kind === 'human' ? (m.from === 'Human' ? 'Human' : `${m.from} (human)`) : m.from}${m.quote ? ` (replying to #${m.quote.id})` : ''}: ${m.text}`;

export function chatPrompt(lines) {
  return `${CHAT_MARKER} You were asked in the hive's chat:\n${lines.map(formatLine).join('\n')}\n\n`
    + 'Answer in ONE short, friendly line (under 160 characters) with: hive buzz --reply <id> "<your line>". '
    + 'Answer only from what you already know or remember, or from a quick web search. Do not read, open, search, edit or run anything in the project: file and shell tools are blocked for this reply. '
    + 'If you have nothing real to add, say nothing. Then finish your turn.';
}

/**
 * Before a hook is reported. A real prompt lifts the chat lock; while it is on, a tool the chat may not use is denied.
 * Returns the text to print on stdout (a denial), or null to carry on as normal.
 */
export function gate(seat, payload) {
  if (isPrompt(payload)) {
    if (!String(payload.prompt ?? '').startsWith(CHAT_MARKER)) clearChatLock(seat); // our own follow-up prompt must not lift the lock
    return null;
  }
  if (isToolStart(payload) && chatLocked(seat) && !allowedInChat(payload)) {
    return denial(payload, 'This is a reply in the hive chat: answer from what you know or a quick web search, without touching the project. Use only hive buzz, or a web lookup.');
  }
  return null;
}

/**
 * At the end of a turn, for a chatty seat: wait for a line to answer. Returns the text to print on stdout to keep the agent going,
 * or null to let the turn end. The caller has already reported the seat idle (that is what shows it as "Listening" meanwhile).
 */
export async function listenAtStop(seat, payload, { wait = LISTEN_WAIT() } = {}) {
  if (!seat.chatty || wait <= 0) return null;
  const lock = readLock(seat);
  if ((lock?.turns ?? 0) >= MAX_CHAT_TURNS) { clearChatLock(seat); return null; }
  const after = await readCursor(seat);
  const r = await listenBuzz(seat, after, wait);
  if (!r.ok || !r.messages.length) { clearChatLock(seat); return null; }
  writeCursor(seat, r.messages[r.messages.length - 1].id);
  writeFileSync(lockFile(seat), JSON.stringify({ at: Date.now(), turns: (lock?.turns ?? 0) + 1 }));
  return continuation(payload, chatPrompt(r.messages));
}

function LISTEN_WAIT() {
  const n = Number(process.env.HIVE_LISTEN_WAIT);
  return Number.isFinite(n) && process.env.HIVE_LISTEN_WAIT !== undefined ? Math.min(n, 110) : LISTEN_WAIT_SEC;
}
