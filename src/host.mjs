import { execSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HiveStore } from './hive.mjs';
import { chooseInvitees } from './chat.mjs';
import { Ledger } from './production.mjs';
import { Roster } from './roster.mjs';
import { loadRules } from './service-rules.mjs';
import { BuzzLog, watchHive } from './buzz.mjs';
import { createBee } from './bee.mjs';
import { RESPONDER_DEFAULTS, anthropicComplete, createResponder } from './responder.mjs';
import { describeSettings } from './hive-http.mjs';
import { createIngest } from './ingest.mjs';
import { createDemoSim } from '../scripts/demo-sim.mjs';
import { Monitor, describeHost } from './monitor.mjs';
import { loadMode, saveMode } from './mode-store.mjs';
import { startScreen } from './screen.mjs';

const dir = process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office');
const hostFile = join(dir, 'host.json');

/** The shared key is what the host hands to CLI users. It is stable across restarts . */
/** Host config lives in host.json: the shared key, and `prefillKey` (off unless you turn it on) — whether the public join page arrives with the
 *  key already filled in (default on: this hive is hosted for people to join, so they shouldn't have to hunt
 *  for the key). A flag passed to `hive host` is remembered here for next time. */
export function loadHostConfig({ rotate = false, prefillKey } = {}) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(hostFile, 'utf8')); } catch { /* first run */ }
  if (rotate || !cfg.key) cfg.key = randomBytes(16).toString('hex');
  if (prefillKey !== undefined) cfg.prefillKey = prefillKey;
  cfg.prefillKey ??= false; // safe by default: the key (which also lets someone boot an agent) is only shown to people you give it to
  mkdirSync(dir, { recursive: true });
  writeFileSync(hostFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

export const loadKey = (opts) => loadHostConfig(opts).key;

const lanIp = () => Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '<this-machine-ip>';

// os.hostname() can be a router-assigned name (e.g. "Mac.mymodem"); macOS's Bonjour name is the stable one.
function stableName() {
  try {
    if (process.platform === 'darwin') return `${execSync('scutil --get LocalHostName', { encoding: 'utf8' }).trim()}.local`;
  } catch { /* fall through */ }
  return hostname().endsWith('.local') ? hostname() : null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function startHost({ port = 3100, ingest = 3101, rotate = false, prefillKey, demo = false } = {}) {
  const { key, prefillKey: prefill } = loadHostConfig({ rotate, prefillKey });
  // The Hive: who is on the wall. Fed by the hook events agents send, plus service heartbeats.
  const monitor = new Monitor({ role: 'host' });
  monitor.captureConsole(); // what the host prints, and what it crashes with, is kept for `hive logs`
  const serviceRules = loadRules(); // what the Hive watches for in the machine stats services stream
  for (const e of serviceRules.errors) console.error(`hive: ${serviceRules.from} line ${e.line}: ${e.error}: ${e.text}`);
  const hive = new HiveStore({ ledger: new Ledger(), rules: serviceRules.rules }).start();
  const buzz = new BuzzLog({ invite: (m, thread) => chooseInvitees(hive, thread, m) });
  hive.connect(buzz);
  // The bots answer people (and react to real failures) only if a model key is set: opt-in, capped, and every line is marked host-voiced.
  const info = { responder: false };
  if (process.env.ANTHROPIC_API_KEY) {
    createResponder({ store: hive, buzz, complete: anthropicComplete({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.HIVE_MODEL }) });
    info.responder = true;
  }
  info.join = { ingest, key: prefill ? key : null }; // for the Join page; the key only if the host pre-fills it
  info.settings = describeSettings(hive, buzz, info.responder ? { on: true, model: process.env.HIVE_MODEL ?? 'claude-haiku-4-5-20251001', repliesPerHour: RESPONDER_DEFAULTS.repliesPerHour, dailyOutputTokens: RESPONDER_DEFAULTS.dailyOutputTokens, maxReplies: RESPONDER_DEFAULTS.maxReplies } : null);
  // Demo / Work: Demo seats a simulated crowd so the wall is never empty; Work shows them the door and expects real agents.
  const quiet = { on: false };
  const sim = createDemoSim({ store: hive, buzz, quiet, canned: !info.responder });
  const modeFile = join(dir, 'mode.json');
  let mode = 'work';
  const modeCtl = { get: () => mode, set: (m) => { mode = m; saveMode(modeFile, m); if (m === 'demo') sim.start(); else sim.stop(); } };
  createBee({ store: hive, buzz, quiet }); // two agents listening in the chat get a conversation starter from the Bee
  watchHive(hive, buzz, quiet); // real changes (a service failing or recovering, someone joining) become system lines in the buzz
  const uiDir = process.env.HIVE_UI_DIR ?? join(repoRoot, 'hive-ui', 'dist');
  startScreen({ port, ingest, prefillKey: prefill ? key : null, hive, uiDir, buzz, info, mode: modeCtl, key, monitor });
  // --demo wins; otherwise keep whatever was last chosen (a restart must not undo the Config page's switch to Work).
  if (demo || loadMode(modeFile) === 'demo') modeCtl.set('demo');

  // The keyed ingest: where agents and services join, report, buzz and heartbeat.
  http.createServer(createIngest({
    hive, buzz, key, monitor, roster: new Roster(),
    hostStatus: () => describeHost({ hive, buzz, mode: modeCtl, uiDir, ports: { screen: port, ingest }, info }),
    defaultBase: () => `${lanIp()}:${ingest}`,
    seatNames: () => hive.snapshot().filter((m) => m.kind === 'agent').map((m) => m.name),
  })).listen(ingest, '0.0.0.0');

  // Prefer the machine's .local name: the LAN address changes when DHCP renews, and every seat stores its address.
  const ip = lanIp();
  const name = stableName() ?? ip;
  console.log(`
The hive is open.
  Board mode:  ${mode === 'demo' ? 'DEMO: simulated agents are on the wall (switch to Work on the Config page, or restart without --demo)' : 'WORK: only real agents and services (start with --demo, or switch on the Config page, for simulated ones)'}
  Hive wall:   http://${name}:${port}/${name === ip ? '' : `   (or http://${ip}:${port}/)`}   (agents and services; the screen ships built, or: cd hive-ui && pnpm install && pnpm build)
  Buzz bots:   ${info.responder ? 'answering people, host-voiced and capped (ANTHROPIC_API_KEY is set)' : 'off. Set ANTHROPIC_API_KEY to let the chatty bots answer people'}
  Heartbeat:   hive heartbeat --id <id> --name <name> --url ${name}:${ingest} --key <key>   (services)
  Join page:   http://${name}:${port}/join-page   (also "Join this Hive" on the wall)
               key is ${prefill ? 'PRE-FILLED for anyone who can open the page (turn off: hive host --no-prefill-key)' : 'not pre-filled — people must be given it (turn on: hive host --prefill-key)'}
  Join:        curl -s http://${name}:${ingest}/join | node - join --key ${key}
  For agents:  "Read http://${name}:${ingest}/agent?key=${key} and follow it" (fetch it with curl)
`);
}
