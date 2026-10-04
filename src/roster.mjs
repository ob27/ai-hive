// The cast of each project. An agent that joins from a project always gets the same name (and so the same portrait), because the host
// keeps a roster: project -> slots, each slot with a fixed name. The first agent in a project takes slot 0, a second one working at the
// same time takes slot 1, and so on; when an agent leaves, its slot is free again and the next agent from that project steps into it.
// A slot is the agent's identity: production (production.mjs) is counted against it, so renaming or restarting does not lose turns.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ANDROGYNOUS_NAMES } from './avatars.mjs';
import { NAMES } from './names.mjs';

export const rosterFile = () => join(process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'roster.json');

const POOL = [...NAMES, ...ANDROGYNOUS_NAMES];
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const clean = (project) => String(project ?? '').trim().replace(/#/g, '').slice(0, 80) || 'project';

export class Roster {
  constructor({ file = rosterFile() } = {}) {
    this.file = file;
    this.projects = {};   // project -> { slots: [{ name }] }
    try { this.projects = JSON.parse(readFileSync(file, 'utf8')).projects ?? {}; } catch { /* first run */ }
  }

  /** A name no slot anywhere has: derived from the project and slot so it is the same on every host that starts from nothing. */
  freshName(project, index) {
    const used = new Set(Object.values(this.projects).flatMap((p) => p.slots.map((s) => s.name)));
    const start = hash(`${project}#${index}`) % POOL.length;
    for (let i = 0; i < POOL.length; i++) { const n = POOL[(start + i) % POOL.length]; if (!used.has(n)) return n; }
    let n = 2; while (used.has(`${POOL[start]}${n}`)) n++;
    return `${POOL[start]}${n}`;
  }

  /**
   * The slot for an agent joining from `project`: the lowest one nobody is sitting in. `occupied` is the set of slot keys in use now and
   * `taken` the names in use now (a name in use by someone who did not come through here makes that slot unusable).
   * -> { slot: 'project#0', name, project }
   */
  claim(project, { occupied = new Set(), taken = new Set() } = {}) {
    project = clean(project);
    const p = (this.projects[project] ??= { slots: [] });
    for (let i = 0; ; i++) {
      while (p.slots.length <= i) p.slots.push({ name: this.freshName(project, p.slots.length) });
      const slot = `${project}#${i}`;
      if (occupied.has(slot) || taken.has(p.slots[i].name)) continue;
      this.save();
      return { slot, name: p.slots[i].name, project };
    }
  }

  /** The name of a slot key like 'project#0', or undefined. */
  nameOf(slot) {
    const i = String(slot).lastIndexOf('#');
    return this.projects[String(slot).slice(0, i)]?.slots[Number(String(slot).slice(i + 1))]?.name;
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ projects: this.projects }, null, 1));
      renameSync(tmp, this.file);
    } catch { /* a read-only home: the cast is just not remembered */ }
  }
}
