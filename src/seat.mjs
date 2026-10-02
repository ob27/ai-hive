import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = join(process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'seats');
const file = (name) => join(dir, `${name.replace(/[^\w.-]/g, '_')}.json`);

/** A seat is the durable identity of one agent in the office. `cwd` doubles as the label the
 *  Pixel Agents UI shows (it renders basename(cwd)), so we set it to the seat's display name. */
export function createSeat({ url, token, name }) {
  const seat = { name, url: url.replace(/\/$/, ''), token, sessionId: `office-${name}-${randomBytes(4).toString('hex')}`, cwd: `/office/${name}` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(name), JSON.stringify(seat, null, 2), { mode: 0o600 });
  return seat;
}

export function removeSeat(name) {
  rmSync(file(name), { force: true });
}

/** Resolution order: explicit name → $OFFICE_SEAT → the most recently joined seat. */
export function loadSeat(name = process.env.OFFICE_SEAT) {
  if (name) return JSON.parse(readFileSync(file(name), 'utf8'));
  let files;
  try { files = readdirSync(dir); } catch { files = []; }
  if (!files.length) throw new Error('no seat — run `office join <host[:port]> <name>` first');
  const newest = files.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return JSON.parse(readFileSync(newest, 'utf8'));
}
