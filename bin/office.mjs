#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

const HELP = `office — take a seat in the workspace office

  office host [--port 3100] [--ingest 3101] [--rotate-key]    run the office (big screen + key); prints the join command
  office join <host[:port]> [name] --key K [--claude]        sit down (name defaults to a stable one for this user+machine+folder) (--claude also installs Claude Code hooks)
  office say "<what you're doing>" [--tool Read|Edit|Bash|…]  chirp activity (call before each step)
  office respond [who]                                        "responding to <who>" — send at the start of every turn
  office idle                                                 you're done with this turn
  office leave                                                stand up
  office run <name> -- <command…>                             wrapper: seat tracks the command's output
  office proxy <name> --listen 8081 --target http://localhost:8080/v1
                                                              proxy: seat tracks an OpenAI-compatible endpoint

Env: OFFICE_KEY (default key), OFFICE_SEAT (which seat 'say' uses).`;

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
  if (claude) installClaudeHooks(seat);
  console.log(`${name} is seated at ${seat.url}.\nTo chirp from this shell:  export OFFICE_SEAT=${name}`);
}

// Claude Code adapter: forward real hook events (session id preserved) through `office hook`.
// Project-local settings so it is scoped and `office leave` can undo it.
function installClaudeHooks(seat) {
  const file = join(process.cwd(), '.claude', 'settings.local.json');
  mkdirSync(dirname(file), { recursive: true });
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const command = `node "${resolve(fileURLToPath(import.meta.url))}" hook --seat ${seat.name}`;
  settings.hooks ??= {};
  for (const ev of ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop']) {
    const list = (settings.hooks[ev] ??= []).filter((h) => !JSON.stringify(h).includes('office.mjs'));
    settings.hooks[ev] = [...list, { hooks: [{ type: 'command', command }] }];
  }
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`Installed Claude Code hooks in ${file}`);
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
  // Keep Claude's real session_id (one character per session) but label it with the seat name.
  await send(seat, { ...JSON.parse(Buffer.concat(chunks).toString()), cwd: seat.cwd });
}

switch (cmd) {
  case 'host': await startHost({ port: Number(flag('port') ?? 3100), ingest: Number(flag('ingest') ?? 3101), rotate: bool('rotate-key') }); break;
  case 'join': await joinOffice(); break;
  case 'say': {
    const tool = flag('tool');
    const text = rest.join(' ');
    if (!text) die('usage: office say "<what you are doing>"');
    process.exit((await chirp(loadSeat(), text, { tool })) ? 0 : 1);
    break;
  }
  case 'respond': process.exit((await chirp(loadSeat(), `responding to ${rest.join(' ') || 'you'}`, { tool: 'Bash' })) ? 0 : 1); break;
  case 'idle': await idle(loadSeat()); break;
  case 'hook': await hook(); break;
  case 'leave': {
    const seat = loadSeat();
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
