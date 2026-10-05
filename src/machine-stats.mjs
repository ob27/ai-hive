// What a service can say about the machine it runs on, for its heartbeat (`hive heartbeat --metrics`): cpu, gpu, mem, load, disk (percent), net (Mbit/s) and temp (°C).
// Only what the machine can tell us without special rights: a reading that is not available (load on Windows, temperature when no sensor tool is installed)
// is left out, never faked. Node's own `os` module, plus one small command each for the things it cannot see. For temperature on a Mac install
// `macmon` (brew install macmon), or point --temp-command at any probe that prints a number.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';

const pct = (n) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

let prevCpu = null;
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });

/** CPU busy percent since the last call (the first call measures over `firstMs`). It is the average over every core of every CPU socket: one number. */
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

const hottest = (nums) => { const t = nums.filter((n) => Number.isFinite(n) && n > 0 && n < 150); return t.length ? Math.round(Math.max(...t) * 10) / 10 : undefined; };
const numbers = (text) => [...String(text).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

/** The hottest "tempN_input" in `sensors -u` (lm-sensors) output. Pure, for tests. */
export function parseSensors(text) {
  return hottest([...String(text).matchAll(/temp\d+_input:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
}

/** Pulls a temperature out of what a probe tool prints: macmon's JSON (cpu/gpu temperatures), or just the first number in plain text ("61.8°C"). Pure, for tests. */
export function parseTemperature(text) {
  const t = String(text).trim();
  try {
    const j = JSON.parse(t.split('\n').filter(Boolean).at(-1));
    if (typeof j === 'number') return hottest([j]); // a bare number
    const found = [];
    (function walk(o, key = '') { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, k); else if (typeof o === 'number' && /temp/i.test(key)) found.push(o); })(j);
    return hottest(found);
  } catch { return hottest(numbers(t).slice(0, 1)); }
}

/**
 * The hottest sensor in °C, from whatever this machine can tell us. In order: your own probe (`command`, or $HIVE_TEMP_COMMAND: anything that prints a number),
 * then on a Mac `macmon` (Apple Silicon, no special rights), `osx-cpu-temp` or `istats`; on Linux the kernel's thermal zones and hwmon sensors, and an NVIDIA
 * GPU if `nvidia-smi` is there. Nothing found: undefined (a reading is never faked).
 */
export function tempCelsius({ command } = {}) {
  const custom = command ?? process.env.HIVE_TEMP_COMMAND;
  if (custom) return parseTemperature(run('sh', ['-c', custom]));
  if (process.platform === 'darwin') {
    for (const [cmd, args] of [['macmon', ['pipe', '-s', '1']], ['osx-cpu-temp', []], ['istats', ['cpu', 'temp', '--value-only']]]) {
      const t = parseTemperature(run(cmd, args));
      if (t !== undefined) return t;
    }
    return undefined;
  }
  if (process.platform === 'win32') {
    // ACPI thermal zones in tenths of a kelvin (needs an elevated shell on many machines); anything better goes through --temp-command.
    const k = numbers(run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature).CurrentTemperature'])).map((n) => n / 10 - 273.15);
    return hottest(k);
  }
  if (process.platform === 'linux') {
    const temps = [];
    try { for (const z of readdirSync('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))) temps.push(Number(readFileSafe(`/sys/class/thermal/${z}/temp`)) / 1000); } catch { /* none */ }
    try { for (const h of readdirSync('/sys/class/hwmon')) for (const f of readdirSync(`/sys/class/hwmon/${h}`).filter((n) => /^temp\d+_input$/.test(n))) temps.push(Number(readFileSafe(`/sys/class/hwmon/${h}/${f}`)) / 1000); } catch { /* none */ }
    const gpu = parseTemperature(run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader']));
    const pi = parseTemperature(run('vcgencmd', ['measure_temp'])); // Raspberry Pi: "temp=48.3'C"
    const lm = temps.length ? undefined : parseSensors(run('sensors', ['-u'])); // lm-sensors, when the kernel files gave nothing
    return hottest([...temps, ...(gpu === undefined ? [] : [gpu]), ...(pi === undefined ? [] : [pi]), ...(lm === undefined ? [] : [lm])]);
  }
  return undefined;
}

/** What macmon (a Mac's Apple Silicon sensors, no sudo) prints for one sample, or null. Asked once per reading: both the GPU and the temperature come from it. */
const macmonJson = () => { try { const t = run('macmon', ['pipe', '-s', '1']).trim(); return t ? JSON.parse(t.split('\n').filter(Boolean).at(-1)) : null; } catch { return null; } };

/** GPU busy percent, AVERAGED over all the GPUs (a machine with four is one number). NVIDIA through nvidia-smi, AMD/Intel on Linux through the kernel, Apple Silicon through macmon. */
export function gpuPercent({ command, macmon } = {}) {
  const custom = command ?? process.env.HIVE_GPU_COMMAND;
  const mean = (xs) => { const v = xs.filter((n) => Number.isFinite(n) && n >= 0 && n <= 100); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined; };
  if (custom) return mean(numbers(run('sh', ['-c', custom])).slice(0, 1));
  const nv = mean(run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']).split('\n').filter(Boolean).map(Number));
  if (nv !== undefined) return nv;
  if (process.platform === 'linux') {
    try {
      const busy = readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n)).map((c) => Number(readFileSafe(`/sys/class/drm/${c}/device/gpu_busy_percent`)));
      const m = mean(busy.filter((n) => Number.isFinite(n)));
      if (m !== undefined) return m;
    } catch { /* no DRM GPUs */ }
  }
  const u = (macmon ?? (process.platform === 'darwin' ? macmonJson() : null))?.gpu_usage; // [MHz, fraction busy]
  return Array.isArray(u) && typeof u[1] === 'number' ? mean([u[1] * 100]) : undefined;
}

/** Total bytes received and sent over every real interface (not loopback), or null. Pure parsers below, for tests. */
export function parseNetDev(text) { // Linux /proc/net/dev
  let rx = 0, tx = 0, seen = false;
  for (const line of String(text).split('\n')) {
    const m = /^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(line);
    if (!m || m[1] === 'lo') continue;
    rx += Number(m[2]); tx += Number(m[3]); seen = true;
  }
  return seen ? { rx, tx } : null;
}
export function parseNetstatIb(text) { // macOS `netstat -ib`: one Link-layer row per interface
  let rx = 0, tx = 0, seen = false;
  const lines = String(text).split('\n');
  const cols = lines[0]?.trim().split(/\s+/) ?? [];
  const iI = cols.indexOf('Ibytes'), iO = cols.indexOf('Obytes');
  if (iI < 0 || iO < 0) return null;
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (!/^<Link#\d+>$/.test(f[2] ?? '') || /^(lo|gif|stf|utun|awdl|llw|bridge|ap)\d*$/.test(f[0])) continue;
    // a row without an address has one column fewer, so index from the end
    const off = f.length - cols.length;
    const i = Number(f[iI + off]), o = Number(f[iO + off]);
    if (Number.isFinite(i) && Number.isFinite(o)) { rx += i; tx += o; seen = true; }
  }
  return seen ? { rx, tx } : null;
}
export function parseNetstatE(text) { // Windows `netstat -e`: "Bytes   <received>   <sent>"
  const m = /Bytes\s+(\d+)\s+(\d+)/i.exec(String(text));
  return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null;
}
const netTotals = () => process.platform === 'linux' ? parseNetDev(readFileSafe('/proc/net/dev'))
  : process.platform === 'darwin' ? parseNetstatIb(run('netstat', ['-ib']))
  : process.platform === 'win32' ? parseNetstatE(run('netstat', ['-e'])) : null;

let prevNet = null;
/** Network traffic in Mbit/s (received + sent, summed over every interface) since the last call. The first call is undefined: a rate needs two readings.
 *  Throughput is added up, not averaged, because two links carry the sum. `command` (or $HIVE_NET_COMMAND) may print a Mbit/s number itself. */
export function netMbps({ command, totals = netTotals, now = Date.now } = {}) {
  const custom = command ?? process.env.HIVE_NET_COMMAND;
  if (custom) { const n = numbers(run('sh', ['-c', custom]))[0]; return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : undefined; }
  const cur = totals();
  if (!cur) return undefined;
  const at = now(), prev = prevNet;
  prevNet = { ...cur, at };
  if (!prev || at <= prev.at || cur.rx < prev.rx || cur.tx < prev.tx) return undefined; // first sample, or a counter reset
  return Math.round((((cur.rx - prev.rx) + (cur.tx - prev.tx)) * 8 / 1e6 / ((at - prev.at) / 1000)) * 10) / 10;
}

/** One reading of everything this machine can tell us. Only the values that exist are present. */
export async function sampleMachine({ tempCommand, gpuCommand, netCommand } = {}) {
  const macmon = process.platform === 'darwin' && !tempCommand && !process.env.HIVE_TEMP_COMMAND ? macmonJson() : undefined; // one call for both the temperature and the GPU
  const temp = macmon ? parseTemperature(JSON.stringify(macmon)) : tempCelsius({ command: tempCommand });
  const m = { cpu: await cpuPercent(), gpu: gpuPercent({ command: gpuCommand, macmon }), mem: memPercent(), load: loadPercent(), disk: diskPercent(), net: netMbps({ command: netCommand }), temp };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
}
