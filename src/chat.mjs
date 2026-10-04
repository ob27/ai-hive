// Who should answer a line in the buzz. With many chatty agents a question would get a dozen overlapping answers, so the Hive
// decides, not the agents: each line invites at most a couple of them (the ones the line names, then the free ones), `hive listen`
// only hands a line to an agent that was invited, and a reply to a line is refused once it has its quota.
//
// Silence is the default. Ambient lines ("phew, that was a hard one", "X joined the hive") invite nobody, a line from a person invites
// up to `maxReplies`, a real failure or recovery invites one, and a bot's answer invites at most one more bot until the thread is
// `botDepth` bot turns deep, so two bots cannot keep each other talking.

export const CHAT_DEFAULTS = {
  maxReplies: 2,     // answers one person's line can get
  botDepth: 2,       // bot-to-bot turns after a person's line before the thread goes quiet
  staggerMs: 6_000,  // the second invitee waits this long for the first to answer (or hears it at once if the first already has)
  extendMs: 8_000,   // a listen that ends just before a queued line becomes its own is stretched by up to this much to catch it
  staleMs: 180_000,  // a line this old is no longer worth waking an agent for
};

/** What the Hive says itself when a person posts and nobody is there to answer. */
export const NOBODY_MESSAGE = 'Sorry, no one is available to respond right now. Check back in 5 mins.';
export const AWAY_MESSAGE = 'Sorry, everyone is busy at the moment. Check back in 5 mins.';

const REACT = /stopped responding|reports trouble|reports a failure|is healthy again/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bots that answered `target`. */
export const repliesTo = (messages, id) => messages.filter((m) => m.quote?.id === id && m.kind === 'agent');

/** How many bot hops deep a line is: a person's line is 0, a bot answering it 1, a bot answering that 2… */
export function botDepth(messages, m) {
  let depth = 0, cur = m;
  while (cur?.kind === 'agent' && cur.quote) { depth++; cur = messages.find((x) => x.id === cur.quote.id) ?? (cur.quote.kind === 'agent' ? { kind: 'agent', quote: null } : null); }
  return depth;
}

/**
 * The names to invite for `message` (before it is posted, so it has no id yet). `store` is the HiveStore, `messages` the thread so far.
 * Returns [] when nobody should answer.
 */
export function chooseInvitees(store, messages, message, { rand = Math.random, ...config } = {}) {
  const cfg = { ...CHAT_DEFAULTS, ...config };
  const chatty = store.snapshot().filter((m) => m.kind === 'agent' && m.chatty && m.name !== message.from && m.status !== 'ghost');
  let slots = 0;
  if (message.kind === 'human') slots = cfg.maxReplies;
  else if (message.kind === 'system') slots = REACT.test(message.text) ? 1 : 0;
  else if (message.kind === 'agent' && message.replyTo !== undefined) {
    const target = messages.find((m) => m.id === message.replyTo);
    if (target && botDepth(messages, { ...message, quote: { id: target.id, kind: target.kind } }) < cfg.botDepth) slots = 1;
  }
  const named = message.kind === 'system' ? [] : chatty.filter((m) => new RegExp(`\\b${escape(m.name)}\\b`, 'i').test(message.text) && m.status !== 'idle');
  if (slots === 0 && !named.length) return [];
  const target = messages.find((m) => m.id === message.replyTo);
  const free = (list) => list.filter((m) => !named.includes(m) && m.name !== target?.from);
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const picks = [...named, ...shuffle(free(chatty.filter((m) => m.status === 'listening'))), ...shuffle(free(chatty.filter((m) => m.status === 'active')))];
  return [...new Set(picks.map((m) => m.name))].slice(0, Math.max(slots, named.length));
}
