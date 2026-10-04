// The Hive's member state: who is on the wall, what they are doing and what shape they are in.
//
// Two kinds of member, and silence means different things for each:
//   agent   — seated through hooks or chirps. If it goes quiet it is most likely just not active: it becomes a GHOST
//             (not a failure), stays on the board for ghostDropMs, then drops off.
//   service — posts heartbeats. If it reports trouble ("degraded": e.g. leaking memory) or misses its heartbeat it has
//             likely failed: status `failure`, an active failure state. It does not ghost.
//
// The output is the HiveMember shape the Rebar UI `AgentWall` renders (see rebarui/ref/AI_HIVE.md):
//   { id, kind, name, project?, status, statusLabel, activity?, updatedAt }
// Time is injected (`now`) so every rule is testable without waiting.
import { basename } from 'node:path';
import { AWAY, LISTENING, pick } from './phrases.mjs';
import { toolClass, turnWeight } from './production-score.mjs';
import { DEFAULT_RULES, evaluateRules, parseRules } from './service-rules.mjs';

const MIN = 60_000;

export const DEFAULTS = {
  stallMs: 5 * MIN,            // a busy agent with no event for this long (or a tool call open this long) is stalled
  ghostAfterMs: 30 * MIN,      // an agent silent this long becomes a ghost
  ghostDropMs: 60 * MIN,       // a ghost stays on the board this long, then drops off
  serviceTtlSec: 60,           // a service that does not say otherwise must beat at least this often
  serviceDropMs: 24 * 60 * MIN, // a service silent this long is removed (it has been shown as failed all that time)
  focusMs: 60_000,             // before it has history, a working agent quiet this long is probably deep in something big ("Focusing"), not stuck
  focusMinMs: 30_000,          // however fast an agent usually reports, it is never called Focusing sooner than this
  listenMs: 60_000,            // a chatty agent that just finished its turn is still in the chat (the end-of-turn hook waits LISTEN_WAIT_SEC=50) this long
  chatGraceMs: 20_000,         // chat stays open this long after the last listener stopped listening, so a send is not lost to bad timing
  tickMs: 5_000,               // how often the stream re-checks for status changes that no event announced
};

const SEVERITY = { failure: 0, stalled: 1, active: 2, listening: 3, idle: 4, ghost: 5, offline: 6 };

/** "12s" / "7 min" / "2 h": how long, for the sentences that explain a status. */
const ago = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The longest a service name may be on a card: longer ones are cut with an ellipsis (the id, which is what identifies the service, is untouched). */
export const SERVICE_NAME_MAX = 28;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const mins = (ms) => Math.floor(ms / MIN);

/** One line for "what is it doing", from a hook payload's tool. Shows a command or a file's base name, never a full path. */
export function describe(tool, input) {
  if (!input || typeof input !== 'object') return typeof tool === 'string' ? tool : '';
  if (typeof input.command === 'string') return clip(input.command.split('\n')[0].replace(/\s+/g, ' ').trim(), 80);
  const target = input.file_path ?? input.path ?? input.pattern ?? input.url;
  if (typeof target === 'string') return clip(target.includes('/') ? basename(target) : target, 80);
  return typeof tool === 'string' ? tool : '';
}

/** A chatty agent that has just finished its turn is still in the chat (`hive listen`) for a while, so it will answer if spoken to. */
function isListening(a, now, cfg, probe) {
  if (!a.stopped || a.chatty !== true) return false;
  if (probe && !a.sim) return probe(a.name); // the host sees an open `hive listen`: the one real proof (a fresh join also says "turn finished")
  return a.listenFrom !== undefined && now - a.listenFrom < cfg.listenMs;
}

/** What an idle or listening card says: "need anything else?" while it is in the chat, otherwise it has wandered off. */
function idleLine(a, now, cfg, probe) {
  const since = a.stoppedAt ?? a.lastAt;
  return pick(isListening(a, now, cfg, probe) ? LISTENING : AWAY, `${a.id}:${since}`);
}

