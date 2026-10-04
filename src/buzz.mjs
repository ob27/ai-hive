// Buzz: the Hive's chat. A short, shared thread where agents that opted in (`hive join --chatty`) say a line
// ("phew, that was a hard one") and the host posts what really happened ("DSL Service stopped responding").
//
// Two kinds of line, deliberately told apart:
//   agent   — said by a chatty agent through `hive buzz`. Capped per agent so small talk cannot run away.
//   human   — typed by a person into the wall's chat box. Capped per client so a stranger on the network cannot flood it.
//   system  — posted by the host from real status changes. Nothing else may write these, so an agent can chat about
//             a service but cannot make the thread claim it was fixed.
// In memory only: the thread is a bit of life on the wall, not a record.

import { CHAT_DEFAULTS, repliesTo } from './chat.mjs';

export const BUZZ_DEFAULTS = { keep: 200, maxChars: 280, perHour: 12, humanPerHour: 30, ...CHAT_DEFAULTS };

export class BuzzLog {
  /** `invite(message, thread)` -> the names allowed to answer a new line (see chat.mjs). Without it every listener hears every line. */
  constructor({ now = Date.now, invite = null, ...config } = {}) {
    this.now = now;
    this.invite = invite;
    this.waiting = new Map(); // name -> open `hive listen` waits: the only proof an agent is actually in the chat
    this.onListenChange = null; // (name): that agent started or stopped waiting in the chat
    this.onDelivered = null;  // (name, lines): `hive listen` just handed these lines to an agent, so it is now writing its answer
    this.onPosted = null;     // (name): an agent has spoken
    this.pokes = new Map();   // name -> resolvers of that agent's open waits, so a tap on the shoulder can wake them
    this.cfg = { ...BUZZ_DEFAULTS, ...config };
    this.messages = [];
    this.byAgent = new Map(); // name -> timestamps of recent agent lines
    this.nextId = 1;
    this.listeners = new Set();
  }

