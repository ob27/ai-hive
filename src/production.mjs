// Hive production: how many turns each agent has taken in the Hive, for ever. Someone always in the hive piles up turns; someone who
// pops in once a day for a look round adds a few. Kept by name in a small file so it survives restarts of the host. The demo's
// pretend agents are never written here (the HiveStore counts those in memory only).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const productionFile = () => join(process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'production.json');

/** 'YYYY-MM-DD' in the host's local time zone: a day is the host's day. */
export const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class Ledger {
  constructor({ file = productionFile(), saveMs = 2000, now = Date.now } = {}) {
    this.file = file;
    this.saveMs = saveMs;
    this.turns = new Map();   // key -> turns. A key is a roster slot ('project#0'), or an agent's name for counts made before slots existed
    this.names = new Map();   // key -> the name last seen on it, for showing who is who
    this.days = new Map();    // 'YYYY-MM-DD' (the host's local date) -> production made that day, for the heatmap. History starts the day this was added.
    this.history = new Map(); // source ('claude-transcripts@laptop') -> Map(date -> n): estimates of production from before dates were kept (history-import.mjs)
    this.now = now;
    this.timer = null;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, n] of Object.entries(saved.turns ?? {})) if (typeof n === 'number' && n > 0) this.turns.set(key, n);
      for (const [key, name] of Object.entries(saved.names ?? {})) if (typeof name === 'string') this.names.set(key, name);
      for (const [day, n] of Object.entries(saved.days ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof n === 'number' && n > 0) this.days.set(day, n);
      for (const [src, days] of Object.entries(saved.history ?? {})) this.history.set(src, new Map(Object.entries(days ?? {}).filter(([d, n]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && n > 0)));
    } catch { /* first run, or an unreadable file: start from zero */ }
  }

  /** Replace one source's imported history (so importing twice never doubles it). Returns how many days were kept. */
  setHistory(source, days) {
    const clean = new Map();
    for (const [d, n] of Object.entries(days ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && Number.isFinite(n) && n > 0 && clean.size < 800) clean.set(d, Math.round(n * 100) / 100);
    if (!this.history.has(source) && this.history.size >= 20) return 0;
    this.history.set(source, clean);
    this.save();
    return clean.size;
  }

  add(key, n = 1, name) {
    this.turns.set(key, Math.round(((this.turns.get(key) ?? 0) + n) * 100) / 100);
    if (name) this.names.set(key, name);
    const day = localDay(this.now());
    this.days.set(day, Math.round(((this.days.get(day) ?? 0) + n) * 100) / 100);
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

  /** Production per project, biggest first. A key is 'project#slot'; one counted by name before slots existed is its own entry. */
  projects(limit = 5) {
    const by = new Map();
    for (const [key, n] of this.turns) { const p = key.replace(/#\d+$/, ''); by.set(p, (by.get(p) ?? 0) + n); }
    return [...by].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, turns]) => ({ name, turns: Math.round(turns * 100) / 100 }));
  }

  /** The heatmap's data: [{ date, value }] oldest first, for the last `limit` days that have any production. */
  daily(limit = 400) {
    const all = new Map(this.days);
    const firstLive = [...this.days.keys()].sort()[0]; // from the first day turns were dated live, those are the truth: imported estimates stop there
    for (const days of this.history.values()) for (const [d, n] of days) if (!firstLive || d < firstLive) all.set(d, Math.round(((all.get(d) ?? 0) + n) * 100) / 100);
    return [...all].sort((a, b) => a[0].localeCompare(b[0])).slice(-limit).map(([date, value]) => ({ date, value }));
  }

  save() {
    clearTimeout(this.timer); this.timer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ turns: Object.fromEntries(this.turns), names: Object.fromEntries(this.names), days: Object.fromEntries([...this.days].sort((a, b) => a[0].localeCompare(b[0])).slice(-400)), history: Object.fromEntries([...this.history].map(([src, m]) => [src, Object.fromEntries(m)])) }));
      renameSync(tmp, this.file);
    } catch { /* a read-only home: production just is not remembered */ }
  }
}
