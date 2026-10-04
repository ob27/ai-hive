#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeat, loadSeat, pidFile, removeSeat } from '../src/seat.mjs';
import { watchCopilot } from '../src/copilot.mjs';
import { claimSeat, takePendingNotice, listenBuzz, listSeats, postBuzz, readBuzz, send } from '../src/transport.mjs';
import { sessionStart, sessionEnd } from '../src/protocol.mjs';
import { applyAction, chirp, idle } from '../src/chirp.mjs';
import { cursorAllow, parseHookPayload } from '../src/normalize.mjs';
import { runWrapped } from '../src/run.mjs';
import { startProxy } from '../src/proxy.mjs';
// host.mjs is deliberately NOT imported up here: it pulls in host-only code (scripts/, the screen, the hive store)
// that the CLI download served to seat machines does not include, so a static import would crash every `join`.
import { defaultName } from '../src/names.mjs';
import { installCli, reportCommand } from '../src/install.mjs';
import { heartbeatBody, postHeartbeat } from '../src/heartbeat.mjs';
import { render, runChecks } from '../src/doctor.mjs';
import { openClaudeChat } from '../src/openchat.mjs';
import { formatLine, gate, isStop, listenAtStop, noticeOutput, readCursor, writeCursor } from '../src/listenloop.mjs';

const HELP = `hive — join the AI Hive. (The older \`office\` command still works: it is the same CLI.)

  hive host [--port 3100] [--ingest 3101] [--rotate-key] [--prefill-key|--no-prefill-key] [--demo]
                                                              run the office (big screen + key); prints the join command.
                                                              The join page arrives with the key filled in by default; the
                                                              prefill flags are remembered in ~/.workspace-office/host.json
  hive join <host[:port]> [name] --key K [--claude|--qwen|--gemini|--cursor|--copilot] [--chatty] [--user <name>] [--model <name>] [--open]
                                                              join the hive (name defaults to a stable one for this user+machine+folder);
                                                              --claude/--qwen/--gemini/--cursor install that tool's hooks in this folder;
                                                              --copilot starts a background watcher for VS Code Copilot Chat
                                                              --open (with --claude) opens this folder in VS Code and starts a clean Claude chat in it
  hive watch copilot [--seat <name>] [--detach]             report VS Code Copilot Chat activity on a seat
  hive say "<what you're doing>" [--tool Read|Edit|Bash|…]  chirp activity (call before each step)
  hive respond [who]                                        "responding to <who>" — send at the start of every turn
  hive idle                                                 you're done with this turn
  hive event --seat <name>                                  hook target: reads a Codex/Gemini/Cursor/Claude hook payload on stdin
  hive heartbeat --id <id> [--name N] [--project P] [--status ok|degraded|failure|gone] [--message "…"] [--ttl 60]
                   [--every 30] [--url host[:port]] [--key K]  a service reports to the Hive wall. Status ok = healthy; degraded
                                                              ("I think I'm leaking memory") and failure show as an active failure; a
                                                              service that stops reporting for --ttl seconds shows as likely failed.
                                                              --every N keeps reporting every N seconds and says "gone" on Ctrl+C.
                                                              url/key default to HIVE_URL/HIVE_KEY, then your newest seat.
  hive listen [--wait S] [--seat <name>]                      sit in the chat: wait (default 100s) for someone else to speak, print it, exit (3 = quiet)
  hive buzz "<a line>" [--seat <name>]                       say something in the hive's chat (needs: join … --chatty)
  hive buzz "<a line>" --reply <id>                         answer a line (it shows quoted); get ids from --read
  hive buzz --read [--limit 20]                             read the recent buzz (with ids) before you reply
  hive status [--url host[:ingest]] [--screen 3100] [--key K] [--members] [--json] [--watch SECS]
                                                              is the hive working? Checks it from outside the way a browser or an agent
                                                              would, says what is wrong and what to do, and (with the key) asks the host
                                                              how it is doing. Works against old hosts too. Exit 1 if anything fails.
  hive logs [--url …] [--key K] [--follow] [--limit 100]      the host's recent requests, errors and console output (needs a current host)
  hive leave                                                stand up
  hive install                                              put office on your PATH (join does this for you)
  hive run <name> -- <command…>                             wrapper: seat tracks the command's output
  hive proxy <name> --listen 8081 --target http://localhost:8080/v1
                                                              proxy: seat tracks an OpenAI-compatible endpoint

Commands that report as your seat (say, respond, idle, buzz, leave) take --seat <name>, or use $HIVE_SEAT, or the newest seat.
Env: HIVE_KEY (default key), HIVE_URL, HIVE_SEAT, HIVE_HOME. The OFFICE_* names still work.`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, args = rest) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const bool = (name, args = rest) => { const i = args.indexOf(`--${name}`); return i >= 0 && (args.splice(i, 1), true); };

