// Agents with no hooks at all: `hive run` (a wrapped command) and `hive proxy` (a model behind a reporting proxy).
import http from 'node:http';
import { test, expect } from './harness/fixtures.mjs';
import { runCli, spawnCli, until } from './harness/hive.mjs';

const join = (hive, name) => runCli(hive, ['join', hive.ingest, name, '--key', hive.key], { cwd: hive.project(name) });

test('hive run: a wrapped command shows as working while it prints, its exit code is passed on, and its seat leaves when it ends', async ({ hive, wall }) => {
  await join(hive, 'Runner');
  const script = 'console.log("crawling the planning site"); setTimeout(() => process.exit(3), 2500)';
  const p = runCli(hive, ['run', 'Runner', '--', process.execPath, '-e', script], { cwd: hive.project('Runner') });
  await wall.expectStatus('Runner', 'Active Now');
  await wall.expectText('Runner', /crawling the planning site/);
  const r = await p;
  expect(r.code).toBe(3);
  expect(r.stdout).toContain('crawling the planning site'); // the child's output still reaches the terminal
  await wall.expectGone('Runner');
});

test('hive proxy: a model behind it shows as thinking, then as the tool it called, then idle, without the model cooperating', async ({ hive, wall }) => {
  let reply = { choices: [{ message: { tool_calls: [{ function: { name: 'run_shell_command', arguments: '{"command":"pnpm test"}' } }] } }] };
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)), 1500)); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const net = await import('node:net');
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  try {
    await join(hive, 'Proxied');
    const proxy = spawnCli(hive, ['proxy', 'Proxied', '--listen', String(free), '--target', `http://127.0.0.1:${upstream.address().port}/v1`], { cwd: hive.project('Proxied') });
    // wait for the port to accept connections WITHOUT sending a request: a request would go through the proxy and count as a model call
    await until(() => new Promise((r) => { const c = net.connect(free, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); }), 8000);
    const call = () => fetch(`http://127.0.0.1:${free}/chat/completions`, { method: 'POST', body: '{}' }).then((r) => r.text());
    const pending = call();
    await wall.expectText('Proxied', /thinking/);
    expect(await pending).toMatch(/run_shell_command/); // passed through untouched
    await wall.expectText('Proxied', /pnpm test/);
    reply = { choices: [{ message: { content: 'All done.' } }] };
    await call();
    await wall.expectStatus('Proxied', 'Idle');
    proxy.child.kill();
  } finally { upstream.close(); }
});
