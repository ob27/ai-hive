// A real hive for one test file: the demo host (the real routes, store, ingest and screen) on free ports, with its own home so nothing
// it writes (seats, roster, production, hook files) can touch your real ~/.workspace-office or any project's hook settings.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../bin/office.mjs', import.meta.url));
const DEMO = fileURLToPath(new URL('../../scripts/hive-demo.mjs', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().unref().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startHive({ key = 'harness-key', mode = 'work' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hive-harness-'));
  const hiveHome = join(home, '.workspace-office');
  const [port, ingestPort] = [await freePort(), await freePort()];
  const env = { ...process.env, HOME: home, USERPROFILE: home, HIVE_HOME: hiveHome, OFFICE_HOME: hiveHome, HIVE_DEMO_KEY: key, HIVE_SEAT: '', OFFICE_SEAT: '' };
  let child = null;
  const hive = {
    home, key, port, ingestPort, env,
    base: `http://127.0.0.1:${port}`,
    ingest: `127.0.0.1:${ingestPort}`,
    /** A project folder to run an agent in (`hive join` writes the tool's hook file into the current folder, so each agent gets its own). */
    project(name) { const d = join(home, 'projects', name); mkdirSync(d, { recursive: true }); return d; },
    async start() {
      child = spawn('node', [DEMO, '--port', String(port), '--ingest', String(ingestPort), `--${mode}`], { env, stdio: 'ignore' });
      for (let i = 0; i < 150; i++) { if ((await fetch(`${hive.base}/hive/state`).catch(() => null))?.ok) return hive; await sleep(100); }
      child.kill(); throw new Error('the harness hive did not start');
    },
    /** Stop and start the host again: its in-memory thread restarts at line 1, as in production. Seats and files survive. */
    async restart() { await hive.kill(); return hive.start(); },
    async kill() { if (!child) return; const c = child; child = null; c.kill(); await new Promise((r) => c.once('exit', r)); },
    async stop() { await hive.kill(); rmSync(home, { recursive: true, force: true }); },
    /** The wall as JSON: what the screen is fed. */
    async state() { return (await fetch(`${hive.base}/hive/state`)).json(); },
    async member(name) { return (await hive.state()).find((m) => m.name === name); },
    async buzz() { return (await fetch(`${hive.base}/hive/buzz`)).json(); },
    async say(text, name = 'Human', replyTo) { return fetch(`${hive.base}/hive/buzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text, replyTo }) }); },
  };
  return hive;
}

/** Run the hive CLI like a user would: in a project folder, against this hive's home. A non-zero exit is a result, not a throw. */
export function runCli(hive, args, { cwd = hive.home, input, env = {}, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: { ...hive.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    resolve.child = child;
  });
}
/** Like runCli but hands back the child too, to kill it mid-run (an agent that dies). */
export function spawnCli(hive, args, { cwd = hive.home, env = {} } = {}) {
  const child = spawn('node', [CLI, ...args], { cwd, env: { ...hive.env, ...env } });
  const done = new Promise((resolve) => { let stdout = ''; child.stdout.on('data', (d) => { stdout += d; }); child.on('close', (code) => resolve({ code, stdout })); });
  return { child, done };
}
export const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(50); } return v; };
export { sleep };
