#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeat, loadSeat, removeSeat } from '../src/seat.mjs';
import { listSeats, send } from '../src/transport.mjs';
import { sessionStart, sessionEnd } from '../src/protocol.mjs';
import { chirp, idle } from '../src/chirp.mjs';
import { runWrapped } from '../src/run.mjs';
import { startProxy } from '../src/proxy.mjs';
import { startHost } from '../src/host.mjs';
import { defaultName } from '../src/names.mjs';
import { installCli, reportCommand } from '../src/install.mjs';

const HELP = `office — take a seat in the workspace office

  office host [--port 3100] [--ingest 3101] [--rotate-key]    run the office (big screen + key); prints the join command
  office join <host[:port]> [name] --key K [--claude]        sit down (name defaults to a stable one for this user+machine+folder) (--claude also installs Claude Code hooks)
  office say "<what you're doing>" [--tool Read|Edit|Bash|…]  chirp activity (call before each step)
  office respond [who]                                        "responding to <who>" — send at the start of every turn
  office idle                                                 you're done with this turn
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
  const claude = bool('claude');
  const [host, given] = rest.filter((a) => !a.startsWith('--'));
  if (!host) die('usage: office join <host[:port]> [name] --key K [--claude]');
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
  if (claude) installClaudeHooks(seat);
  console.log(`${name} is seated at ${seat.url}.\nReport as ${name} with:  ${reportCommand(resolve(fileURLToPath(import.meta.url)))} <respond|say|idle> --seat ${name}`);
}

// Claude Code adapter: forward real hook events (session id preserved) through `office hook`.
// Project-local settings so it is scoped and `office leave` can undo it.
function installClaudeHooks(seat) {
  const file = join(process.cwd(), '.claude', 'settings.local.json');
  mkdirSync(dirname(file), { recursive: true });
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const command = `node "${resolve(fileURLToPath(import.meta.url))}" hook --seat ${seat.name}`;
  settings.hooks ??= {};
  for (const ev of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop']) {
    const list = (settings.hooks[ev] ??= []).filter((h) => !JSON.stringify(h).includes('office.mjs'));
    settings.hooks[ev] = [...list, { hooks: [{ type: 'command', command }] }];
  }
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`Installed Claude Code hooks in ${file}`);
  excludeFromGit();
}

// The hook file holds a machine-specific path; keep it out of commits via the repo-local (uncommitted) exclude.
function excludeFromGit() {
  try {
    const out = execSync('git rev-parse --git-path info/exclude', { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const file = resolve(process.cwd(), out);
    const line = '**/.claude/settings.local.json';
    mkdirSync(dirname(file), { recursive: true });
    if (!(existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(line))) appendFileSync(file, `\n${line}\n`);
  } catch { /* not a git repo */ }
}

function removeClaudeHooks() {
  const file = join(process.cwd(), '.claude', 'settings.local.json');
  if (!existsSync(file)) return;
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  for (const ev of Object.keys(settings.hooks ?? {})) {
    settings.hooks[ev] = settings.hooks[ev].filter((h) => !JSON.stringify(h).includes('office.mjs'));
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  writeFileSync(file, JSON.stringify(settings, null, 2));
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
  case 'host': await startHost({ port: Number(flag('port') ?? 3100), ingest: Number(flag('ingest') ?? 3101), rotate: bool('rotate-key') }); break;
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
  case 'leave': {
    const seat = loadSeat(flag('seat'));
    await send(seat, sessionEnd(seat));
    removeSeat(seat.name);
    removeClaudeHooks();
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
