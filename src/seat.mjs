import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 *  (the one named in the hook command if it is free), else that named seat shared. Two windows starting at the same instant can both
 *  see one seat free, so a seat is taken by creating its claim file exclusively: only one window can create it. */
export function seatForSession(sid, project, preferred) {
  const seatNames = () => { try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
  const load = (n) => { try { return JSON.parse(readFileSync(file(n), 'utf8')); } catch { return null; } };
  const mine = sid ? bindings().find((b) => b.sid === sid) : null;
  const bound = mine && load(mine.seat);
  if (bound) { writeBinding(sid, bound.name); return bound; }
  const fallback = load(preferred ?? '') ?? loadSeat(preferred);
  const lost = new Set(); // seats another window claimed first
  for (let attempt = 0; attempt < 6; attempt++) {
    const taken = new Set([...bindings().filter((b) => b.sid !== sid).map((b) => b.seat), ...lost]);
    const seat = [preferred, ...seatNames()].map((n) => n && load(n)).filter((s) => s && s.project === fallback.project && s.hooks?.includes('claude') && !taken.has(s.name))[0];
    if (!seat) break;
    if (!sid) return seat;
    if (claim(seat.name, sid)) { writeBinding(sid, seat.name); return seat; }
    lost.add(seat.name);
  }
  if (sid) writeBinding(sid, fallback.name); // no free seat: share the named one
  return fallback;
}

const claimFile = (seat) => join(bindDir, `${String(seat).replace(/[^\w.-]/g, '_')}.claim`);

/** Try to be the one window on `seat`. Creating the file exclusively is atomic, so of two windows exactly one succeeds. A claim whose window has no
 *  binding (it closed, or crashed before binding) is stale and is taken over; a very fresh one is a window about to bind. */
function claim(seat, sid) {
  mkdirSync(bindDir, { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    try { writeFileSync(claimFile(seat), JSON.stringify({ sid, at: Date.now() }), { flag: 'wx' }); return true; } catch (err) { if (err.code !== 'EEXIST') return false; }
    let owner = null;
    try { owner = JSON.parse(readFileSync(claimFile(seat), 'utf8')); } catch { /* being written by the winner: try again */ }
    if (owner?.sid === sid) return true;
    const alive = owner && (bindings().some((b) => b.sid === owner.sid) || Date.now() - owner.at < 5000);
    if (alive || !owner) { if (!owner) continue; return false; }
    rmSync(claimFile(seat), { force: true }); // stale: its window is gone
  }
  return false;
}

function writeBinding(sid, seat) {
  mkdirSync(bindDir, { recursive: true });
  const at = Date.now();
  const tmp = `${bindFile(sid)}.${process.pid}.tmp`; // written whole, then moved into place: a window reading at the same moment never sees half a file
  writeFileSync(tmp, JSON.stringify({ sid, seat, at }));
  renameSync(tmp, bindFile(sid));
  return at;
}

/** The windows (session ids) currently bound to a seat, newest first: what `hive rebind` offers to choose from. */
export function windows() {
  return bindings().sort((a, b) => b.at - a.at);
}

/** Puts a window (session id) back on a seat of its own choosing, e.g. when its agent vanished from the wall and the window
 *  was given another seat. Its next event reports as that seat again. */
export function rebindSession(sid, seatName, { fresh = false } = {}) {
  const seat = loadSeat(seatName); // throws if there is no such seat
  if (fresh) { // the host ignores a booted seat's session id until it rejoins as a new one: mint one
    seat.sessionId = `office-${seat.name}-${randomBytes(4).toString('hex')}`;
    writeFileSync(file(seat.name), JSON.stringify(seat, null, 2), { mode: 0o600 });
  }
  writeBinding(sid, seatName);
}

/** A window closed. True when its seat is now empty (no other window speaks as it), so the seat may leave. */
export function releaseSession(sid, seatName) {
  if (sid) {
    rmSync(bindFile(sid), { force: true });
    try { for (const f of readdirSync(bindDir).filter((n) => n.endsWith('.claim'))) if (JSON.parse(readFileSync(join(bindDir, f), 'utf8')).sid === sid) rmSync(join(bindDir, f), { force: true }); } catch { /* none */ }
  }
  return !bindings().some((b) => b.seat === seatName);
}
