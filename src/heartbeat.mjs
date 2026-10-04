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
export function heartbeatBody({ id, name, project, status, message, ttl }) {
  const body = { id, status: status ?? 'ok' };
  if (name) body.name = name;
  if (project) body.project = project;
  if (message) body.message = message;
  if (ttl !== undefined) body.ttlSec = Number(ttl);
  return body;
}
