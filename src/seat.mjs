import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = join(process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'seats');
const file = (name) => join(dir, `${name.replace(/[^\w.-]/g, '_')}.json`);

/** A seat is the durable identity of one agent in the hive. `cwd` carries the seat's display name (`/office/<Name>`),
 *  which is how the host knows which seat an event belongs to. */
export function createSeat({ url, token, name, project, chatty = false, hooks, model, user, slot }) {
  const seat = { ...(model ? { model } : {}), ...(user ? { user } : {}), ...(slot ? { slot } : {}), name, url: url.replace(/\/$/, ''), token, project, chatty, hooks, sessionId: `office-${name}-${randomBytes(4).toString('hex')}`, cwd: `/office/${name}` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(name), JSON.stringify(seat, null, 2), { mode: 0o600 });
  return seat;
}

export const pidFile = (name) => join(dir, `${name.replace(/[^\w.-]/g, '_')}.watch.pid`);

/** Stops a background `office watch` started for this seat, if any. */
export function killWatcher(name) {
  try { process.kill(Number(readFileSync(pidFile(name), 'utf8'))); } catch { /* not running */ }
  rmSync(pidFile(name), { force: true });
}

export function removeSeat(name) {
  killWatcher(name);
  rmSync(file(name), { force: true });
}

/** Resolution order: explicit name → $HIVE_SEAT (or $OFFICE_SEAT) → the most recently joined seat. */
export function loadSeat(name = process.env.HIVE_SEAT ?? process.env.OFFICE_SEAT) {
  if (name) return JSON.parse(readFileSync(file(name), 'utf8'));
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  if (!files.length) throw new Error('no seat — run `hive join <host[:port]> <name>` first');
  const newest = files.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return JSON.parse(readFileSync(newest, 'utf8'));
}

// One folder can hold several seats (a second `hive join` there adds one), but the tool's hooks live in one shared
// project file that names only one of them. So each window (its session id) is bound to a seat of its own, and only
// the window that closes takes its seat away.
const bindDir = join(dir, '..', 'sessions');
const bindFile = (sid) => join(bindDir, `${String(sid).replace(/[^\w.-]/g, '_')}.json`);
const BIND_TTL = 24 * 3600_000; // a window that vanished without a SessionEnd (crash) frees its seat after a day

function bindings() {
  let files;
  try { files = readdirSync(bindDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const b = JSON.parse(readFileSync(join(bindDir, f), 'utf8'));
      if (Date.now() - b.at > BIND_TTL) rmSync(join(bindDir, f), { force: true }); else out.push(b);
    } catch { /* unreadable: ignore */ }
  }
  return out;
}

/** The seat this window (session id) speaks as: the one it is already bound to, else a free seat of this folder's project
 *  (the one named in the hook command if it is free), else that named seat shared. */
export function seatForSession(sid, project, preferred) {
  const seatNames = () => { try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
  const load = (n) => { try { return JSON.parse(readFileSync(file(n), 'utf8')); } catch { return null; } };
  const mine = sid ? bindings().find((b) => b.sid === sid) : null;
  const bound = mine && load(mine.seat);
  if (bound) { writeBinding(sid, bound.name); return bound; }
  const taken = new Set(bindings().filter((b) => b.sid !== sid).map((b) => b.seat));
  const fallback = load(preferred ?? '') ?? loadSeat(preferred);
  const free = [preferred, ...seatNames()].map((n) => n && load(n)).filter((s) => s && s.project === fallback.project && s.hooks?.includes('claude') && !taken.has(s.name));
  const seat = free[0] ?? fallback;
  if (sid) writeBinding(sid, seat.name);
  return seat;
}

function writeBinding(sid, seat) {
  mkdirSync(bindDir, { recursive: true });
  writeFileSync(bindFile(sid), JSON.stringify({ sid, seat, at: Date.now() }));
}

/** A window closed. True when its seat is now empty (no other window speaks as it), so the seat may leave. */
export function releaseSession(sid, seatName) {
  if (sid) rmSync(bindFile(sid), { force: true });
  return !bindings().some((b) => b.seat === seatName);
}
