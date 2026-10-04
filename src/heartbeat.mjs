// `office heartbeat`: a service tells the Hive it is alive (or in trouble). Same shared key as seats.
// Never throws into the caller: a down Hive must not break the service reporting to it.
export async function postHeartbeat(url, key, body) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    let error = text;
    try { error = JSON.parse(text).error ?? text; } catch { /* plain text */ }
    return { ok: false, error: `the Hive answered ${res.status}${error ? `: ${error}` : ''}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The request body for the CLI's flags. */
export function heartbeatBody({ id, name, project, status, message, ttl, metrics }) {
  const body = { id, status: status ?? 'ok' };
  if (name) body.name = name;
  if (project) body.project = project;
  if (message) body.message = message;
  if (ttl !== undefined) body.ttlSec = Number(ttl);
  if (metrics && Object.keys(metrics).length) body.metrics = metrics;
  return body;
}

// --- `hive heartbeat --logs`: let the service's message be the host's own log tail ---------------------------------------------------------------
// The host keeps its recent requests and console output (monitor.mjs, GET /api/logs). Most of it is noise from the wall itself (the screen polling,
// the heartbeat posting every 30 s), so the summary skips that and shows the latest line that means something: a join, a buzz, an admin action, an
// agent's hook, anything the host printed. A server error or a console error makes the service Degraded.
const NOISE = /POST \/api\/heartbeat|GET \/hive\/(state|stream|production|mode|join-info|info|buzz|buzz\/stream)(\?|\s|$)|GET \/hive\/(assets|favicon|aihive|apple)|GET \/hive\/? |GET \/health|GET \/(api\/status|api\/logs|favicon)/;
const hhmmss = (at) => new Date(at).toTimeString().slice(0, 8);
const ago = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`);

/** Entries are { id, at, kind, text } from /api/logs. `last` is the latest meaningful entry seen on an earlier beat. -> { status, message, last } */
export function logSummary(entries, last = null, now = Date.now()) {
  const meaningful = entries.filter((e) => e.kind !== 'req' || !NOISE.test(e.text));
  const bad = [...entries].reverse().find((e) => e.kind === 'error' || (e.kind === 'req' && /-> 5\d\d\b/.test(e.text)));
  const latest = meaningful.at(-1) ?? last;
  const clip = (s) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > 200 ? `${s.slice(0, 199)}…` : s; }; // one line: the host's startup banner is several
  if (bad) return { status: 'degraded', message: clip(`${hhmmss(bad.at)} ${bad.text}`), last: latest };
  if (!latest) return { status: 'ok', message: 'running, no activity yet', last: null };
  const fresh = meaningful.length > 0;
  return { status: 'ok', message: clip(`${hhmmss(latest.at)} ${latest.text}${fresh ? '' : ` (${ago(now - latest.at)} ago)`}`), last: latest };
}
