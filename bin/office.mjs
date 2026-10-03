#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeat, loadSeat, pidFile, removeSeat } from '../src/seat.mjs';
import { watchCopilot } from '../src/copilot.mjs';
import { listSeats, send } from '../src/transport.mjs';
import { sessionStart, sessionEnd } from '../src/protocol.mjs';
import { applyAction, chirp, idle } from '../src/chirp.mjs';
import { cursorAllow, parseHookPayload } from '../src/normalize.mjs';
import { runWrapped } from '../src/run.mjs';
import { startProxy } from '../src/proxy.mjs';
import { startHost } from '../src/host.mjs';
import { defaultName } from '../src/names.mjs';
import { installCli, reportCommand } from '../src/install.mjs';

const HELP = `office — take a seat in the workspace office

  office host [--port 3100] [--ingest 3101] [--rotate-key] [--prefill-key|--no-prefill-key]
                                                              run the office (big screen + key); prints the join command.
                                                              The join page arrives with the key filled in by default; the
                                                              prefill flags are remembered in ~/.workspace-office/host.json
  office join <host[:port]> [name] --key K [--claude|--qwen|--gemini|--cursor|--copilot]
                                                              sit down (name defaults to a stable one for this user+machine+folder);
                                                              --claude/--qwen/--gemini/--cursor install that tool's hooks in this folder;
                                                              --copilot starts a background watcher for VS Code Copilot Chat
  office watch copilot [--seat <name>] [--detach]             report VS Code Copilot Chat activity on a seat
  office say "<what you're doing>" [--tool Read|Edit|Bash|…]  chirp activity (call before each step)
  office respond [who]                                        "responding to <who>" — send at the start of every turn
  office idle                                                 you're done with this turn
  office event --seat <name>                                  hook target: reads a Codex/Gemini/Cursor/Claude hook payload on stdin
  office leave                                                stand up
  office install                                              put office on your PATH (join does this for you)
  office run <name> -- <command…>                             wrapper: seat tracks the command's output
  office proxy <name> --listen 8081 --target http://localhost:8080/v1
                                                              proxy: seat tracks an OpenAI-compatible endpoint

Seat commands (say, respond, idle, leave) take --seat <name>, or use $OFFICE_SEAT, or the newest seat.
Env: OFFICE_KEY (default key).`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, args = rest) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const bool = (name, args = rest) => { const i = args.indexOf(`--${name}`); return i >= 0 && (args.splice(i, 1), true); };

