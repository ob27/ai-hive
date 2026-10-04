// What a service can say about the machine it runs on, for its heartbeat (`hive heartbeat --metrics`): cpu, mem, load, disk (percent) and temp (°C).
// Only what the machine can tell us cheaply and without special rights: a reading that is not available (temperature on a Mac, load on Windows)
// is left out, never faked. Node's own `os` module plus one small command each for the things it cannot see.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';

const pct = (n) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

let prevCpu = null;
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });

/** CPU busy percent since the last call (the first call measures over `firstMs`). */
export async function cpuPercent(firstMs = 250) {
  if (!prevCpu) { prevCpu = cpuTimes(); await new Promise((r) => setTimeout(r, firstMs)); }
  const now = cpuTimes();
  const idle = now.idle - prevCpu.idle, total = now.total - prevCpu.total;
  prevCpu = now;
  return total > 0 ? pct((1 - idle / total) * 100) : 0;
}

/** Memory in use, as a percent of the total. "Free" on macOS and Linux leaves out cache that can be given back, so count what is really available. */
export function memPercent() {
  const total = os.totalmem();
  let available = os.freemem();
  if (process.platform === 'linux') {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSafe('/proc/meminfo'));
    if (m) available = Number(m[1]) * 1024;
  } else if (process.platform === 'darwin') {
    const out = run('vm_stat', []);
    const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
    const n = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
    const pages = n('Pages free') + n('Pages inactive') + n('Pages speculative') + n('Pages purgeable');
    if (pages > 0) available = pages * page;
  }
  return pct((1 - available / total) * 100);
}

const readFileSafe = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

/** 1-minute load average as a percent of the cores (100 = every core busy). Not available on Windows. */
export function loadPercent() {
  const l = os.loadavg()[0];
  return process.platform === 'win32' || !(l >= 0) ? undefined : Math.round((l / os.cpus().length) * 1000) / 10;
}

/** Percent used on the disk the process runs from. */
export function diskPercent() {
  const out = run('df', ['-kP', process.cwd()]).trim().split('\n').at(-1) ?? '';
  const m = /(\d+)%/.exec(out);
  return m ? Number(m[1]) : undefined;
}

/** Hottest thermal zone in °C, on Linux. A Mac does not give a temperature without special rights, so none is reported there. */
export function tempCelsius() {
  if (process.platform !== 'linux') return undefined;
  try {
    const zones = readdirSync('/sys/class/thermal').filter((z) => z.startsWith('thermal_zone'));
    const temps = zones.map((z) => Number(readFileSafe(`/sys/class/thermal/${z}/temp`)) / 1000).filter((t) => t > 0 && t < 150);
    return temps.length ? Math.round(Math.max(...temps) * 10) / 10 : undefined;
  } catch { return undefined; }
}

/** One reading of everything this machine can tell us. Only the values that exist are present. */
export async function sampleMachine() {
  const m = { cpu: await cpuPercent(), mem: memPercent(), load: loadPercent(), disk: diskPercent(), temp: tempCelsius() };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
}