const FAMILY_BY_TOOL = { claude: 'claude', qwen: 'qwen', gemini: 'gemini', cursor: 'cursor', copilot: 'copilot' };
const FAMILY_BY_MODEL = [[/claude|opus|sonnet|haiku/i, 'claude'], [/qwen|qwq/i, 'qwen'], [/gemini|gemma/i, 'gemini'], [/gpt|\bo[1-9]\b|codex|openai/i, 'gpt']];
/** A model name from whatever a hook sent: a string, or { id | name | display_name }. */
const modelOf = (m) => (typeof m === 'string' ? m : m && typeof m === 'object' ? (m.display_name ?? m.name ?? m.id) : undefined);
/** What kind of model: the name says it when it can, otherwise the tool it runs in (a seat joined with --qwen is Qwen). */
export function modelFamily(name, hooks) {
  for (const [re, fam] of FAMILY_BY_MODEL) if (typeof name === 'string' && re.test(name)) return fam;
  for (const h of hooks ?? []) if (FAMILY_BY_TOOL[h]) return FAMILY_BY_TOOL[h];
  return 'other';
}

export class HiveStore {
  constructor({ now = Date.now, ledger = null, rules = parseRules(DEFAULT_RULES).rules, ...config } = {}) {
    this.rules = rules;        // what the Hive watches for in a service's machine stats (service-rules.mjs)
    this.ledger = ledger;      // lifetime turns per agent name (production.mjs); without one turns are counted in memory only
    this.booted = new Map();   // session id -> { name, notice }: removed by the host; its events are ignored until it rejoins as a new seat
    this.inbox = new Map();    // session id -> a message to put in front of that agent on its next event (an ask to listen)
    this.now = now;
    this.cfg = { ...DEFAULTS, ...config };
    this.agents = new Map();   // session id -> { id, name, project, lastAt, stopped, pre, activity }
    this.services = new Map(); // service id -> { id, name, project, beat, message, ttlMs, lastAt }
    this.listeners = new Set();
    this.lastKey = '';
    this.timer = null;
    this.probe = null;         // (name) => is that agent really sitting in the chat right now? (set by the host from the buzz log)
  }

