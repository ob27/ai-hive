// Hive production: how many turns each agent has taken in the Hive, for ever. Someone always in the hive piles up turns; someone who
// pops in once a day for a look round adds a few. Kept by name in a small file so it survives restarts of the host. The demo's
// pretend agents are never written here (the HiveStore counts those in memory only).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const productionFile = () => join(process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'production.json');

export class Ledger {
  constructor({ file = productionFile(), saveMs = 2000 } = {}) {
    this.file = file;
    this.saveMs = saveMs;
    this.turns = new Map();   // key -> turns. A key is a roster slot ('project#0'), or an agent's name for counts made before slots existed
    this.names = new Map();   // key -> the name last seen on it, for showing who is who
    this.timer = null;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, n] of Object.entries(saved.turns ?? {})) if (typeof n === 'number' && n > 0) this.turns.set(key, n);
      for (const [key, name] of Object.entries(saved.names ?? {})) if (typeof name === 'string') this.names.set(key, name);
    } catch { /* first run, or an unreadable file: start from zero */ }
  }

  add(key, n = 1, name) {
    this.turns.set(key, Math.round(((this.turns.get(key) ?? 0) + n) * 100) / 100);
    if (name) this.names.set(key, name);
    this.timer ??= setTimeout(() => this.save(), this.saveMs);
    this.timer.unref?.();
  }

  get(key) { return this.turns.get(key) ?? 0; }
  has(key) { return this.turns.has(key); }

  /** An agent that was counted under its name now has a slot: carry its turns over once, so nothing is lost. */
  adopt(name, slot) {
    if (name === slot || !this.turns.has(name) || this.turns.has(slot)) { if (name && slot) this.names.set(slot, name); return false; }
    this.turns.set(slot, this.turns.get(name)); this.turns.delete(name); this.names.set(slot, name);
    this.timer ??= setTimeout(() => this.save(), this.saveMs); this.timer.unref?.();
    return true;
  }
  total() { let t = 0; for (const n of this.turns.values()) t += n; return Math.round(t * 100) / 100; }
  top(limit = 10) { return [...this.turns].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, turns]) => ({ name: this.names.get(key) ?? key.replace(/#\d+$/, ''), turns })); }

  save() {
    clearTimeout(this.timer); this.timer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ turns: Object.fromEntries(this.turns), names: Object.fromEntries(this.names) }));
      renameSync(tmp, this.file);
    } catch { /* a read-only home: production just is not remembered */ }
  }
}
