// Fake agents: one adapter per way of hooking in, each speaking that tool's REAL wire format through the REAL CLI path
// (so a regression in install, hook, event, normalize, transport, ingest, store or screen shows up here).
//
// Every adapter has the same shape, so one scenario can run against all of them:
//   join(hive)            take a seat                      work(text)   a step of work shows as Active
//   idle()                the turn ends                    leave()      stand up
//   name, tool, activity  what to expect on the wall
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, sleep, spawnCli } from './hive.mjs';

class Base {
  constructor(hive, name, { chatty = false, project } = {}) { this.hive = hive; this.name = name; this.chatty = chatty; this.dir = hive.project(project ?? name); this.sid = `${name}-session`; }
  cli(args, opts = {}) { return runCli(this.hive, args, { cwd: this.dir, ...opts }); }
  joinArgs(flag) { return ['join', this.hive.ingest, this.name, '--key', this.hive.key, ...(this.chatty ? ['--chatty'] : []), ...(flag ? [flag] : [])]; }
  async join() { this.hive.tracked.push(this); const r = await this.cli(this.joinArgs(this.flag)); if (r.code !== 0) throw new Error(`${this.tool} join failed: ${r.stdout}${r.stderr}`); return this; }
  async leave() { return this.cli(['leave', '--seat', this.name]); }
}

/** Claude Code (and Codex, whose payloads match): hook events in Claude's shape through `hive hook`. Also sub-agents and the chat-loop Stop. */
export class ClaudeAgent extends Base {
  tool = 'claude'; flag = '--claude'; activity = /ls -la|Reading a\.js|a\.js/;
  hook(event, extra = {}, env = {}) { return this.cli(['hook', '--seat', this.name], { input: JSON.stringify({ session_id: this.sid, cwd: this.dir, hook_event_name: event, ...extra }), env }); }
  async start() { return this.hook('SessionStart'); }
  async prompt(text = 'do the thing') { return this.hook('UserPromptSubmit', { prompt: text }); }
  async work(file = 'a.js') { await this.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }); return this.hook('PostToolUse', { tool_name: 'Read' }); }
  async working(file = 'a.js') { return this.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file } }); } // a tool call left open
  async idle(env = { HIVE_LISTEN_WAIT: '1' }) { return this.hook('Stop', {}, env); }
  async end() { return this.hook('SessionEnd'); }
  subagentStart(id, type = 'Explore') { return this.hook('SubagentStart', { agent_id: id, agent_type: type }); }
  subagentStop(id, type = 'Explore') { return this.hook('SubagentStop', { agent_id: id, agent_type: type }); }
  subagentTool(id, file = 'b.js') { return this.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: file }, agent_id: id, agent_type: 'Explore' }); }
  /** What a chatty agent does with a line it was asked: `hive buzz [--reply <id>] "<line>"`. Resolves { code, stdout, stderr }. */
  buzz(text, replyTo) { return this.cli(['buzz', ...(replyTo ? ['--reply', String(replyTo)] : []), text, '--seat', this.name]); }
  read() { return this.cli(['buzz', '--read', '--seat', this.name]); }
  handoff(text) { return this.cli(['handoff', text, '--seat', this.name]); }
  /** The end-of-turn hook, left waiting in the chat. Resolves with what it handed back (a continuation) once someone speaks. */
  stopListening(wait = 10) { return this.hook('Stop', {}, { HIVE_LISTEN_WAIT: String(wait) }); }
  /** `hive listen` as a tool in the middle of a turn. Returns { child, done } so the test can kill it. */
  listen(wait = 100) { return spawnCli(this.hive, ['listen', '--seat', this.name, '--wait', String(wait)], { cwd: this.dir }); }
}
export class CodexAgent extends ClaudeAgent { tool = 'codex'; flag = '--claude'; } // registers by hand in real life; the wire format is Claude's

/** Qwen Code: Claude-shaped events through `hive event`. */
export class QwenAgent extends ClaudeAgent {
  tool = 'qwen'; flag = '--qwen';
  hook(event, extra = {}, env = {}) { return this.cli(['event', '--seat', this.name], { input: JSON.stringify({ session_id: this.sid, cwd: this.dir, hook_event_name: event, ...extra }), env }); }
}

/** Gemini CLI: BeforeTool/AfterTool/BeforeAgent/AfterAgent with Gemini's snake_case tool ids. */
export class GeminiAgent extends Base {
  tool = 'gemini'; flag = '--gemini'; activity = /a\.js/;
  ev(event, extra = {}, env = {}) { return this.cli(['event', '--seat', this.name], { input: JSON.stringify({ session_id: this.sid, cwd: this.dir, hook_event_name: event, ...extra }), env }); }
  async prompt() { return this.ev('BeforeAgent', { prompt: 'go' }); }
  async work(file = 'a.js') { await this.ev('BeforeTool', { tool_name: 'read_file', tool_input: { absolute_path: file } }); return this.ev('AfterTool', { tool_name: 'read_file' }); }
  async idle() { return this.ev('AfterAgent', {}, { HIVE_LISTEN_WAIT: '1' }); }
}