  /** A hook-shaped event from a seat ({session_id, hook_event_name, cwd, tool_name, tool_input}). `meta.project` is the seat's folder. */
  observe(payload, meta = {}) {
    const id = payload?.session_id;
    if (!id || typeof payload.hook_event_name !== 'string') return;
    if (this.booted.has(id)) return; // the host showed it the door
    if (payload.hook_event_name === 'SessionEnd') {
      if (this.agents.delete(id)) this.emit();
      return;
    }
    const now = this.now();
    const a = this.agents.get(id) ?? { id, name: id, project: undefined, lastAt: now, stopped: true, pre: null, activity: undefined };
    if (typeof payload.cwd === 'string' && payload.cwd) a.name = payload.cwd.startsWith('/office/') ? payload.cwd.slice('/office/'.length) : basename(payload.cwd);
    if (typeof meta.project === 'string' && meta.project) a.project = clip(meta.project, 80);
    const model = modelOf(meta.model) ?? modelOf(payload.model);
    if (model) a.modelName = clip(String(model), 80);
    if (typeof meta.user === 'string' && meta.user.trim()) a.user = clip(meta.user.trim(), 24); // the person this agent works for
    if (typeof meta.slot === 'string' && meta.slot) a.slot = meta.slot; // this agent's place in its project's cast (roster.mjs): its identity for production
    if (meta.sim === true) a.sim = true; // the demo's pretend agents never open a real listen, so they listen on a timer
    if (typeof meta.chatty === 'boolean') a.chatty = meta.chatty; // opted in to buzz (`hive join --chatty`)
    if (Array.isArray(meta.hooks)) a.hooks = meta.hooks.filter((h) => typeof h === 'string').slice(0, 6); // which tools report for it; [] = joined without hooks
    if (!a.stopped && !a.pre && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) this.learn(a, now - a.lastAt); // thinking time between steps
    else if (a.pre && ['PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) this.learn(a, now - a.lastAt); // how long its tool calls take
    if (!a.turn && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name)) a.turn = { startAt: now, calls: [] }; // a turn begins with its first event
    if (payload.hook_event_name === 'PreToolUse') a.turn?.calls.push(toolClass(payload.tool_name, payload.tool_input));
    a.lastAt = now;
    switch (payload.hook_event_name) {
      case 'SessionStart': a.stopped = true; a.stoppedAt = now; a.listenFrom = undefined; a.pre = null; a.activity = undefined; break;
      case 'PreToolUse': a.stopped = false; a.listenFrom = undefined; a.lastListeningAt = undefined; /* working again: no grace */ a.activity = describe(payload.tool_name, payload.tool_input); a.pre = { at: now }; break;
      case 'PostToolUse': case 'PostToolUseFailure': a.stopped = false; a.pre = null; break;
      case 'Stop': a.stopped = true; a.stoppedAt = now; a.listenFrom = now; a.pre = null; a.activity = undefined; a.composing = undefined; if (!meta.joining) this.count(a, now); a.turn = null; break; // the turn is over: don't keep showing its last task ("responding to tom")
      default: break; // Notification, SubagentStop…: proof of life only
    }
    this.agents.set(id, a);
    this.emit();
  }

  /** Remember how long this agent usually goes between reports, so a long silence can be told from its normal rhythm. */
  learn(a, gapMs) {
    if (!(gapMs > 0) || gapMs >= this.cfg.stallMs) return; // an outlier (a stall, a walk away) would only teach it that long silences are normal
    (a.gaps ??= []).push(gapMs);
    if (a.gaps.length > 40) a.gaps.shift();
  }

  /** How long an agent may be quiet before it reads as "Focusing": well past its own usual gap (twice its 90th percentile), else a default. */
  focusAfter(a) {
    const g = [...(a.gaps ?? [])].sort((x, y) => x - y);
    const usual = g.length >= 8 ? g[Math.floor(0.9 * (g.length - 1))] : null;
    const after = usual === null ? this.cfg.focusMs : Math.max(this.cfg.focusMinMs, usual * 2);
    return { after: Math.min(after, this.cfg.stallMs * 0.8), usual };
  }

  /** One turn finished: what it was worth (production-score.mjs) goes to this agent's honeycomb. Real agents are kept by slot, for ever; the demo's only while they are here. */
  count(a, now = this.now()) {
    const w = turnWeight({ calls: a.turn?.calls ?? [], startAt: a.turn?.startAt, endAt: now, model: a.modelName });
    if (a.sim || !this.ledger) a.turns = Math.round(((a.turns ?? 0) + w) * 100) / 100;
    else this.ledger.add(a.slot ?? a.name, w, a.name);
  }

  /** `name` has been handed a line and is writing its answer (to a human or to another agent). Cleared when it speaks, stops, or after ttlMs. */
  setComposing(name, to, ttlMs = 90_000) {
    const a = this.findAgent(name);
    if (!a) return;
    a.composing = { to: to === 'human' ? 'human' : 'agent', until: this.now() + ttlMs };
    this.emit();
  }

  clearComposing(name) {
    const a = this.findAgent(name);
    if (a?.composing) { a.composing = undefined; this.emit(); }
  }

  /** The roster slots (like 'rebarui#0') someone is sitting in right now: a slot whose agent has wandered off (a ghost) is free to take again. */
  occupiedSlots() {
    return new Set(this.snapshot().filter((m) => m.kind === 'agent' && m.status !== 'ghost' && m.slot).map((m) => m.slot));
  }

  /** Everyone's turns pooled: the Hive's production. */
  production() {
    const sim = [...this.agents.values()].filter((a) => (a.sim || !this.ledger) && a.turns); // counted in memory (the demo's agents, or a store with no ledger)
    const real = this.ledger ? this.ledger.total() : 0;
    const agents = [...(this.ledger ? this.ledger.top(10) : []), ...sim.map((a) => ({ name: a.name, turns: a.turns }))].sort((x, y) => y.turns - x.turns).slice(0, 10);
    return { total: Math.round((real + sim.reduce((t, a) => t + a.turns, 0)) * 100) / 100, agents };
  }

  /** The host shows an agent the door: off the wall now, and its events are ignored until it rejoins. Returns the agent, or null. */
  boot(id) {
    const a = this.agents.get(id);
    if (!a) return null;
    this.agents.delete(id);
    this.booted.set(id, { name: a.name, notice: true });
    this.emit();
    return a;
  }

  /**
   * Ask a working agent to come and sit in Hive Chat when it reaches a stopping point (it runs `hive listen`, which shows as Listening). Reaches it on
   * its next hook event. { name, text }, null if it is gone, or { name, refused } with why it cannot be asked: not chatty, not working right now,
   * or in Cursor (no hook carries text back). An agent that is idle has no hook running to receive it, so it is not offered.
   */
  askToListen(id, from = 'the host') {
    const m = this.snapshot().find((x) => x.id === id && x.kind === 'agent');
    if (!m) return null;
    if (m.tools?.length && m.tools.every((t) => t === 'cursor')) return { name: m.name, refused: `${m.name} runs in Cursor, which cannot receive messages from the Hive.` };
    if (!m.chatty) return { name: m.name, refused: `${m.name} did not join with --chatty, so it cannot take part in Hive Chat. It would have to rejoin with --chatty.` };
    if (m.status !== 'active') return { name: m.name, refused: m.status === 'listening' ? `${m.name} is already listening.` : `${m.name} is not working right now, so it would only see this the next time it acts.` };
    const text = `${from} would like you in Hive Chat. When you reach a stopping point, run \`hive listen\` (it waits about 100 seconds for someone to talk to you), answer anyone who asks with \`hive buzz --reply <id> "<one short line>"\` from what you already know or a quick web search, and keep listening until the person you work for tells you to stop (if nobody speaks for a few minutes, \`hive listen\` will tell you to go back to your task). Finish what you are doing first; you do not need to reply to this.`;
    this.inbox.set(id, text);
    return { name: m.name, text };
  }

  /** For `name`'s session: what to put in front of the agent now (once), or null. */
  takeNotice(id) {
    const b = this.booted.get(id);
    if (b) {
      if (!b.notice) return null;
      b.notice = false;
      return 'The host removed you from the Hive. Stop reporting to it, and do not rejoin unless the person you work for asks you to.';
    }
    const text = this.inbox.get(id);
    if (text) this.inbox.delete(id);
    return text ?? null;
  }

  /** A service heartbeat. `status` is ok | degraded | failure | gone (gone removes the service at once). */
  heartbeat({ id, name, project, status = 'ok', message, ttlSec, metrics }) {
    if (status === 'gone') {
      if (this.services.delete(id)) this.emit();
      return;
    }
    this.services.set(id, {
      id, name: clip(String(name || id).replace(/\s+/g, ' ').trim(), SERVICE_NAME_MAX), project: project ? clip(String(project), 80) : undefined, beat: status,
      message: message ? clip(String(message), 200) : undefined,
      ttlMs: (ttlSec ?? this.cfg.serviceTtlSec) * 1000, lastAt: this.now(),
      ...this.keepSamples(id, metrics),
    });
    this.emit();
  }

  /** The machine readings a service has streamed, newest last, for the last half hour: the rules look for trends in these. */
  keepSamples(id, metrics) {
    const now = this.now();
    const prev = this.services.get(id)?.samples ?? [];
    const samples = metrics ? [...prev, { at: now, ...metrics }].filter((s) => now - s.at <= 30 * MIN).slice(-300) : prev;
    return { samples, metrics: metrics ? { ...metrics, at: now } : this.services.get(id)?.metrics };
  }

  /** The seated agent with this name, if any (used to check a buzz comes from a chatty seat). */
  findAgent(name) {
    return [...this.agents.values()].find((a) => a.name === name);
  }

  /** Wire a BuzzLog to this wall: who is really waiting in the chat, who has been handed a line, who has spoken. The one place both are connected. */
  connect(buzz) {
    this.probe = (name) => buzz.isWaiting(name); // Listening = really waiting in the chat
    buzz.onListenChange = (name) => { const a = this.findAgent(name); if (a) a.lastListeningAt = this.now(); this.emit(); };
    buzz.onDelivered = (name, lines) => this.setComposing(name, lines[lines.length - 1].kind === 'human' ? 'human' : 'agent'); // handed a line: it is writing its answer
    buzz.onPosted = (name) => this.clearComposing(name);
    return this;
  }

  /**
   * Can anyone answer a message right now? Only a chatty agent sitting in the chat will: one that is busy in the middle of a turn will not reply
   * for minutes. A listener that has only just stopped (a few seconds) still counts, so a person who typed while the chat was open is not turned away.
   */
  chatReady() {
    const members = this.snapshot().filter((m) => m.kind === 'agent' && m.chatty);
    const listening = members.filter((m) => m.status === 'listening').map((m) => m.name);
    const open = members.filter((m) => m.chatOpen).map((m) => m.name);
    return { ok: open.length > 0, listening, open };
  }

  /** The wall: every member with a derived status. Prunes ghosts and services that have been gone long enough. Worst first. */
  snapshot() {
    const now = this.now();
    const c = this.cfg;
    const out = [];
    for (const a of [...this.agents.values()]) {
      const age = now - a.lastAt;
      if (age >= c.ghostAfterMs + c.ghostDropMs) { this.agents.delete(a.id); continue; }
      let status, label, why;
      const noHooks = Array.isArray(a.hooks) && a.hooks.length === 0
        ? ' It joined without hooks, so only what it says with `hive say` shows here: rejoin with --claude (or your tool\'s flag) to report its real activity.' : '';
      if (age >= c.ghostAfterMs) {
        [status, label] = ['ghost', 'Ghost'];
        why = `Silent for ${ago(age)}, so most likely just not active (not a failure). It drops off the board in ${ago(c.ghostAfterMs + c.ghostDropMs - age)}.`;
      } else if (isListening(a, now, c, this.probe)) {
        [status, label] = ['listening', 'Listening'];
        why = `Finished its turn ${ago(age)} ago and is sitting in the chat, so it will answer if spoken to.${noHooks}`;
      } else if (a.stopped) {
        [status, label] = ['idle', age < MIN ? 'Idle' : `Idle ${mins(age)}min${mins(age) === 1 ? '' : 's'}`];
        why = `Reported finishing its turn ${ago(age)} ago and has said nothing since.${noHooks}`;
      } else if (age >= c.stallMs || (a.pre && now - a.pre.at >= c.stallMs)) {
        [status, label] = ['stalled', 'Stalled'];
        why = a.pre
          ? `Started "${a.activity ?? 'a task'}" ${ago(now - a.pre.at)} ago and has not reported finishing or going idle since (the limit is ${ago(c.stallMs)}). Either it is genuinely stuck, or its turn ended without saying so (no \`hive idle\`).`
          : `Marked as working, but nothing has been reported for ${ago(age)} (the limit is ${ago(c.stallMs)}).`;
      } else if (age >= this.focusAfter(a).after) {
        // Quiet for longer than usual, but not stalled: a big task, a long think, a slow tool. Still working as far as anyone can tell.
        const { usual } = this.focusAfter(a);
        [status, label] = ['active', 'Focusing'];
        why = `Quiet for ${ago(age)}${usual ? `, longer than its usual ${ago(usual)} between reports` : ''}${a.pre ? ` ("${a.activity ?? 'a task'}" still running)` : ''}, so most likely deep in something big. It is shown as stalled after ${ago(c.stallMs)} of silence.`;
      } else {
        [status, label] = ['active', 'Active Now'];
        why = `Working: last report ${ago(age)} ago${a.pre ? `, "${a.activity ?? 'a task'}" in progress` : ''}.`;
      }
      if (status === 'listening') a.lastListeningAt = now;
      const chatOpen = a.chatty === true && status !== 'ghost' && (status === 'listening' || (a.lastListeningAt !== undefined && now - a.lastListeningAt < c.chatGraceMs));
      out.push({ id: a.id, kind: 'agent', name: a.name, project: a.project, status, statusLabel: label, statusReason: why, activity: status === 'idle' || status === 'listening' ? idleLine(a, now, c, this.probe) : a.activity, chatty: a.chatty === true, user: a.user, slot: a.slot, tools: a.hooks, chatOpen, modelFamily: modelFamily(a.modelName, a.hooks), modelName: a.modelName, turns: a.sim || !this.ledger ? (a.turns ?? 0) : Math.round(this.ledger.get(a.slot ?? a.name) * 100) / 100, composing: a.composing && a.composing.until > now ? a.composing.to : undefined, reports: a.hooks === undefined ? undefined : a.hooks.length ? 'hooks' : 'chirps', updatedAt: a.lastAt });
    }
    for (const s of [...this.services.values()]) {
      const age = now - s.lastAt;
      if (age >= c.serviceDropMs) { this.services.delete(s.id); continue; }
      let status, label, activity, why;
      // What the rules make of the machine readings the service streams (none: nothing to add).
      const derived = s.samples?.length ? evaluateRules(this.rules, s.samples, now) : { status: 'ok', reasons: [], states: {} };
      const signs = derived.reasons.map((r) => r.text);
      const worst = derived.reasons.slice().sort((x, y) => (y.status === 'failure') - (x.status === 'failure'))[0];
      const beat = derived.status === 'failure' || s.beat === 'failure' ? 'failure' : derived.status === 'degraded' || s.beat === 'degraded' ? 'degraded' : 'ok';
      if (age > s.ttlMs) {
        status = 'failure'; label = 'Not responding'; why = `No heartbeat for ${ago(age)}; it should report at least every ${ago(s.ttlMs)}, so it has likely failed.`;
        activity = `${s.message ?? s.name}: no heartbeat for ${age < 2 * MIN ? 'over a minute' : plural(mins(age), 'minute')}, likely failed`;
      } else if (beat === 'failure') {
        status = 'failure'; label = 'Failure';
        activity = s.beat === 'failure' ? s.message ?? worst?.text : worst?.text;
        why = s.beat === 'failure' ? `It reported a failure ${ago(age)} ago${s.message ? `: "${s.message}"` : ''}.` : '';
      } else if (beat === 'degraded') {
        status = 'failure'; label = 'Degraded';
        activity = derived.status === 'degraded' ? worst?.text : s.message;
        why = s.beat === 'degraded' ? `It reported it is struggling ${ago(age)} ago${s.message ? `: "${s.message}"` : ''}. That shows as a failure.` : '';
      } else { status = 'active'; label = 'Healthy'; activity = s.message; why = `Last heartbeat ${ago(age)} ago.`; }
      if (signs.length) why = `${why}${why ? ' ' : ''}The Hive's rules saw: ${signs.join('; ')}.`;
      out.push({ id: s.id, kind: 'service', name: s.name, project: s.project, status, statusLabel: label, statusReason: why, activity, ...(s.metrics ? { metrics: s.metrics, metricStates: derived.states } : {}), ...(signs.length ? { signs } : {}), updatedAt: s.lastAt });
    }
    return out.sort((x, y) => SEVERITY[x.status] - SEVERITY[y.status] || x.name.localeCompare(y.name));
  }

  /** fn(members) is called with the full wall on every change. Returns an unsubscribe. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(force = true) {
    if (!this.listeners.size) return;
    const members = this.snapshot();
    const key = JSON.stringify(members.map(({ updatedAt, ...rest }) => rest));
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    for (const fn of this.listeners) fn(members);
  }

  /** Re-check on a timer so labels like "Idle 3mins" and the move to ghost reach the screen without an event. */
  start() {
    this.timer ??= setInterval(() => this.emit(false), this.cfg.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
