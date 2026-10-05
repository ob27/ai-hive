// A real hive for one worker: the real host (`hive host`: routes, store, ingest, crew, bee, bots and screen) on free ports, with its own home so nothing
// it writes (seats, roster, production, hook files) can touch your real ~/.workspace-office or any project's hook settings.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../bin/office.mjs', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().unref().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the model API the host's bots call (HIVE_MODEL_URL): records every prompt and answers from `reply`. */
async function startModelStub() {
  const stub = { requests: [], failing: false, delayMs: 0, reply: ({ name }) => `Stub reply from ${name}.` };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const name = /You are (\S+?),/.exec(body.system ?? '')?.[1] ?? 'bot';
      stub.requests.push({ name, system: body.system, user: body.messages?.[0]?.content, at: Date.now() });
      if (stub.delayMs) await sleep(stub.delayMs);
      if (stub.failing) return res.writeHead(500).end('{}');
      const text = stub.reply({ name, system: body.system, user: body.messages?.[0]?.content });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text }], usage: { output_tokens: 20 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${server.address().port}/v1/messages`;
  stub.close = () => server.close();
  return stub;
}

/**
 * options: key; model (true = the host's bots answer, from a stub model); prefillKey; tuning ({ hive, buzz, crew, bee, responder }: shorter waits,
 * passed to the host as HIVE_TUNING). Everything is the REAL host (`hive host`): crew, bee, responder, admin, roster and all.
 */
export async function startHive({ key = 'harness-key', model = false, prefillKey = false, tuning = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hive-harness-'));
  const hiveHome = join(home, '.workspace-office');
  mkdirSync(hiveHome, { recursive: true });
  writeFileSync(join(hiveHome, 'host.json'), JSON.stringify({ key, prefillKey }));
  const [port, ingestPort] = [await freePort(), await freePort()];
  const stub = model ? await startModelStub() : null;
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, HIVE_HOME: hiveHome, OFFICE_HOME: hiveHome, HIVE_SEAT: '', OFFICE_SEAT: '',
    ANTHROPIC_API_KEY: stub ? 'stub-key' : '', HIVE_TUNING: JSON.stringify(tuning), ...(stub ? { HIVE_MODEL_URL: stub.url } : {}),
  };
  if (!stub) delete env.ANTHROPIC_API_KEY;
  let child = null;
  const hive = {
    home, key, port, ingestPort, env, model: stub,
    tracked: [], children: [], markId: 0,
    /** From now on `buzz()` shows only lines after this one (a worker's thread is shared by its tests). */
    async mark() { const all = await (await fetch(`${hive.base}/hive/buzz`)).json(); hive.markId = all.at(-1)?.id ?? 0; },
    /** Between tests: kill any listen still waiting and stand every fake agent up (`hive leave`), so one test's agents never answer the next one's chat. */
    async cleanup() {
      for (const c of hive.children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
      for (const a of hive.tracked.splice(0)) { try { await a.leave(); } catch { /* already gone */ } }
    },
    base: `http://127.0.0.1:${port}`,
    ingest: `127.0.0.1:${ingestPort}`,
    /** A project folder to run an agent in (`hive join` writes the tool's hook file into the current folder, so each agent gets its own). */
    project(name) { const d = join(home, 'projects', name); mkdirSync(d, { recursive: true }); return d; },
    async start() {
      child = spawn('node', [CLI, 'host', '--port', String(port), '--ingest', String(ingestPort)], { env, stdio: 'ignore' });
      for (let i = 0; i < 150; i++) { if ((await fetch(`${hive.base}/hive/state`).catch(() => null))?.ok) return hive; await sleep(100); }
      child.kill(); throw new Error('the harness hive did not start');
    },
    /** Stop and start the host again: its in-memory thread restarts at line 1, as in production. Seats and files survive. */
    async restart() { await hive.kill(); hive.markId = 0; return hive.start(); },
    /** A fresh host process (empty thread, caps, crew notes) for a spec whose tests must not see each other's state. Seats and files survive. */
    async fresh() { await hive.cleanup(); await hive.restart(); await hive.mark(); },
    async kill() { if (!child) return; const c = child; child = null; c.kill(); await new Promise((r) => c.once('exit', r)); },
    async stop() { await hive.kill(); stub?.close(); rmSync(home, { recursive: true, force: true }); },
    /** The wall as JSON: what the screen is fed. */
    async state() { return (await fetch(`${hive.base}/hive/state`)).json(); },
    async member(name) { return (await hive.state()).find((m) => m.name === name); },
    async buzz() { return (await (await fetch(`${hive.base}/hive/buzz`)).json()).filter((m) => m.id > hive.markId); },
    /** A person types into the wall's chat box. */
    async say(text, name = 'Human', replyTo) { return fetch(`${hive.base}/hive/buzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text, replyTo }) }); },
    /** The cog's admin actions (boot, listen). */
    async admin(action, id, by) { return fetch(`${hive.base}/hive/admin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id, key, by }) }); },
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
  hive.children.push(child);
  const done = new Promise((resolve) => { let stdout = ''; child.stdout.on('data', (d) => { stdout += d; }); child.on('close', (code) => resolve({ code, stdout })); });
  return { child, done };
}
export const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(50); } return v; };
export { sleep };
