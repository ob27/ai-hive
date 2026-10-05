// The Hive's monitoring layer for services: a few lines of rules, in a tiny language, that watch the machine stats a service streams with its heartbeat
// (cpu, mem, load, disk, temp) and turn signs of degradation into a status, with the reason.
//
//   cpu > 90 for 2m          -> degraded  "CPU above 90% for 2 minutes"
//   mem > 97                 -> failure   "Memory nearly exhausted ({mem}%)"
//   mem rises 15 in 10m      -> degraded  "Memory climbing: +{delta} points in 10 minutes (a leak?)"
//   temp > 100               -> failure   "Overheating ({temp}°C)"
//
// A rule is   <metric> <op> <number> [for <duration>]  -> <degraded|failure> ["message"]      op is > >= < <=
//        or   <metric> rises <number> in <duration>     -> <degraded|failure> ["message"]     (a steady climb, not a spike)
// Metrics: cpu, gpu, mem, load, disk (percent), net (network Mbit/s, received + sent, all interfaces added up), temp (degrees C). With several CPUs or GPUs each is one aggregated number (the average of all of them). Durations: 30s, 2m, 1h. `#` starts a comment. In a message {metric}, {value}, {n} and {delta}
// are filled in. The worst rule that fires sets the status; every rule that fires is listed as a reason. Put your own rules in
// ~/.workspace-office/service-rules.txt (they replace the defaults), or pass them to the store.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One number each, whatever the machine has: with several CPUs or GPUs a service sends the AVERAGE across all of them (and temp is the hottest sensor).
export const METRICS = ['cpu', 'gpu', 'mem', 'load', 'disk', 'net', 'temp'];
export const UNITS = { cpu: '%', gpu: '%', mem: '%', load: '%', disk: '%', net: ' Mbit/s', temp: '°C' };

export const DEFAULT_RULES = `
# Pinned CPU, then pinned for good
cpu > 90 for 2m          -> degraded "CPU above 90% for 2 minutes"
cpu > 98 for 5m          -> failure  "CPU pinned above 98% for 5 minutes"
gpu > 95 for 5m          -> degraded "GPU above 95% for 5 minutes"
# Memory: high, nearly gone, or climbing steadily (a leak)
mem > 90 for 1m          -> degraded "Memory above 90% for a minute"
mem > 97                 -> failure  "Memory nearly exhausted ({value}%)"
mem rises 15 in 10m      -> degraded "Memory climbing: up {delta} points in 10 minutes (a leak?)"
# Load as a percentage of the cores: 100 is every core busy
load > 200 for 3m        -> degraded "Load is twice the number of cores"
# Disk and heat
disk > 90                -> degraded "Disk is {value}% full"
disk > 97                -> failure  "Disk nearly full ({value}%)"
temp > 85                -> degraded "Running hot ({value}°C)"
temp > 100               -> failure  "Overheating ({value}°C)"
`;

const DUR = { s: 1000, m: 60_000, h: 3_600_000 };
const duration = (s) => { const m = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(s ?? ''); return m ? Number(m[1]) * DUR[m[2].toLowerCase()] : null; };
const unquote = (s) => (s ?? '').replace(/^"|"$/g, '');
const SEV = { ok: 0, degraded: 1, failure: 2 };

/** Parses rule text. -> { rules, errors } (a line that does not parse is reported, never silently dropped). */
export function parseRules(text) {
  const rules = [], errors = [];
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^(\w+)\s+(?:(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)(?:\s+for\s+(\S+))?|rises\s+(\d+(?:\.\d+)?)\s+in\s+(\S+))\s*->\s*(degraded|failure)\s*(".*")?$/i.exec(line);
    const bad = (why) => errors.push({ line: i + 1, text: raw.trim(), error: why });
    if (!m) return bad('expected: <metric> <op> <number> [for <duration>] -> degraded|failure "message"   or   <metric> rises <n> in <duration> -> ...');
    const metric = m[1].toLowerCase();
    if (!METRICS.includes(metric)) return bad(`unknown metric "${m[1]}" (use ${METRICS.join(', ')})`);
    const status = m[7].toLowerCase();
    const message = unquote(m[8]);
    if (m[5] !== undefined) {
      const over = duration(m[6]);
      if (over === null) return bad(`bad duration "${m[6]}" (like 30s, 2m, 1h)`);
      return void rules.push({ kind: 'rise', metric, n: Number(m[5]), over, status, message, text: line });
    }
    const forMs = m[4] === undefined ? 0 : duration(m[4]);
    if (forMs === null) return bad(`bad duration "${m[4]}" (like 30s, 2m, 1h)`);
    rules.push({ kind: 'threshold', metric, op: m[2], n: Number(m[3]), forMs, status, message, text: line });
  });
  return { rules, errors };
}