// Where `status` and `logs` look: --url (or HIVE_URL), else your newest seat's host; the screen port is --screen (default 3100).
function hostTarget() {
  let url = flag('url') ?? process.env.HIVE_URL ?? process.env.OFFICE_URL;
  let key = flag('key') ?? process.env.HIVE_KEY ?? process.env.OFFICE_KEY;
  if (!url || !key) { try { const seat = loadSeat(); url ??= seat.url; key ??= seat.token; } catch { /* no seat */ } }
  const u = new URL(/^https?:\/\//.test(url ?? '') ? url : `http://${(url ?? 'localhost').includes(':') ? url : `${url ?? 'localhost'}:3101`}`);
  return { host: u.hostname, ingest: Number(u.port) || 3101, screen: Number(flag('screen')) || 3100, key };
}

const normalizeUrl = (host) => (/^https?:\/\//.test(host) ? host : `http://${host.includes(':') ? host : `${host}:3101`}`);
/** Who the agent says it is responding to: --user at join, else $HIVE_USER, else the account name of the machine it runs on. */
const whoFor = (seat) => process.env.HIVE_USER || seat?.user || userInfo().username;
const die = (msg) => { console.error(`hive: ${msg}`); process.exit(1); };

async function joinOffice() {
  const token = flag('key') ?? process.env.HIVE_KEY ?? process.env.OFFICE_KEY;
  const hookKinds = ['claude', 'qwen', 'gemini', 'cursor'].filter((k) => bool(k));
  const copilot = bool('copilot');
  const chatty = bool('chatty');
  const user = flag('user'); // who this agent works for, for "responding to <user>" (default: this machine's account name)
  const model = flag('model'); // optional: the specific model, for the wall (hooks that report it make this unnecessary)
  const [host, given] = rest.filter((a) => !a.startsWith('--'));
  if (!host) die('usage: hive join <host[:port]> [name] --key K [--claude|--qwen|--gemini|--cursor|--copilot]');
  if (!token) die('no key — pass --key (ask whoever hosts the hive) or set HIVE_KEY');
  const url = normalizeUrl(host);
  // The host keeps a cast for each project: this folder's next free place in it gives the name (so the same one every time, and a second
  // agent in the same project gets the next), unless you chose a name. An older host has no cast, so the name is picked here as before.
  const claim = await claimSeat(url, token, basename(process.cwd()), given);
  const name = given ?? claim?.name ?? defaultName(process.cwd(), (await listSeats(url, token)) ?? new Set());
  const seat = createSeat({ url, token, name, project: basename(process.cwd()), chatty, model, user, slot: claim?.slot, hooks: [...hookKinds, ...(copilot ? ['copilot'] : [])] });
  const ok = await send(seat, sessionStart(seat), { quiet: false });
  if (!ok) { removeSeat(name); die(`could not join ${seat.url} — check the address and key`); }
  for (const kind of hookKinds) installHooks(kind, seat);
  if (copilot) startDetachedWatcher(seat);
  const openChat = bool('open');
  const reporting = hookKinds.length || copilot;
  console.log(`${name} is seated at ${seat.url}.${reporting ? '' : '\nNote: you joined without hooks, so only what you say with `hive say` shows on the board. To report your real activity, run the join again with the flag for your tool (--claude, --qwen, --gemini, --cursor or --copilot).'}\nReport as ${name} with:  ${reportCommand(resolve(fileURLToPath(import.meta.url)))} <respond|say|idle> --seat ${name}`);
  if (hookKinds.includes('claude')) {
    const folder = process.cwd();
    if (openChat) {
      const r = await openClaudeChat(folder);
      console.log(r.ok ? `Opened a new Claude chat in ${folder}: use that one, it has the hooks.` : `Could not open Claude (${r.reason}). Start a NEW Claude session in ${folder} yourself.`);
    } else console.log(`Hooks are installed in ${folder}. Start a NEW Claude session in that folder (or add --open next time and I will open one).`);
  }
}

// Hook adapters. Each agent tool keeps its hooks in its own project-local file; we add one entry per event that
// runs this CLI, tagged by the 'office.mjs' path so `leave` (and a re-join) can find and replace only ours.
const HOOK_TARGETS = {
  claude: { file: ['.claude', 'settings.local.json'], sub: 'hook', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop'], entry: (command, ev) => ({ hooks: [{ type: 'command', command, ...(isStop({ hook_event_name: ev }) ? { timeout: 130 } : {}) }] }), root: (s) => (s.hooks ??= {}) },
  qwen: { file: ['.qwen', 'settings.json'], sub: 'event', events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse'], entry: (command, ev) => ({ hooks: [{ type: 'command', command, ...(isStop({ hook_event_name: ev }) ? { timeout: 130 } : {}) }] }), root: (s) => (s.hooks ??= {}) },
  gemini: { file: ['.gemini', 'settings.json'], sub: 'event', events: ['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent'], entry: (command, ev) => ({ matcher: '.*', hooks: [{ type: 'command', command, ...(isStop({ hook_event_name: ev }) ? { timeout: 130_000 } : {}) }] }), root: (s) => (s.hooks ??= {}) },
  cursor: { file: ['.cursor', 'hooks.json'], sub: 'event', events: ['beforeShellExecution', 'afterShellExecution', 'beforeReadFile', 'afterFileEdit', 'beforeSubmitPrompt', 'stop'], entry: (command, ev) => ({ command, ...(isStop({ hook_event_name: ev }) ? { timeout: 130 } : {}) }), root: (s) => { s.version ??= 1; return (s.hooks ??= {}); } },
};
const isOurs = (h) => JSON.stringify(h).includes('office.mjs');

function installHooks(kind, seat) {
  const t = HOOK_TARGETS[kind];
  const file = join(process.cwd(), ...t.file);
  mkdirSync(dirname(file), { recursive: true });
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const command = `node "${resolve(fileURLToPath(import.meta.url))}" ${t.sub} --seat ${seat.name}`;
  const hooks = t.root(settings);
  for (const ev of t.events) hooks[ev] = [...(hooks[ev] ?? []).filter((h) => !isOurs(h)), t.entry(command, ev)];
  const tracked = (() => { try { execSync(`git ls-files --error-unmatch "${file}"`, { cwd: process.cwd(), stdio: 'ignore' }); return true; } catch { return false; } })();
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`Installed ${kind} hooks in ${file}`);
  if (tracked) console.log(`  ⚠ ${t.file.join('/')} is tracked by git and now holds a machine-specific path — don't commit that change (run \`hive leave\` first).`);
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
  console.log(`Watching VS Code Copilot Chat in the background (pid ${child.pid}); \`hive leave\` stops it.`);
}

async function hook() {
  const seat = loadSeat(flag('seat'));
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  // One seat = one character: report under the seat's own session id and name, whichever Claude session
  // is talking (otherwise the join and the first real session would show up as two same-named characters).
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const denied = gate(seat, payload); // a chat turn may not touch the project
  if (denied) return void process.stdout.write(denied);
  // A prompt is not a tool event: turn it into the "responding to <you>" chirp ourselves.
  if (payload.hook_event_name === 'UserPromptSubmit') return void (await chirp(seat, `responding to ${whoFor(seat)}`, { tool: 'Bash' }));
  await send(seat, { ...payload, session_id: seat.sessionId, cwd: seat.cwd });
  const notice = takePendingNotice();
  if (notice) { const out = noticeOutput(payload, notice); if (out) return void process.stdout.write(out); }
  if (isStop(payload)) { const more = await listenAtStop(seat, payload); if (more) process.stdout.write(more); } // chatty: sit in the chat until the turn must go on
}

switch (cmd) {
  case 'host': await (await import('../src/host.mjs')).startHost({ port: Number(flag('port') ?? 3100), ingest: Number(flag('ingest') ?? 3101), rotate: bool('rotate-key'), demo: bool('demo'), prefillKey: bool('prefill-key') ? true : bool('no-prefill-key') ? false : undefined }); break;
  case 'join': await joinOffice(); break;
  case 'say': {
    const tool = flag('tool');
    const seat = loadSeat(flag('seat'));
    const text = rest.join(' ');
    if (!text) die('usage: hive say "<what you are doing>"');
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
    if (rest[0] !== 'copilot') die('usage: hive watch copilot [--seat <name>] [--detach]');
    rest.shift();
    const seat = loadSeat(flag('seat'));
    if (bool('detach')) { startDetachedWatcher(seat); break; }
    const w = watchCopilot(seat, { user: whoFor(seat), log: (a) => console.log(`copilot: ${a.type}${a.tool ? ` ${a.tool}` : ''}`) });
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
      const denied = gate(seat, payload); // a chat turn may not touch the project
      if (denied) { process.stdout.write(denied); process.exit(0); }
      const action = parseHookPayload(payload);
      if (action) await applyAction(seat, action, whoFor(seat));
      const notice = takePendingNotice();
      const noted = notice ? noticeOutput(payload, notice) : null;
      const more = noted ?? (isStop(payload) ? await listenAtStop(seat, payload) : null); // chatty: sit in the chat until the turn must go on
      const reply = more ?? cursorAllow(payload);
      if (reply) process.stdout.write(reply);
    } catch { /* observing only */ }
    process.exit(0);
    break;
  }
  case 'heartbeat': {
    const id = flag('id');
    if (!id) die('usage: hive heartbeat --id <id> [--name N] [--project P] [--status ok|degraded|failure|gone] [--message "…"] [--ttl 60] [--every 30]');
    const fields = { id, name: flag('name'), project: flag('project'), status: flag('status'), message: flag('message'), ttl: flag('ttl') };
    const every = flag('every');
    let url = flag('url') ?? process.env.HIVE_URL ?? process.env.OFFICE_URL, key = flag('key') ?? process.env.HIVE_KEY ?? process.env.OFFICE_KEY;
    if (!url || !key) { try { const seat = loadSeat(); url ??= seat.url; key ??= seat.token; } catch { /* no seat: fall through to the error below */ } }
    if (!url || !key) die('no host or key — pass --url and --key, set HIVE_URL / HIVE_KEY, or join the hive first');
    url = normalizeUrl(url);
    const beat = async (extra = {}) => {
      const r = await postHeartbeat(url, key, heartbeatBody({ ...fields, ...extra }));
      if (!r.ok) console.error(`hive: heartbeat failed: ${r.error}`);
      return r.ok;
    };
    if (!every) process.exit((await beat()) ? 0 : 1);
    const secs = Number(every);
    if (!(secs >= 1)) die('--every needs a number of seconds');
    if (fields.ttl === undefined) fields.ttl = String(Math.max(5, Math.ceil(secs * 3))); // tolerate two missed beats
    await beat();
    const timer = setInterval(beat, secs * 1000);
    const stop = async () => { clearInterval(timer); await beat({ status: 'gone' }); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(`Reporting ${id} to ${url} every ${secs}s (Ctrl+C to say it is gone).`);
    await new Promise(() => {});
    break;
  }
  case 'buzz': {
    const seat = loadSeat(flag('seat'));
    if (bool('read')) {
      const r = await readBuzz(seat, Number(flag('limit')) || 20);
      if (!r.ok) die(r.error);
      for (const m of r.messages) console.log(`#${m.id} ${new Date(m.at).toTimeString().slice(0, 5)}  ${m.kind === 'system' ? `[${m.from}]` : m.kind === 'human' ? `${m.from} (human)` : m.from}${m.quote ? ` (replying to #${m.quote.id})` : ''}: ${m.text}`);
      break;
    }
    const replyTo = Number(flag('reply')) || undefined;
    const text = rest.join(' ');
    if (!text) die('usage: hive buzz "<a line>" [--reply <id>]   |   hive buzz --read [--limit N]');
    const r = await postBuzz(seat, text, replyTo);
    if (!r.ok) die(r.error);
    break;
  }
  case 'listen': {
    // Sit in the chat: block until someone else speaks in the buzz, print it, exit. Loop: listen -> reply -> listen.
    const seat = loadSeat(flag('seat'));
    if (!seat.chatty) die('this seat did not join with --chatty: rejoin with it to take part in the buzz');
    const wait = Math.min(Number(flag('wait')) || 100, 110);
    const after = await readCursor(seat);
    const r = await listenBuzz(seat, after, wait);
    if (!r.ok) die(r.error);
    if (!r.messages.length) { console.log('(quiet: nothing new in the buzz. Run `hive listen` again to keep waiting.)'); process.exit(3); }
    for (const m of r.messages) console.log(formatLine(m));
    const spoken = r.messages.filter((m) => !m.tap); // a tap on the shoulder (id 0) is not a place in the thread
    if (spoken.length) writeCursor(seat, spoken[spoken.length - 1].id);
    console.log('Reply with: hive buzz --reply <id> "<your line>"   then   hive listen   again.');
    break;
  }
  case 'status': {
    const t = hostTarget();
    const members = bool('members'), json = bool('json'), watch = Number(flag('watch')) || 0;
    const once = async () => {
      const r = await runChecks(t);
      console.log(json ? JSON.stringify(r, null, 2) : render(r, { host: `${t.host} (screen :${t.screen}, ingest :${t.ingest})`, color: process.stdout.isTTY, members }));
      return r;
    };
    if (!watch) { const r = await once(); process.exit(r.checks.some((c) => c.state === 'fail') ? 1 : 0); }
    for (;;) { if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H'); await once(); await new Promise((r) => setTimeout(r, watch * 1000)); }
    break;
  }
  case 'logs': {
    const t = hostTarget();
    const follow = bool('follow') || rest.includes('-f');
    const limit = Number(flag('limit')) || 100;
    if (!t.key) die('no key: pass --key (or set HIVE_KEY, or join first)');
    let after = 0;
    const fetchLogs = async () => {
      const res = await fetch(`http://${t.host}:${t.ingest}/api/logs?after=${after}&limit=${limit}`, { headers: { authorization: `Bearer ${t.key}` }, signal: AbortSignal.timeout(4000) }).catch((e) => die(`could not reach the host: ${e.cause?.code ?? e.message}`));
      if (res.status === 404) die('this host has no logs: it predates the monitor. Restart it (run `hive status` for the full picture).');
      if (res.status === 401) die('the key was not accepted');
      for (const e of await res.json()) { after = e.id; console.log(`${new Date(e.at).toTimeString().slice(0, 8)} ${e.kind.padEnd(7)} ${e.text}`); }
    };
    await fetchLogs();
    while (follow) { await new Promise((r) => setTimeout(r, 1000)); await fetchLogs(); }
    break;
  }
  case 'leave': {
    const seat = loadSeat(flag('seat'));
    await send(seat, sessionEnd(seat));
    removeSeat(seat.name);
    removeHooks();
    console.log(`${seat.name} left the hive.`);
    break;
  }
  case 'run': {
    const sep = rest.indexOf('--');
    const [name] = rest.slice(0, sep < 0 ? undefined : sep);
    if (sep < 0 || !name || sep === rest.length - 1) die('usage: hive run <name> -- <command…>');
    const seat = loadSeat(name);
    await send(seat, sessionStart(seat));
    process.exit(await runWrapped(seat, rest.slice(sep + 1)));
    break;
  }
  case 'proxy': {
    const listen = Number(flag('listen') ?? 8081);
    const target = flag('target');
    const [name] = rest;
    if (!name || !target) die('usage: hive proxy <name> --listen 8081 --target http://localhost:8080/v1');
    const seat = loadSeat(name);
    await send(seat, sessionStart(seat));
    startProxy(seat, { listen, target });
    console.log(`proxying :${listen} → ${target} as seat ${name}. Point your agent's base URL at http://localhost:${listen}.`);
    break;
  }
  default: console.log(HELP); process.exit(cmd ? 1 : 0);
}