  /**
   * { ok: true, message } or { ok: false, error, status } (status is the HTTP code to answer with).
   * `via: 'host'` marks an agent line the host wrote on the agent's behalf (see responder.mjs) rather than the agent itself.
   * `limitKey` is who a human line is rate-limited as (a client address).
   * `replyTo` is the id of the line this one answers; the message carries a snapshot of it (`quote`) so the screen can show it
   * quoted, and the quote survives the original scrolling out of the thread. An unknown id is ignored.
   */
  post({ from, kind = 'agent', text, via, limitKey, replyTo }) {
    const body = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!from) return { ok: false, status: 400, error: 'from is required' };
    if (!body) return { ok: false, status: 400, error: 'text is required' };
    if (body.length > this.cfg.maxChars) return { ok: false, status: 400, error: `text must be at most ${this.cfg.maxChars} characters` };
    const now = this.now();
    if (kind === 'agent') {
      const recent = (this.byAgent.get(from) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= this.cfg.perHour) return { ok: false, status: 429, error: `${from} has buzzed ${this.cfg.perHour} times this hour; try again later` };
      this.byAgent.set(from, [...recent, now]);
    }
    if (kind === 'human') {
      const key = `human:${limitKey ?? from}`;
      const recent = (this.byAgent.get(key) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= this.cfg.humanPerHour) return { ok: false, status: 429, error: `that is ${this.cfg.humanPerHour} messages this hour; try again later` };
      this.byAgent.set(key, [...recent, now]);
    }
    const target = Number.isInteger(replyTo) ? this.messages.find((m) => m.id === replyTo) : undefined;
    // A line that invited people is answered only by them, and only until it has its quota of answers (a host-voiced reply is exempt).
    if (kind === 'agent' && !via && target?.invited) {
      if (!target.invited.includes(from)) return { ok: false, status: 409, error: `#${target.id} was not for you (it asked ${target.invited.join(', ') || 'nobody'}): stay quiet` };
      if (repliesTo(this.messages, target.id).length >= this.cfg.maxReplies) return { ok: false, status: 409, error: `#${target.id} has already been answered: stay quiet` };
    }
    const quote = target ? { id: target.id, from: target.from, kind: target.kind, text: target.text.length > 140 ? `${target.text.slice(0, 139)}…` : target.text } : undefined;
    const invited = this.invite && !via ? this.invite({ from, kind, text: body, replyTo: target?.id }, this.messages) : undefined;
    const message = { id: this.nextId++, at: now, from, kind, text: body, ...(via ? { via } : {}), ...(quote ? { quote } : {}), ...(invited ? { invited } : {}) };
    this.messages.push(message);
    if (this.messages.length > this.cfg.keep) this.messages.splice(0, this.messages.length - this.cfg.keep);
    for (const fn of this.listeners) fn(this.messages);
    if (kind === 'agent') this.onPosted?.(from);
    return { ok: true, message };
  }

  /** Removes every line `shouldRemove(message)` is true for (used when the simulated crowd is sent away) and tells subscribers. */
  prune(shouldRemove) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !shouldRemove(m));
    if (this.messages.length !== before) for (const fn of this.listeners) fn(this.messages);
  }

  list(limit = 50) {
    return this.messages.slice(-Math.max(1, Math.min(limit, this.cfg.keep)));
  }

  /**
   * Lines newer than `afterId` that `name` did not write itself. Resolves at once if there are some, otherwise when one arrives, or
   * with [] after `waitMs`. This is what lets a seated agent sit in the chat: it blocks here, costing nothing, until someone speaks.
   */
  /** End `name`'s open waits at once with nothing (the caller then looks for what woke it, e.g. a tap on the shoulder). */
  poke(name) { for (const wake of [...(this.pokes.get(name) ?? [])]) wake(); }

  isWaiting(name) { return (this.waiting.get(name) ?? 0) > 0; }

  waitFor(afterId, name, waitMs) {
    const later = { at: Infinity }; // when a staggered line becomes ours, so the wait wakes then and not only on a new line
    const fresh = () => {
      later.at = Infinity;
      return this.messages.filter((m) => m.id > afterId && this.hearable(m, name, later));
    };
    const now = fresh();
    if (now.length) this.onDelivered?.(name, now);
    if (now.length || waitMs <= 0) return Promise.resolve(now);
    this.waiting.set(name, (this.waiting.get(name) ?? 0) + 1);
    this.onListenChange?.(name);
    return new Promise((resolve) => {
      let off = () => {}, tick = null;
      const wake = () => done([]);
      this.pokes.set(name, [...(this.pokes.get(name) ?? []), wake]);
      const done = (lines) => {
        clearTimeout(timer); clearTimeout(tick); off();
        const rest = (this.pokes.get(name) ?? []).filter((f) => f !== wake);
        if (rest.length) this.pokes.set(name, rest); else this.pokes.delete(name);
        if (lines.length) this.onDelivered?.(name, lines);
        const n = (this.waiting.get(name) ?? 1) - 1;
        if (n > 0) this.waiting.set(name, n); else this.waiting.delete(name);
        resolve(lines);
        this.onListenChange?.(name);
      };
      let endsAt = Date.now() + waitMs;
      const cap = endsAt + this.cfg.extendMs;
      let timer = setTimeout(() => done([]), waitMs); // not unref'd: whoever awaits this wait must be kept alive until it ends
      const check = () => {
        const got = fresh();
        if (got.length) return done(got);
        clearTimeout(tick);
        if (later.at !== Infinity) {
          const wait = Math.max(50, later.at - this.now());
          tick = setTimeout(check, wait);
          // A line that is ours but still queued behind an earlier invitee must not be missed because this wait ran out a moment before
          // its turn: stretch the wait to cover it (within extendMs).
          const want = Math.min(Date.now() + wait + 500, cap);
          if (want > endsAt) { endsAt = want; clearTimeout(timer); timer = setTimeout(() => done([]), endsAt - Date.now()); }
        }
      };
      off = this.subscribe(check);
      check();
    });
  }

  /**
   * Is this line one `name` should be handed by `hive listen`? Never your own line. A line that invited people goes only to them: the
   * first at once, the next once the one before has answered (or after staggerMs), and not once it is stale. Lines that invited nobody
   * stay on the wall for people to read but wake no agent.
   */
  hearable(m, name, later = { at: Infinity }) {
    if (m.from === name) return false;
    if (!m.invited) return true;
    const i = m.invited.indexOf(name);
    if (i < 0) return false;
    const now = this.now();
    if (now - m.at > this.cfg.staleMs) return false;
    if (i === 0 || repliesTo(this.messages, m.id).length >= i) return true;
    const at = m.at + i * this.cfg.staggerMs;
    if (now < at) later.at = Math.min(later.at, at);
    return now >= at;
  }

  /** fn(messages) gets the whole thread on every new line. Returns an unsubscribe. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Turns real changes on the wall into system lines: someone joining or leaving, and a service failing or recovering.
 * Agent status changes are not announced (too noisy). The first snapshot only seeds what is already there.
 * While `quiet.on` is true changes are noted but not announced (seating or removing the whole simulated crowd at once).
 */
export function watchHive(store, buzz, quiet = { on: false }) {
  let prev = null;
  return store.subscribe((members) => {
    const now = new Map(members.map((m) => [m.id, m]));
    if (prev && !quiet.on) {
      for (const m of members) {
        const before = prev.get(m.id);
        if (!before) {
          buzz.post({ from: 'hive', kind: 'system', text: m.kind === 'service' ? `${m.name} is reporting in.` : `${m.name} joined the hive.` });
        } else if (m.kind === 'service' && before.status !== 'failure' && m.status === 'failure') {
          const why = m.statusLabel === 'Not responding' ? 'stopped responding and has likely failed' : m.statusLabel === 'Degraded' ? 'reports trouble' : 'reports a failure';
          buzz.post({ from: 'hive', kind: 'system', text: `${m.name} ${why}${m.activity && m.statusLabel !== 'Not responding' ? `: ${m.activity}` : '.'}` });
        } else if (m.kind === 'service' && before.status === 'failure' && m.status !== 'failure') {
          buzz.post({ from: 'hive', kind: 'system', text: `${m.name} is healthy again.` });
        }
      }
      for (const [id, before] of prev) {
        if (!now.has(id)) buzz.post({ from: 'hive', kind: 'system', text: before.kind === 'service' ? `${before.name} signed off.` : before.status === 'ghost' ? `${before.name} drifted away.` : `${before.name} left the hive.` });
      }
    }
    prev = now;
  });
}
