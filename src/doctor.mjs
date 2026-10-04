// `hive status`: is the hive working, and if not, what is wrong and what do I do. It checks from the OUTSIDE, the way a browser or an
// agent would, so it works against any host, including one too old to report on itself (that is the very case that is hardest to
// see: an old host answers every Hive address with a web page, and nothing says "I am out of date").
//
// Each check is { id, label, state: 'ok' | 'warn' | 'fail', detail, fix? }. `diagnose` turns the failures into plain advice.
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { newestChange, snapshotFiles } from './monitor.mjs';

const OK = 'ok', WARN = 'warn', FAIL = 'fail';

async function get(url, { key, timeout = 4000, redirect = 'follow' } = {}) {
  try {
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeout), redirect });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: true, status: res.status, text, json, location: res.headers.get('location'), type: res.headers.get('content-type') ?? '' };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.cause?.code ?? err.message };
  }
}

/** First `data:` event of the wall's stream within a few seconds (or why not). */
async function firstEvent(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('event-stream')) return { ok: false, error: `answered ${res.status} ${res.headers.get('content-type') ?? ''}`.trim() };
    const reader = res.body.getReader();
    let text = '';
    const end = Date.now() + 3500;
    while (!text.includes('data:') && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    await reader.cancel().catch(() => undefined);
    return text.includes('data:') ? { ok: true } : { ok: false, error: 'connected but sent nothing' };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || Object.values(networkInterfaces()).flat().some((i) => i && i.address === host);

/** For a host on THIS machine: who is listening, since when, and whether the code on disk has changed since. Best effort (macOS/Linux). */
function localProcess(port) {
  try {
    const pid = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
    if (!pid) return null;
    const started = new Date(execSync(`ps -o lstart= -p ${pid}`, { encoding: 'utf8' }).trim());
    const command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim();
    const script = command.split(/\s+/).find((t) => /office\.mjs$|hive-demo\.mjs$/.test(t));
    let changedAt = null, root = null;
    if (script) {
      const real = realpathSync(script);
      root = resolve(dirname(real), real.endsWith('hive-demo.mjs') ? '..' : '..');
      changedAt = newestChange(snapshotFiles(root));
    }
    return { pid: Number(pid), started: started.getTime(), command, root, changedAt };
  } catch {
    return null;
  }
}

/**
 * @param {{ host: string, ingest?: number, screen?: number, key?: string }} target
 * @returns {Promise<{ checks: object[], diagnosis: string[], status: object | null, local: object | null }>}
 */
export async function runChecks({ host, ingest = 3101, screen = 3100, key }) {
  const checks = [];
  const add = (id, label, state, detail, fix) => checks.push({ id, label, state, detail, ...(fix ? { fix } : {}) });
  const S = `http://${host}:${screen}`, I = `http://${host}:${ingest}`;

  const health = await get(`${I}/health`);
  if (health.ok && health.text.trim() === 'ok') add('ingest', 'Agents can reach the hive (ingest)', OK, `${I}/health answers ok`);
  else add('ingest', 'Agents can reach the hive (ingest)', FAIL, health.ok ? `${I}/health answered ${health.status}` : `nothing answers at ${I} (${health.error})`, 'Start the host: hive host (or node scripts/hive-demo.mjs for the demo). If it is running, check the ports and the firewall.');

  const root = await get(`${S}/`);
  if (root.ok && root.status < 400) add('screen', 'The screen port answers', OK, `${S}/ answers ${root.status}`);
  else add('screen', 'The screen port answers', FAIL, root.ok ? `${S}/ answered ${root.status}` : `nothing answers at ${S} (${root.error})`, `Is the screen on port ${screen}? Use --screen <port> (the demo uses 3200).`);

  const state = await get(`${S}/hive/state`);
  const hasHive = state.ok && Array.isArray(state.json);
  if (hasHive) add('data', 'The Hive wall data is served', OK, `/hive/state is JSON with ${state.json.length} member${state.json.length === 1 ? '' : 's'}`);
  else if (state.ok && /html/i.test(state.type)) add('data', 'The Hive wall data is served', FAIL, '/hive/state answers with a web page, not data: this host does not have the Hive code (it was started before the Hive was added, or without it)', 'Restart the host so it loads the current code.');
  else add('data', 'The Hive wall data is served', FAIL, state.ok ? `/hive/state answered ${state.status}` : `could not fetch /hive/state (${state.error})`, 'Restart the host.');

  const ui = await get(`${S}/hive/`);
  if (ui.ok && ui.status === 200 && /<title>AI Hive/.test(ui.text)) add('ui', 'The Hive screen is built and served', OK, '/hive/ serves the AI Hive page');
  else if (ui.ok && ui.status === 503) add('ui', 'The Hive screen is built and served', FAIL, 'the host is current but the screen is not built', 'cd hive-ui && pnpm install && pnpm build');
  else if (hasHive) add('ui', 'The Hive screen is built and served', FAIL, ui.ok ? `/hive/ answered ${ui.status} without the AI Hive page` : `could not fetch /hive/ (${ui.error})`, 'cd hive-ui && pnpm install && pnpm build');
  else add('ui', 'The Hive screen is built and served', FAIL, 'not available (see the line above)');

  const stream = hasHive ? await firstEvent(`${S}/hive/stream`) : { ok: false, error: 'skipped: no Hive data' };
  add('stream', 'The live stream sends the wall', stream.ok ? OK : hasHive ? FAIL : WARN, stream.ok ? 'the first snapshot arrived' : stream.error, hasHive ? 'A proxy or firewall may be buffering streams.' : undefined);

  const mode = await get(`${S}/hive/mode`);
  if (mode.ok && mode.json?.mode) add('mode', 'Board mode', OK, `${mode.json.mode.toUpperCase()}${mode.json.mode === 'work' ? ' (only real agents and services are shown)' : ' (simulated bees are on the wall)'}`);
  else add('mode', 'Board mode', hasHive ? WARN : WARN, 'not available (an older host has no Demo/Work mode)');

  const buzz = await get(`${S}/hive/buzz`);
  add('buzz', 'The buzz thread is served', buzz.ok && Array.isArray(buzz.json) ? OK : WARN, buzz.ok && Array.isArray(buzz.json) ? `${buzz.json.length} line${buzz.json.length === 1 ? '' : 's'}` : 'not available (an older host has no buzz)');

  const join = await get(`${S}/join-page`, { redirect: 'manual' });
  if (join.ok && join.status === 302 && /\/hive\/join/.test(join.location ?? '')) add('join', 'The Join page', OK, '/join-page opens the Join page in the Hive screen');
  else if (join.ok && join.status === 200 && /Join the hive/.test(join.text)) add('join', 'The Join page', WARN, 'serves the plain fallback page (the screen is not built)', 'cd hive-ui && pnpm install && pnpm build');
  else if (join.ok && join.status === 200 && /Join the office/.test(join.text)) add('join', 'The Join page', WARN, 'serves the OLD "Join the office" page: this host is running old code', 'Restart the host.');
  else add('join', 'The Join page', WARN, join.ok ? `/join-page answered ${join.status}` : `could not fetch /join-page (${join.error})`);

  let status = null;
  if (key) {
    const st = await get(`${I}/api/status`, { key });
    if (st.ok && st.status === 200 && st.json) {
      status = st.json;
      add('status', 'The host reports on itself', OK, `up ${Math.round(status.uptimeSec / 60)} min, ${status.requests.total} requests served, ${status.memoryMB} MB`);
      if (status.code?.stale) add('code', 'The host is running the current code', FAIL, `${status.code.changedSinceStart.length} file${status.code.changedSinceStart.length === 1 ? '' : 's'} changed since it started: ${status.code.changedSinceStart.slice(0, 4).join(', ')}`, 'Restart the host so it loads the changes.');
      else add('code', 'The host is running the current code', OK, 'nothing has changed on disk since it started');
      const errs = status.errors ?? [];
      add('errors', 'No recent server errors', errs.length ? WARN : OK, errs.length ? `${errs.length} recent: ${errs[errs.length - 1].text.slice(0, 120)}` : 'none logged', errs.length ? 'hive logs shows them in full.' : undefined);
    } else if (st.ok && st.status === 401) add('status', 'The host reports on itself', FAIL, 'the key was not accepted', 'Check --key (or HIVE_KEY); `hive host` prints the right one.');
    else add('status', 'The host reports on itself', WARN, 'no /api/status: this host predates the monitor', 'Restart the host to get `hive status` details and `hive logs`.');
    const bz = await get(`${I}/buzz`, { key });
    if (bz.ok && bz.status === 404) add('keyedbuzz', 'Agents can read the buzz', WARN, '/buzz is missing on this host: it predates buzz, so `hive buzz` will not work for agents', 'Restart the host.');
  } else {
    add('status', 'The host reports on itself', WARN, 'skipped: no key given (use --key, HIVE_KEY, or join first)');
  }

  const local = isLocal(host) ? localProcess(ingest) : null;
  if (local) {
    const at = (t) => new Date(t).toLocaleString();
    if (local.changedAt && local.changedAt > local.started + 2000) add('process', 'The running process is current', FAIL, `pid ${local.pid} started ${at(local.started)}, but its code changed ${at(local.changedAt)}: it is running old code`, `Restart it: kill ${local.pid}, then start the host again.`);
    else add('process', 'The running process is current', OK, `pid ${local.pid} started ${at(local.started)}${local.changedAt ? ' and the code has not changed since' : ''}`);
  }

  // Several checks end in "restart it": say it once, first, with the exact command when the host is on this machine.
  const diagnosis = [];
  const fixes = [...checks.filter((c) => c.state === FAIL), ...checks.filter((c) => c.state === WARN)].map((c) => c.fix).filter(Boolean);
  if (fixes.some((f) => /^Restart/.test(f))) {
    diagnosis.push(`Restart the host so it loads the current code${local ? `: stop it (kill ${local.pid}) and start it again (hive host)` : ''}.`);
  }
  for (const f of fixes) if (!/^Restart/.test(f) && !diagnosis.includes(f)) diagnosis.push(f);
  // Members worth explaining: anything not simply working, and anyone who is not reporting its activity.
  if (status?.members?.list) {
    for (const m of status.members.list) {
      if (m.kind === 'agent' && m.reports === 'chirps') diagnosis.push(`${m.name} joined without hooks, so its real activity is not reported (it will look idle). Rejoin it with --claude (or its tool's flag).`);
      if (m.status === 'stalled') diagnosis.push(`${m.name} is stalled: ${m.reason}`);
    }
  }
  return { checks, diagnosis, status, local };
}

/** The checks as text. */
export function render(result, { host, color = false, members = false } = {}) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗') };
  const lines = [`AI Hive: checking ${host}`, ''];
  for (const c of result.checks) lines.push(` ${mark[c.state]} ${c.label}${c.detail ? paint(2, `  ${c.detail}`) : ''}`);
  const s = result.status;
  if (s) {
    lines.push('', `Board: ${s.mode?.toUpperCase()} mode, ${s.members.total} member${s.members.total === 1 ? '' : 's'} (${Object.entries(s.members.byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}), ${s.buzz.lines} buzz lines, ${s.subscribers.wall} stream${s.subscribers.wall === 1 ? '' : 's'} open.`);
    const shown = s.members.list.filter((m) => members || (m.status !== 'active' && m.status !== 'idle') || m.reports === 'chirps');
    for (const m of shown) lines.push(`  ${m.name} (${m.kind}) ${m.label}: ${m.reason}`);
    if (!members && shown.length < s.members.list.length) lines.push(paint(2, `  (${s.members.list.length - shown.length} more working normally: --members lists everyone)`));
  }
  lines.push('');
  if (result.diagnosis.length) {
    lines.push('What to do:');
    result.diagnosis.forEach((d, i) => lines.push(` ${i + 1}. ${d}`));
  } else lines.push(paint(32, 'Everything checks out.'));
  return lines.join('\n');
}
