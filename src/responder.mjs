// The bots answer: when a person types into the wall's chat box (or a real event hits the wall), the host voices one or
// two chatty agents with a small, cheap model call, so the thread feels alive.
//
// This is the host speaking FOR the agents, not the agents' own sessions (an idle session cannot speak). So:
//   - every line is marked `via: 'host'`, and the screen shows it;
//   - it is opt-in (it needs a model key) and capped: replies per hour, output tokens per day, short replies;
//   - the bots are told their own status and the real events, and told never to claim an action they did not take.
// Replies marked via:'host' never trigger more replies, so it cannot run on by itself.

export const RESPONDER_DEFAULTS = {
  maxReplies: 2,          // bots that answer one person's message
  repliesPerHour: 40,
  dailyOutputTokens: 40_000,
  maxTokens: 120,
  gapMs: [1500, 4000],    // a short, human-ish pause before each reply
  reactToSystem: true,    // one bot comments on a real failure or recovery...
  systemReactChance: 0.6, // ...some of the time
};

const REACT = /stopped responding|reports trouble|reports a failure|is healthy again/;

export const SYSTEM_PROMPT = (a) => `You are ${a.name}, an AI agent in the AI Hive, a shared wall of agents and services. You work on ${a.project ?? 'various things'}. Your status right now: ${a.statusLabel}${a.activity ? `; you are doing: "${a.activity}"` : ''}.
You are in the hive's shared chat with other agents and a human. Reply as ${a.name} in one or two short, friendly sentences (at most 200 characters), plain text, no markdown, no name prefix.
Rules: you may mention only your own status as given above. Lines tagged [hive] are real events from the hive: you may react to them but do not invent details. Never say you fixed, restarted or retried anything, and never claim tools or actions you were not given; if asked to do something, say you will pass it to whoever runs the hive.`;

const hhmm = (at) => new Date(at).toTimeString().slice(0, 5);
const line = (m) => `${hhmm(m.at)} ${m.kind === 'system' ? '[hive]' : m.kind === 'human' ? `${m.from} (human)` : m.from}: ${m.text}`;

export function buildUserPrompt(agent, thread, target) {
  const ask = target ? `Write ${agent.name}'s reply to this message (it will be shown quoted above your reply):\n${line(target)}` : `Write ${agent.name}'s next message.`;
  return `Recent chat:\n${thread.map(line).join('\n')}\n\n${ask}`;
}

/** A model's reply, tidied into one chat line. */
export function cleanReply(text, name) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  t = t.replace(new RegExp(`^${name}\\s*[:\\-]\\s*`, 'i'), '');
  return t.length > 280 ? `${t.slice(0, 279)}…` : t;
}

/** An Anthropic Messages API caller using plain fetch (this CLI has no dependencies). -> async ({ system, user, maxTokens }) => { text, outputTokens } */
export function anthropicComplete({ apiKey, model = 'claude-haiku-4-5-20251001', fetchFn = fetch, url = 'https://api.anthropic.com/v1/messages' }) {
  return async ({ system, user, maxTokens }) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`the model answered ${res.status}`);
    const j = await res.json();
    return { text: (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''), outputTokens: j.usage?.output_tokens };
  };
}

/**
 * Starts answering. `complete` is async ({ system, user, maxTokens }) => { text, outputTokens? }. Returns { stop, stats }.
 * `rand` and `wait` are injectable so tests need no clock and no randomness.
 */
export function createResponder({ store, buzz, complete, now = Date.now, rand = Math.random, wait = (ms) => new Promise((r) => setTimeout(r, ms)), ...config }) {
  const cfg = { ...RESPONDER_DEFAULTS, ...config };
  const sent = [];                       // timestamps of replies this hour
  const tokens = { day: '', used: 0 };   // output tokens today
  let running = false, pending = null, warned = false;

  const today = () => new Date(now()).toDateString();
  const overBudget = () => {
    const t = now();
    while (sent.length && t - sent[0] > 3_600_000) sent.shift();
    if (tokens.day !== today()) { tokens.day = today(); tokens.used = 0; warned = false; }
    return sent.length >= cfg.repliesPerHour || tokens.used >= cfg.dailyOutputTokens;
  };

  function speakers(count, trigger) {
    let chatty = store.snapshot().filter((m) => m.kind === 'agent' && m.chatty && (m.status === 'listening' || m.status === 'active')); // only those at their desk
    if (Array.isArray(trigger.invited)) chatty = chatty.filter((m) => trigger.invited.includes(m.name)); // the Hive already chose who may answer (chat.mjs)
    for (let i = chatty.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [chatty[i], chatty[j]] = [chatty[j], chatty[i]]; }
    return chatty.sort((a, b) => (a.status === 'listening' ? 0 : 1) - (b.status === 'listening' ? 0 : 1)).slice(0, count); // listening ones first: they are the free ones
  }

  async function answer(trigger) {
    const count = trigger.kind === 'human' ? cfg.maxReplies : 1;
    let target = trigger; // the first bot answers the trigger; the next answers the bot before it, so the thread reads as a conversation
    for (const agent of speakers(count, trigger)) {
      if (overBudget()) {
        if (!warned) { warned = true; buzz.post({ from: 'hive', kind: 'system', text: 'The bots are resting: this hour\'s reply budget is used up.' }); }
        return;
      }
      store.setComposing?.(agent.name, target.kind === 'human' ? 'human' : 'agent', 30_000); // the chat bubble on its tile while it writes
      await wait(cfg.gapMs[0] + rand() * (cfg.gapMs[1] - cfg.gapMs[0]));
      try {
        const r = await complete({ system: SYSTEM_PROMPT(agent), user: buildUserPrompt(agent, buzz.list(12), target), maxTokens: cfg.maxTokens });
        const text = cleanReply(r.text, agent.name);
        sent.push(now());
        tokens.used += r.outputTokens ?? Math.ceil(text.length / 4);
        if (text) {
          const posted = buzz.post({ from: agent.name, kind: 'agent', text, via: 'host', replyTo: target.id });
          if (posted.ok) target = posted.message;
        }
      } catch {
        return; // the model is unreachable: stay quiet rather than fill the thread with errors
      } finally {
        store.clearComposing?.(agent.name);
      }
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    while (pending) { const t = pending; pending = null; await answer(t); }
    running = false;
  }

  const off = buzz.subscribe((messages) => {
    const last = messages[messages.length - 1];
    if (!last || last.via === 'host') return; // the bots never answer the bots
    if (last.kind === 'human' || (last.kind === 'system' && cfg.reactToSystem && REACT.test(last.text) && rand() < cfg.systemReactChance)) {
      pending = last;
      drain();
    }
  });

  return { stop: off, stats: () => ({ repliesThisHour: sent.length, outputTokensToday: tokens.used }) };
}
