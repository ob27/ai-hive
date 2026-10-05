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
import { TASK_PROMPT } from './crew.mjs';

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
export const writeCursor = (seat, id, epoch) => writeFileSync(cursorFile(seat), JSON.stringify({ id, epoch }));
const readCursorFile = (seat) => {
  try {
    const raw = readFileSync(cursorFile(seat), 'utf8').trim();
    if (/^\d+$/.test(raw)) return { id: Number(raw), epoch: undefined }; // an older seat's plain number
    const j = JSON.parse(raw);
    return Number.isFinite(j?.id) ? { id: j.id, epoch: j.epoch } : null;
  } catch { return null; }
};

/**
 * Wait in the chat from where this seat left off. The host keeps the thread in memory, so when it restarts its ids begin again at 1 and a saved
 * place (say #83) would hide every new line for ever: the thread carries an epoch, and a place saved under a different one is dropped. The first
 * time there is no place, and only what is said from now on is wanted.
 * -> { ok, messages, epoch } as listenBuzz.
 */
export async function listenWithCursor(seat, waitSec) {
  const cur = readCursorFile(seat);
  let after = cur?.id;
  if (after === undefined) { const r0 = await readBuzz(seat, 1); after = r0.ok && r0.messages.length ? r0.messages[r0.messages.length - 1].id : 0; if (r0.ok && r0.epoch) writeCursor(seat, after, r0.epoch); }
  let r = await listenBuzz(seat, after, waitSec);
  if (r.ok && r.epoch && cur && cur.epoch !== r.epoch) {
    r = await listenBuzz(seat, 0, waitSec); // the host restarted (or this place predates epochs): the thread it has now, from the top (stale and not-for-you lines are filtered by the host)
    if (r.ok && !r.messages.length) writeCursor(seat, 0, r.epoch);
  }
  return r;
}


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

export const formatLine = (m) => `#${m.id} ${m.kind === 'system' ? `[${m.from}]` : m.kind === 'human' ? (m.from === 'Human' ? 'Human' : `${m.from} (human)`) : m.from}${m.quote ? ` (replying to #${m.quote.id})` : ''}: ${m.text}${m.task ? `\n${TASK_PROMPT(m.task)}` : ''}`;

export function chatPrompt(lines, seatName) {
  const as = seatName ? ` --seat ${seatName}` : '';
  return `${CHAT_MARKER} You were asked in the hive's chat:\n${lines.map(formatLine).join('\n')}\n\n`
    + `Answer in ONE short, friendly line (under 160 characters) by running exactly this in your shell, with <id> the number after # of the line you answer: hive buzz --reply <id> "<your line>"${as}. `
    + (seatName ? `Keep --seat ${seatName}: it is who you are in the hive, and without it the command may speak as a different seat or be refused. It prints nothing when it works. ` : '')
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
  const r = await listenWithCursor(seat, wait);
  if (!r.ok || !r.messages.length) { clearChatLock(seat); return null; }
  writeCursor(seat, r.messages[r.messages.length - 1].id, r.epoch);
  const task = r.messages.find((m) => m.task);
  if (task) { clearChatLock(seat); return continuation(payload, `[Hive] ${TASK_PROMPT(task.task)}`); } // real work for the project (crew.mjs): not a chat reply, so the project is not locked
  writeFileSync(lockFile(seat), JSON.stringify({ at: Date.now(), turns: (lock?.turns ?? 0) + 1 }));
  return continuation(payload, chatPrompt(r.messages, seat.name));
}

function LISTEN_WAIT() {
  const n = Number(process.env.HIVE_LISTEN_WAIT);
  return Number.isFinite(n) && process.env.HIVE_LISTEN_WAIT !== undefined ? Math.min(n, 110) : LISTEN_WAIT_SEC;
}