const normalizeUrl = (host) => (/^https?:\/\//.test(host) ? host : `http://${host.includes(':') ? host : `${host}:3101`}`);
const die = (msg) => { console.error(`office: ${msg}`); process.exit(1); };

async function joinOffice() {
  const token = flag('key') ?? process.env.OFFICE_KEY;
  const hookKinds = ['claude', 'qwen', 'gemini', 'cursor'].filter((k) => bool(k));
  const copilot = bool('copilot');
  const [host, given] = rest.filter((a) => !a.startsWith('--'));
  if (!host) die('usage: office join <host[:port]> [name] --key K [--claude|--qwen|--gemini|--cursor|--copilot]');
  if (!token) die('no key — pass --key (ask whoever hosts the office) or set OFFICE_KEY');
  const url = normalizeUrl(host);
  const name = given ?? defaultName(process.cwd(), (await listSeats(url, token)) ?? new Set());
  const seat = createSeat({ url, token, name });
  const ok = await send(seat, sessionStart(seat), { quiet: false });
  if (!ok) { removeSeat(name); die(`could not join ${seat.url} — check the address and key`); }
  // Pixel Agents only creates a character on the first tool event, so sit down visibly right away.
  await chirp(seat, 'sitting down');
  await new Promise((r) => setTimeout(r, 600));
  await idle(seat);
  for (const kind of hookKinds) installHooks(kind, seat);
  if (copilot) startDetachedWatcher(seat);
  console.log(`${name} is seated at ${seat.url}.\nReport as ${name} with:  ${reportCommand(resolve(fileURLToPath(import.meta.url)))} <respond|say|idle> --seat ${name}`);
}

// Hook adapters. Each agent tool keeps its hooks in its own project-local file; we add one entry per event that
// runs this CLI, tagged by the 'office.mjs' path so `leave` (and a re-join) can find and replace only ours.
const HOOK_TARGETS = {
  claude: { file: ['.claude', 'settings.local.json'], sub: 'hook', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop'], entry: (command) => ({ hooks: [{ type: 'command', command }] }), root: (s) => (s.hooks ??= {}) },
  qwen: { file: ['.qwen', 'settings.json'], sub: 'event', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse'], entry: (command) => ({ hooks: [{ type: 'command', command }] }), root: (s) => (s.hooks ??= {}) },
  gemini: { file: ['.gemini', 'settings.json'], sub: 'event', events: ['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent'], entry: (command) => ({ matcher: '.*', hooks: [{ type: 'command', command }] }), root: (s) => (s.hooks ??= {}) },
  cursor: { file: ['.cursor', 'hooks.json'], sub: 'event', events: ['beforeShellExecution', 'afterShellExecution', 'beforeReadFile', 'afterFileEdit', 'beforeSubmitPrompt', 'stop'], entry: (command) => ({ command }), root: (s) => { s.version ??= 1; return (s.hooks ??= {}); } },
};
const isOurs = (h) => JSON.stringify(h).includes('office.mjs');

function installHooks(kind, seat) {
  const t = HOOK_TARGETS[kind];
  const file = join(process.cwd(), ...t.file);
  mkdirSync(dirname(file), { recursive: true });
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const command = `node "${resolve(fileURLToPath(import.meta.url))}" ${t.sub} --seat ${seat.name}`;
  const hooks = t.root(settings);
  for (const ev of t.events) hooks[ev] = [...(hooks[ev] ?? []).filter((h) => !isOurs(h)), t.entry(command)];
  const tracked = (() => { try { execSync(`git ls-files --error-unmatch "${file}"`, { cwd: process.cwd(), stdio: 'ignore' }); return true; } catch { return false; } })();
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`Installed ${kind} hooks in ${file}`);
  if (tracked) console.log(`  ⚠ ${t.file.join('/')} is tracked by git and now holds a machine-specific path — don't commit that change (run \`office leave\` first).`);
  excludeFromGit(`**/${t.file.join('/')}`);
}

// The hook files hold a machine-specific path; keep them out of commits via the repo-local (uncommitted) exclude.
function excludeFromGit(line) {
  try {
    const out = execSync('git rev-parse --git-path info/exclude', { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const file = resolve(process.cwd(), out);
    mkdirSync(dirname(file), { recursive: true });
    if (!(existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(line))) appendFileSync(file, `\n${line}\n`);
  } catch { /* not a git repo */ }
}

function removeHooks() {
  for (const t of Object.values(HOOK_TARGETS)) {
    const file = join(process.cwd(), ...t.file);
    if (!existsSync(file)) continue;
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    const hooks = settings.hooks ?? {};
    for (const ev of Object.keys(hooks)) {
      hooks[ev] = hooks[ev].filter((h) => !isOurs(h));
      if (!hooks[ev].length) delete hooks[ev];
    }
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }
}

function startDetachedWatcher(seat) {
  const child = spawn(process.execPath, [resolve(fileURLToPath(import.meta.url)), 'watch', 'copilot', '--seat', seat.name], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  writeFileSync(pidFile(seat.name), String(child.pid));
  console.log(`Watching VS Code Copilot Chat in the background (pid ${child.pid}); \`office leave\` stops it.`);
}

async function hook() {
  const seat = loadSeat(flag('seat'));
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  // One seat = one character: report under the seat's own session id and name, whichever Claude session
  // is talking (otherwise the join and the first real session would show up as two same-named characters).
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  // Pixel Agents ignores UserPromptSubmit; turn it into the "responding to <you>" chirp ourselves.
  if (payload.hook_event_name === 'UserPromptSubmit') return void (await chirp(seat, `responding to ${userInfo().username}`, { tool: 'Bash' }));
  await send(seat, { ...payload, session_id: seat.sessionId, cwd: seat.cwd });
}

switch (cmd) {
  case 'host': await startHost({ port: Number(flag('port') ?? 3100), ingest: Number(flag('ingest') ?? 3101), rotate: bool('rotate-key'), prefillKey: bool('prefill-key') ? true : bool('no-prefill-key') ? false : undefined }); break;
  case 'join': await joinOffice(); break;
  case 'say': {
    const tool = flag('tool');
    const seat = loadSeat(flag('seat'));
    const text = rest.join(' ');
    if (!text) die('usage: office say "<what you are doing>"');
    process.exit((await chirp(seat, text, { tool })) ? 0 : 1);
    break;
  }
  case 'respond': { const seat = loadSeat(flag('seat')); process.exit((await chirp(seat, `responding to ${rest.join(' ') || 'you'}`, { tool: 'Bash' })) ? 0 : 1); break; }
  case 'idle': await idle(loadSeat(flag('seat'))); break;
  case 'install': {
    const { shim, dir, onPath } = installCli();
    console.log(`Installed ${shim}${onPath ? '' : `\nAdd ${dir} to your PATH to type just \`office\`.`}`);
    break;
  }
  case 'hook': await hook(); break;
  case 'watch': {
    if (rest[0] !== 'copilot') die('usage: office watch copilot [--seat <name>] [--detach]');
    rest.shift();
    const seat = loadSeat(flag('seat'));
    if (bool('detach')) { startDetachedWatcher(seat); break; }
    const w = watchCopilot(seat, { user: userInfo().username, log: (a) => console.log(`copilot: ${a.type}${a.tool ? ` ${a.tool}` : ''}`) });
    console.log(`Watching ${w.files.size} Copilot Chat session file(s) as ${seat.name}. Ctrl+C to stop.`);
    await new Promise(() => {});
    break;
  }
  case 'event': {
    // Generic hook target (Codex, Gemini CLI, Cursor, …). Must never fail or print junk: in these tools a
    // non-zero exit (or stray stdout) is read as a verdict on the agent's action.
    try {
      const seat = loadSeat(flag('seat'));
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      const payload = JSON.parse(Buffer.concat(chunks).toString().replace(/^\uFEFF/, ''));
      const action = parseHookPayload(payload);
      if (action) await applyAction(seat, action, userInfo().username);
      const reply = cursorAllow(payload);
      if (reply) process.stdout.write(reply);
    } catch { /* observing only */ }
    process.exit(0);
    break;
  }
  case 'leave': {
    const seat = loadSeat(flag('seat'));
    await send(seat, sessionEnd(seat));
    removeSeat(seat.name);
    removeHooks();
    console.log(`${seat.name} left the office.`);
    break;
  }
  case 'run': {
    const sep = rest.indexOf('--');
    const [name] = rest.slice(0, sep < 0 ? undefined : sep);
    if (sep < 0 || !name || sep === rest.length - 1) die('usage: office run <name> -- <command…>');
    const seat = loadSeat(name);
    await send(seat, sessionStart(seat));
    process.exit(await runWrapped(seat, rest.slice(sep + 1)));
    break;
  }
  case 'proxy': {
    const listen = Number(flag('listen') ?? 8081);
    const target = flag('target');
    const [name] = rest;
    if (!name || !target) die('usage: office proxy <name> --listen 8081 --target http://localhost:8080/v1');
    const seat = loadSeat(name);
    await send(seat, sessionStart(seat));
    startProxy(seat, { listen, target });
    console.log(`proxying :${listen} → ${target} as seat ${name}. Point your agent's base URL at http://localhost:${listen}.`);
    break;
  }
  default: console.log(HELP); process.exit(cmd ? 1 : 0);
}