/** The rules the host uses: the file in the data folder if there is one, else the defaults. */
export function loadRules({ file = join(process.env.HIVE_HOME ?? process.env.OFFICE_HOME ?? join(homedir(), '.workspace-office'), 'service-rules.txt') } = {}) {
  let text = DEFAULT_RULES, from = 'built-in defaults';
  try { text = readFileSync(file, 'utf8'); from = file; } catch { /* no file: the defaults */ }
  const { rules, errors } = parseRules(text);
  return { rules, errors, from };
}

/** How well the readings lie on one straight line (R squared, 0 to 1); 0 if they are not rising at all. */
function linearFit(window, metric) {
  const n = window.length, xs = window.map((p) => p.at), ys = window.map((p) => p[metric]);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy > 0 && sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
}

const holds = (op, v, n) => (op === '>' ? v > n : op === '>=' ? v >= n : op === '<' ? v < n : v <= n);
const fill = (tpl, vars, fallback) => (tpl || fallback).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
const pretty = (ms) => (ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

/**
 * `samples` is the service's recent readings, oldest first: [{ at, cpu?, mem?, ... }]. -> { status: 'ok'|'degraded'|'failure', reasons: [{ status, text, metric }], states }.
 * `states` marks each metric 'ok' | 'warn' | 'bad' for the screen (the worst rule that fired on it).
 */
export function evaluateRules(rules, samples, now = Date.now()) {
  const reasons = [];
  for (const r of rules) {
    const series = samples.filter((s) => typeof s[r.metric] === 'number');
    const cur = series.at(-1);
    if (!cur || now - cur.at > 5 * 60_000) continue; // no fresh reading of this metric
    if (r.kind === 'threshold') {
      if (!holds(r.op, cur[r.metric], r.n)) continue;
      if (r.forMs > 0) {
        // It has to have held for the whole stretch: every reading inside it holds, and the history reaches back far enough to call it that long.
        const inside = series.filter((x) => x.at >= now - r.forMs);
        if (series[0].at > now - r.forMs * 0.8 || !(inside.length ? inside : [cur]).every((x) => holds(r.op, x[r.metric], r.n))) continue;
      }
      reasons.push({ status: r.status, metric: r.metric, rule: r.text, text: fill(r.message, { metric: r.metric, value: cur[r.metric], n: r.n }, `${r.metric} ${r.op} ${r.n}${UNITS[r.metric]}${r.forMs ? ` for ${pretty(r.forMs)}` : ''}`) });
    } else {
      const window = series.filter((s) => s.at >= now - r.over);
      if (window.length < 4 || cur.at - window[0].at < r.over * 0.6) continue; // not enough history to call it a trend
      const delta = cur[r.metric] - window[0][r.metric];
      if (delta < r.n) continue;
      if (linearFit(window, r.metric) < 0.7) continue; // a spike or a saw-tooth is not a steady climb: the readings must lie close to a rising line
      reasons.push({ status: r.status, metric: r.metric, rule: r.text, text: fill(r.message, { metric: r.metric, value: cur[r.metric], n: r.n, delta: Math.round(delta * 10) / 10 }, `${r.metric} up ${Math.round(delta)} points in ${pretty(r.over)}`) });
    }
  }
  const states = {};
  for (const x of reasons) { const s = x.status === 'failure' ? 'bad' : 'warn'; if (states[x.metric] !== 'bad') states[x.metric] = s; }
  const status = reasons.reduce((w, x) => (SEV[x.status] > SEV[w] ? x.status : w), 'ok');
  return { status, reasons, states };
}