/** Cursor: its own event names; before* hooks must answer allow on stdout. */
export class CursorAgent extends Base {
  tool = 'cursor'; flag = '--cursor'; activity = /a\.js/;
  ev(event, extra = {}) { return this.cli(['event', '--seat', this.name], { input: JSON.stringify({ conversation_id: this.sid, generation_id: 'g', cwd: this.dir, hook_event_name: event, ...extra }) }); }
  async prompt() { return this.ev('beforeSubmitPrompt', { prompt: 'go' }); }
  async work(file = 'a.js') { return this.ev('beforeReadFile', { file_path: file }); }
  async idle() { return this.ev('stop'); }
}

/** VS Code Copilot Chat: a background watcher reads the chat's JSONL patch log (nothing is hooked). */
export class CopilotAgent extends Base {
  tool = 'copilot'; flag = '--copilot'; activity = /a\.ts/;
  constructor(hive, name, opts) {
    super(hive, name, opts);
    this.userDir = join(hive.home, 'vscode-user');
    this.sessions = join(this.userDir, 'workspaceStorage', 'ws1', 'chatSessions');
    mkdirSync(this.sessions, { recursive: true });
    this.file = join(this.sessions, 'chat1.jsonl');
    writeFileSync(this.file, JSON.stringify({ kind: 0, v: { requests: [] } }) + '\n');
  }
  async join() { // the watcher is started by join and inherits this environment
    this.hive.tracked.push(this);
    const r = await this.cli(this.joinArgs(this.flag), { env: { OFFICE_VSCODE_USER_DIR: this.userDir } });
    if (r.code !== 0) throw new Error(`copilot join failed: ${r.stdout}${r.stderr}`);
    await sleep(1800); // the watcher starts reading from the end of the file
    return this;
  }
  line(o) { appendFileSync(this.file, JSON.stringify(o) + '\n'); }
  async prompt() { this.line({ kind: 2, k: ['requests'], v: [{}] }); await sleep(2200); }
  async work(file = '/p/a.ts') { this.line({ kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: `c${Math.random()}`, isComplete: true, invocationMessage: { value: 'x', uris: { [`file://${file}#1-1`]: { path: file } } } }] }); await sleep(2200); }
  async idle() { this.line({ kind: 1, k: ['requests', 0, 'result'], v: {} }); await sleep(2200); }
  async leave() { await super.leave(); }
}

/** Your own code over the raw HTTP API. */
export class ApiAgent extends Base {
  tool = 'api'; activity = /crawling the site/;
  async post(body) { return fetch(`http://${this.hive.ingest}/api/hooks/claude`, { method: 'POST', headers: { authorization: `Bearer ${this.hive.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: this.sid, cwd: `/office/${this.name}`, ...body }) }); }
  async join() { this.hive.tracked.push(this); await this.post({ hook_event_name: 'SessionStart', hive: { project: 'api-proj', chatty: this.chatty, hooks: ['custom'] } }); return this; }
  async prompt() { return this.post({ hook_event_name: 'UserPromptSubmit' }); }
  async work() { await this.post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'crawling the site' } }); return this.post({ hook_event_name: 'PostToolUse' }); }
  async idle() { return this.post({ hook_event_name: 'Stop' }); }
  async leave() { return this.post({ hook_event_name: 'SessionEnd' }); }
}

/** "Any agent that can run shell commands": it reports with `hive say`, and joins without hooks. */
export class ChirpAgent extends Base {
  tool = 'chirp'; flag = null; activity = /reading the config/;
  async prompt() {}
  async work() { return this.cli(['say', '--seat', this.name, 'reading the config']); }
  async idle() { return this.cli(['idle', '--seat', this.name]); }
}

export const HOOKED = [ClaudeAgent, CodexAgent, QwenAgent, GeminiAgent, CursorAgent, ApiAgent, ChirpAgent, CopilotAgent];

/** A service: `hive heartbeat` in one shot. */
export class ServiceAgent {
  constructor(hive, id, { name = id, project = 'svc' } = {}) { this.hive = hive; this.id = id; this.name = name; this.project = project; }
  beat(fields = {}) { return runCli(this.hive, ['heartbeat', '--id', this.id, '--name', this.name, '--project', this.project, '--url', this.hive.ingest, '--key', this.hive.key, ...Object.entries(fields).flatMap(([k, v]) => [`--${k}`, String(v)])]); }
  metrics(pairs) { return this.beat({}).then(() => runCli(this.hive, ['heartbeat', '--id', this.id, '--name', this.name, '--url', this.hive.ingest, '--key', this.hive.key, ...Object.entries(pairs).flatMap(([k, v]) => ['--metric', `${k}=${v}`])])); }
}
