// One POST per event to the hive's ingest. Never throws into the caller's agent loop:
// a down office server must not break the agent doing real work.
let pendingNotice = null;
/** What the host sent back on the last event, if anything for the agent to read (a tap on the shoulder, or news that it was removed). Taken once. */
export function takePendingNotice() { const n = pendingNotice; pendingNotice = null; return n; }

export async function send(seat, payload, { quiet = true, joining = false } = {}) {
  try {
    const res = await fetch(`${seat.url}/api/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${seat.token}` },
      // `hive.project` is for the Hive wall only; the host reads it and does not pass it on.
      body: JSON.stringify(seat.project ? { ...payload, hive: { project: seat.project, chatty: seat.chatty === true, ...(seat.model ? { model: seat.model } : {}), ...(seat.user ? { user: seat.user } : {}), ...(seat.slot ? { slot: seat.slot } : {}), ...(joining ? { joining: true } : {}), ...(Array.isArray(seat.hooks) ? { hooks: seat.hooks } : {}) } } : payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`office server answered ${res.status}`);
    if ((res.headers.get('content-type') ?? '').includes('json')) { const b = await res.json().catch(() => null); if (typeof b?.notice === 'string') pendingNotice = b.notice; }
    return true;
  } catch (err) {
    if (!quiet) console.error(`hive: ${err.message}`);
    return false;
  }
}

/** `hive buzz`: say a line in the Hive's chat. { ok } or { ok: false, error }. Never throws. */
export async function postBuzz(seat, text, replyTo) {
  try {
    const res = await fetch(`${seat.url}/api/buzz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${seat.token}` },
      body: JSON.stringify({ name: seat.name, text, ...(replyTo ? { replyTo } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error ?? `the hive answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The recent buzz, oldest first. { ok, messages } or { ok: false, error }. */
export async function readBuzz(seat, limit = 20) {
  try {
    const res = await fetch(`${seat.url}/buzz?limit=${limit}`, { headers: { authorization: `Bearer ${seat.token}` }, signal: AbortSignal.timeout(3000) });
    return res.ok ? { ok: true, messages: await res.json() } : { ok: false, error: `the hive answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Waits up to `waitSec` for buzz lines after `afterId` that `seat` did not write. { ok, messages } (empty on timeout). */
export async function listenBuzz(seat, afterId, waitSec) {
  try {
    const res = await fetch(`${seat.url}/buzz?after=${afterId}&wait=${waitSec}&as=${encodeURIComponent(seat.name)}`, { headers: { authorization: `Bearer ${seat.token}` }, signal: AbortSignal.timeout((waitSec + 10) * 1000) });
    return res.ok ? { ok: true, messages: await res.json() } : { ok: false, error: `the hive answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** `hive join`: ask the host for this project's next free place in its cast. { slot, name, project }, or null (older host, or no roster). */
export async function claimSeat(url, key, project, name) {
  try {
    const res = await fetch(`${url}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ project, ...(name ? { name } : {}) }), signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Names currently seated, per the host. Null when the host can't be asked (older host, network). */
export async function listSeats(url, key) {
  try {
    const res = await fetch(`${url}/seats`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
    return res.ok ? new Set(await res.json()) : null;
  } catch {
    return null;
  }
}
