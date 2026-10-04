// A self-contained Hive for looking at and tuning the wall: the real screen, the real routes and store, and a simulator
// feeding it agents, service heartbeats and buzz. Nothing to install.
//
//   node scripts/hive-demo.mjs [--port 3200] [--ingest 3202] [--work]        then open  http://<this machine>:3200/hive/
//
// Build the screen first:  cd hive-ui && pnpm install && pnpm build
//
// It is a real, joinable hive: the Join page works, and a real agent can join with the printed command
// (`hive join <host>:3202 --key <the key printed at startup> --chatty`), then chirp, buzz and appear on the wall. It starts in DEMO mode (simulated bees on the
// wall); `--work` starts it in WORK mode (only real agents), and the Config page switches between them (with the key).
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuzzLog, watchHive } from '../src/buzz.mjs';
import { HiveStore } from '../src/hive.mjs';
import { chooseInvitees } from '../src/chat.mjs';
import { Ledger } from '../src/production.mjs';
import { Roster } from '../src/roster.mjs';
import { describeSettings, handleAdmin, handleHiveRead, handleHumanBuzz, handleJoinRedirect, handleMode } from '../src/hive-http.mjs';
import { createIngest } from '../src/ingest.mjs';
import { loadMode, saveMode } from '../src/mode-store.mjs';
import { joinPage } from '../src/joinpage.mjs';
import { createDemoSim } from './demo-sim.mjs';
import { Monitor, describeHost } from '../src/monitor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => Number(process.argv[process.argv.indexOf(name) + 1]) || d;
const port = arg('--port', 3200), ingestPort = arg('--ingest', 3202);
const KEY = process.env.HIVE_DEMO_KEY ?? randomBytes(8).toString('hex'); // random each start (set HIVE_DEMO_KEY to choose): it is on the network, and the key lets someone boot agents
const lanIp = () => Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';

const monitor = new Monitor({ role: 'demo' });
monitor.captureConsole();
const store = new HiveStore({ tickMs: 2000, ledger: new Ledger({ file: join(homedir(), '.workspace-office', `production-demo-${port}.json`) }) }).start();
const buzz = new BuzzLog({ perHour: 1000, humanPerHour: 1000, invite: (m, thread) => chooseInvitees(store, thread, m) });
store.connect(buzz); // Listening = really waiting in the chat; composing and speaking
const quiet = { on: false };
const sim = createDemoSim({ store, buzz, quiet });
const modeFile = join(homedir(), '.workspace-office', `demo-mode-${port}.json`);
let mode = 'work';
const modeCtl = { get: () => mode, set: (m) => { mode = m; saveMode(modeFile, m); if (m === 'demo') sim.start(); else sim.stop(); } };
watchHive(store, buzz, quiet); // after the first seating, so the thread does not open with 20 "joined" lines
// Start mode: an explicit --work / --demo wins; otherwise whatever was last chosen on the Config page (so a restart
// does not snap back to demo); otherwise DEMO, this script's documented default.
modeCtl.set(process.argv.includes('--work') ? 'work' : process.argv.includes('--demo') ? 'demo' : (loadMode(modeFile) ?? 'demo'));

const info = { responder: true, demo: true, join: { ingest: ingestPort, key: KEY }, settings: describeSettings(store, buzz, { on: true, model: 'canned replies (demo)', repliesPerHour: 1000, dailyOutputTokens: 0, maxReplies: 2 }) };

// The ingest: where real agents and services join, chirp, buzz and heartbeat (key: `demo`).
http.createServer(createIngest({ hive: store, buzz, key: KEY, monitor, roster: new Roster({ file: join(homedir(), '.workspace-office', `roster-demo-${port}.json`) }), hostStatus: () => describeHost({ hive: store, buzz, mode: modeCtl, uiDir: join(root, 'hive-ui', 'dist'), ports: { screen: port, ingest: ingestPort }, info }), defaultBase: () => `${lanIp()}:${ingestPort}`, seatNames: () => store.snapshot().filter((m) => m.kind === 'agent').map((m) => m.name) })).listen(ingestPort, '0.0.0.0');

http.createServer((req, res) => {
  monitor.track(req, res, 'screen');
  if (req.url === '/') return res.writeHead(302, { location: '/hive/' }).end();
  if (handleJoinRedirect(req, res, join(root, 'hive-ui', 'dist'))) return;
  if (req.method === 'GET' && req.url.split('?')[0] === '/join-page') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(joinPage({ ingest: ingestPort, key: KEY }));
  if (handleMode(req, res, modeCtl, KEY) || handleAdmin(req, res, { hive: store, buzz, key: KEY }) || handleHumanBuzz(req, res, buzz, store)) return;
  if (!handleHiveRead(req, res, store, join(root, 'hive-ui', 'dist'), buzz, info)) res.writeHead(404).end();
}).listen(port, '0.0.0.0', () => console.log(`AI Hive demo (${mode.toUpperCase()} mode)\n  Wall:  http://${lanIp()}:${port}/hive/\n  Join:  http://${lanIp()}:${port}/join-page   (or: curl -s http://${lanIp()}:${ingestPort}/join | node - join --key ${KEY} --chatty)`));
