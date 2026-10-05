// The service buzz convention: a service that writes  <ai-hive-buzz>50% complete</ai-hive-buzz>  anywhere in its logs (or in a heartbeat's
// message) has that text posted in Hive Chat, as a host line marked with 🤖 and the service's name. It lets whoever writes a service
// choose what the whole hive hears ("migration 50% complete", "nightly build finished") without any other plumbing.
//
//   service stdout/log file ──► hive heartbeat --follow <file> | --stdin ──► POST /api/heartbeat { buzz: [...] } ──► Hive Chat
//   or any HTTP client:  POST /api/heartbeat { id, buzz: ["50% complete"] }  (a tag inside `message` or `logs` works too)
//
// Lines are plain text, one tag = one line, capped in length and in number, and each service has an hourly allowance so a loop that logs the
// tag a thousand times cannot flood the chat. They are host lines (kind 'system'): they invite nobody to answer and cannot be mistaken for an agent.

export const TAG = /<ai-hive-buzz>([\s\S]*?)<\/ai-hive-buzz>/gi;
export const MARK = '🤖';
export const BUZZ_LIMITS = { maxLines: 5, maxChars: 280, perHour: 30 };

/** Tidy one tagged text into a chat line: no markup left inside, one line, trimmed and clipped. '' when nothing is left. */
export function cleanBuzz(text, maxChars = BUZZ_LIMITS.maxChars) {
  const t = String(text ?? '').replace(/<\/?ai-hive-buzz>/gi, '').replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1).trimEnd()}…` : t;
}

/** Every tagged line in a block of log text, in order. Pure. `<ai-hive-buzz>` without its closing tag, or with nothing inside, is ignored. */
export function extractBuzz(text, { maxLines = BUZZ_LIMITS.maxLines } = {}) {
  const out = [];
  for (const m of String(text ?? '').matchAll(TAG)) {
    const line = cleanBuzz(m[1]);
    if (line) out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

/** The lines to post for a heartbeat body: its explicit `buzz` array (strings), plus any tags found in its `message` and `logs` text. Deduplicated. */
export function buzzFromHeartbeat(body, limits = BUZZ_LIMITS) {
  const lines = [];
  if (Array.isArray(body?.buzz)) for (const l of body.buzz) { if (typeof l === 'string') { const c = cleanBuzz(l, limits.maxChars); if (c) lines.push(c); } }
  for (const k of ['message', 'logs']) if (typeof body?.[k] === 'string') lines.push(...extractBuzz(body[k], limits));
  return [...new Set(lines)].slice(0, limits.maxLines);
}

/**
 * Posts a service's buzz lines into the chat, within its allowance. `buzz` is the BuzzLog; `from` the service's display name.
 * -> { posted, dropped }. A line identical to the service's previous one is not repeated (a loop re-logging "50% complete" says it once).
 */
export function createServiceBuzz({ buzz, now = Date.now, ...config }) {
  const cfg = { ...BUZZ_LIMITS, ...config };
  const sent = new Map(); // service id -> timestamps this hour
  const last = new Map(); // service id -> its previous line
  return function post(id, from, lines) {
    const t = now();
    const mine = (sent.get(id) ?? []).filter((at) => t - at < 3_600_000);
    let posted = 0, dropped = 0;
    for (const line of lines) {
      if (last.get(id) === line) { dropped++; continue; }
      if (mine.length >= cfg.perHour) { dropped++; continue; }
      const r = buzz.post({ from: `${MARK} ${from}`, kind: 'system', text: line });
      if (!r.ok) { dropped++; continue; }
      mine.push(t); last.set(id, line); posted++;
    }
    sent.set(id, mine);
    return { posted, dropped };
  };
}
