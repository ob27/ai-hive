// One POST per event to the Pixel Agents server. Never throws into the caller's agent loop:
// a down office server must not break the agent doing real work.
export async function send(seat, payload, { quiet = true } = {}) {
  try {
    const res = await fetch(`${seat.url}/api/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${seat.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`office server answered ${res.status}`);
    return true;
  } catch (err) {
    if (!quiet) console.error(`office: ${err.message}`);
    return false;
  }
}
