// What the running host knows about itself, for `hive status` and `hive logs`: how long it has been up, what it has served and how
// it answered, what it printed or crashed on, who is on the wall, and whether the code on disk has changed since it started (a host
// keeps running the code it loaded, so an edit does nothing until it is restarted: the commonest reason "it isn't working").
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** path -> "mtime:size" for the files the host is made of (the CLI, the server code, the demo, the built screen's entry page). */
export function snapshotFiles(rootDir = root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|md)$/.test(e.name) && !p.includes('node_modules')) out.set(relative(rootDir, p), stat(p));
    }
  };
  const stat = (p) => { const s = statSync(p); return `${Math.round(s.mtimeMs)}:${s.size}`; };
  for (const d of ['bin', 'src', 'scripts']) walk(join(rootDir, d));
  try { out.set('hive-ui/dist/index.html', stat(join(rootDir, 'hive-ui', 'dist', 'index.html'))); } catch { /* the screen is not built */ }
  return out;
}

/** The newest modification time among those files, in ms (what a host that started earlier than this is missing). */
export function newestChange(files = snapshotFiles()) {
  let t = 0;
  for (const v of files.values()) t = Math.max(t, Number(v.split(':')[0]));
  return t;
}

export class Monitor {
  constructor({ role = 'host', now = Date.now, keep = 300, files = snapshotFiles } = {}) {
    this.role = role;
    this.now = now;
    this.keep = keep;
    this.startedAt = now();
    this.filesAtStart = files();
    this.files = files;
    this.entries = [];
    this.nextId = 1;
    this.counts = new Map(); // "screen 200" -> n
    this.requests = 0;
  }

  /** One log line. `kind`: req | error | console | event. */
  log(kind, text) {
    this.entries.push({ id: this.nextId++, at: this.now(), kind, text: String(text).slice(0, 400) });
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
  }

  /** Records every request on `name`'s server once it has been answered. Never changes how the request is handled. */
  track(req, res, name = 'screen') {
    const began = this.now();
    // Keys travel in query strings (/agent?key=…, /join-page?key=…): never keep them.
    const path = req.url.replace(/([?&]key=)[^&]*/g, '$1…').slice(0, 160);
    res.on('close', () => {
      const status = res.statusCode;
      const tally = `${name} ${status}`;
      this.counts.set(tally, (this.counts.get(tally) ?? 0) + 1);
      this.requests++;
      this.log(status >= 500 ? 'error' : 'req', `${name} ${req.method} ${path} -> ${status} (${this.now() - began}ms)`);
    });
  }

  /** Keeps what the host prints (and what it crashes with) in the log too, while still printing it. */
  captureConsole() {
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { this.log(level === 'log' ? 'console' : 'error', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); orig(...args); };
    }
    process.on('uncaughtExceptionMonitor', (err) => this.log('error', `uncaught: ${err?.stack ?? err}`));
  }

  /** Files that changed, appeared or vanished since this host started. A non-empty list means it is running older code than is on disk. */
  changedFiles() {
    const now = this.files();
    const out = [];
    for (const [p, v] of now) if (this.filesAtStart.get(p) !== v) out.push(p);
    for (const p of this.filesAtStart.keys()) if (!now.has(p)) out.push(p);
    return out.sort();
  }

  status(extra = {}) {
    const mem = process.memoryUsage();
    const changed = this.changedFiles();
    return {
      role: this.role, pid: process.pid, node: process.version, startedAt: this.startedAt, uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      memoryMB: Math.round(mem.rss / 1048576),
      requests: { total: this.requests, byStatus: Object.fromEntries(this.counts) },
      errors: this.entries.filter((e) => e.kind === 'error').slice(-10),
      code: { stale: changed.length > 0, changedSinceStart: changed.slice(0, 20) },
      ...extra,
    };
  }

  /** Log entries after `afterId`, oldest first. */
  tail(afterId = 0, limit = 100) {
    return this.entries.filter((e) => e.id > afterId).slice(-limit);
  }
}

/** The wall-and-plumbing half of /api/status: mode, members with the reason for each status, buzz, who is listening, and whether the screen is built. */
export function describeHost({ hive, buzz, mode, uiDir, ports, info }) {
  const members = hive.snapshot();
  const byStatus = {};
  for (const m of members) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  let ui = { built: false };
  try { ui = { built: true, builtAt: statSync(join(uiDir, 'index.html')).mtimeMs }; } catch { /* not built */ }
  return {
    mode: mode?.get?.() ?? 'work', ports, ui, responder: !!info?.responder,
    members: {
      total: members.length, byStatus,
      list: members.map((m) => ({ name: m.name, kind: m.kind, status: m.status, label: m.statusLabel, reason: m.statusReason, project: m.project, reports: m.reports, chatty: m.chatty === true, lastReportAt: m.updatedAt })),
    },
    buzz: { lines: buzz.messages.length },
    subscribers: { wall: hive.listeners.size, buzz: buzz.listeners.size }, // each open screen holds one of each (plus the announcer and responder inside the host)
  };
}
