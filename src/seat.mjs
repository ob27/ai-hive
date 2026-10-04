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
