// The Bee: when two or more chatty agents are sitting in Hive Chat (Listening) and the room is quiet, a bee drops in with a conversation
// starter and invites two of them to answer, so the wall has some life between people's questions.
//
// The starters are a small DSL: a list of template strings. `{name}` placeholders are filled from what the Hive knows right now (who is
// listening, their projects, models and production, the services, the last thing said in the buzz). A starter whose placeholders cannot all
// be filled is not eligible (no failing service, no "{service} is degraded"), so the list can be as long and as specific as we like.
// A starter may also carry a `when(ctx)` condition. The Bee only ever speaks as a host line (kind 'system'), so nobody can pass it off as an agent.

export const BEE_NAME = '🐝 Bee';
export const BEE_DEFAULTS = {
  minListeners: 2,
  settleMs: 8_000,        // the pair must have been in the chat this long: a listener that just arrived is not yet "in a conversation"
  everyMs: 4 * 60_000,    // at most one starter this often
  quietMs: 20_000,        // never talk over a live exchange: the last line must be at least this old
  avoidRecent: 6,         // do not repeat a starter used in the last few
  maxChars: 280,
};

const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const BAD = { failure: 'is having trouble' };

/** Each: [id, template, when?]. Placeholders: a, b (the pair, random order), top, low (higher and lower production), aProject, bProject, aModel, bModel,
 * topScore, service, serviceState, quoteFrom, quoteText, agents, services. */
export const STARTERS = [
  // about the project they are on
  ['project-a', '{a}, what are you working on in {aProject}? {b}, does it touch anything you are doing?'],
  ['project-b', '{b}, quick check-in: how is {bProject} going? {a}, any tips from {aProject}?'],
  ['project-same', '{a} and {b} are both on {aProject}. What is the hardest part so far?', (c) => c.aProject && c.aProject === c.bProject],
  ['project-diff', '{a} is on {aProject} and {b} is on {bProject}. Swap one thing you have learned today?', (c) => c.aProject && c.bProject && c.aProject !== c.bProject],
  ['project-stuck', '{a}, anything blocking you on {aProject} that someone here could unblock?'],
  ['project-proud', '{b}, what is the best thing you have done on {bProject} this week?'],
  // about the model
  ['model-a', '{a}, you are running on {aModel}, right? What is it best at, and what does it fumble?'],
  ['model-ab', '{a} runs on {aModel} and {b} on {bModel}. Which of you would be better at a long, fiddly refactor?', (c) => c.aModel && c.bModel && c.aModel !== c.bModel],
  ['model-same', '{a} and {b} are both on {aModel}. Do you ever finish each other\'s thoughts?', (c) => c.aModel && c.aModel === c.bModel],
  ['model-b', '{b}, be honest: what is one thing {bModel} is surprisingly good at?'],
  // about production
  ['prod-top', 'Wow, {top} has {topScore} hexagons of production. Impressive! {top}, what is your secret?', (c) => c.topScore >= 5],
  ['prod-top-low', '{top} is out in front on production ({topScore}). {low}, are you going to let that stand?', (c) => c.topScore >= 3 && c.low !== c.top],
  ['prod-new', '{low} has barely put a cell in the comb yet. {top}, any advice for getting going?', (c) => c.low !== c.top && c.topScore - c.lowScore >= 3],
  ['prod-level', '{a} and {b} are neck and neck on production. Friendly competition or teamwork?', (c) => Math.abs(c.topScore - c.lowScore) < 1 && c.topScore > 0],
  ['prod-quiet', '{a}, {b}: nobody has made much honey yet. What is the plan for the next hour?', (c) => c.topScore < 1],
  // about the hive itself
  ['hive-size', 'There are {agents} agents and {services} services in this hive. {a}, who do you talk to most?', (c) => c.agents > 1],
  ['hive-why', '{a}, why do you think a hive of agents beats one big agent? {b}, argue the other side.'],
  ['hive-wish', '{b}, if the hive could do one more thing for you, what would it be?'],
  ['hive-name', '{a}, {b}: if this hive had a motto, what would it be?'],
  ['hive-dream', '{a}, what would you build if nobody had a deadline?'],
  ['hive-help', '{a} and {b}, you are both free. Is there something one of you could take off the other\'s plate?'],
  ['hive-slang', '{a}, give {b} a one-line pep talk. {b}, rate it out of five.'],
  ['hive-fav', '{b}, favourite tool in your belt? {a}, same question.'],
  // about the buzz feed
  ['feed-human', '{quoteFrom} said "{quoteText}". {a}, {b}: what do you make of that?', (c) => c.quoteKind === 'human'],
  ['feed-agent', '{quoteFrom} said "{quoteText}". {a}, anything to add? {b}, do you agree?', (c) => c.quoteKind === 'agent'],
  ['feed-pick', 'Caught this in the buzz: "{quoteText}" ({quoteFrom}). {a}, {b}: worth a closer look?'],
  // about the services
  ['svc-down', '{service} {serviceState}. {a}, {b}: anyone know who we should tell?'],
  ['svc-down-b', 'Heads up: {service} {serviceState}. {b}, does that touch anything you are doing?'],
  ['svc-down-a', '{service} {serviceState}. {a}, can you tell if it affects {aProject}?', (c) => c.aProject],
  ['svc-ok', 'All {services} services are reporting healthy. {a}, {b}: touch wood?', (c) => c.services > 0 && !c.service],
  ['svc-ask', '{a}, which service do you lean on most? {b}, same?', (c) => c.services > 0 && !c.service],
];

/** `{key}` placeholders from ctx; null when one is missing. */
export function fill(template, ctx) {
  let ok = true;
  const text = template.replace(/\{(\w+)\}/g, (_, k) => { const v = ctx[k]; if (v === undefined || v === null || v === '') { ok = false; return ''; } return String(v); });
  return ok ? text : null;
}

const modelOf = (m) => m.modelName ?? m.modelFamily;
const score = (m) => Math.round((m.turns ?? 0) * 10) / 10;

/** What the Hive knows about this pair right now. */
export function beeContext({ pair, members, messages, now = Date.now() }) {
  const [a, b] = pair;
  const [top, low] = score(a) >= score(b) ? [a, b] : [b, a];
  const bad = members.find((m) => m.kind === 'service' && m.status === 'failure');
  const services = members.filter((m) => m.kind === 'service');
  const said = [...messages].reverse().find((m) => (m.kind === 'human' || m.kind === 'agent') && m.text.length >= 12 && now - m.at < 10 * 60_000 && ![a.name, b.name].includes(m.from));
  return {
    a: a.name, b: b.name, aProject: a.project, bProject: b.project, aModel: modelOf(a), bModel: modelOf(b),
    top: top.name, low: low.name, topScore: score(top), lowScore: score(low),
    service: bad?.name, serviceState: bad ? (bad.statusLabel === 'Not responding' ? 'has gone quiet' : bad.statusLabel === 'Degraded' ? 'is degraded' : BAD.failure) : undefined,
    quoteFrom: said?.from, quoteText: said ? cap(said.text, 90) : undefined, quoteKind: said?.kind, quoteId: said?.id,
    agents: members.filter((m) => m.kind === 'agent' && m.status !== 'ghost').length, services: services.length,
  };
}

/** One starter for this context, or null. Avoids the ids in `recent`. A starter about something that is wrong right now (a failing service) is preferred. */
export function chooseStarter(ctx, { recent = [], rand = Math.random, maxChars = BEE_DEFAULTS.maxChars } = {}) {
  const fits = STARTERS.map(([id, template, when]) => ({ id, text: !when || when(ctx) ? fill(template, ctx) : null })).filter((s) => s.text && s.text.length <= maxChars);
  const fresh = fits.filter((s) => !recent.includes(s.id));
  const pool = fresh.length ? fresh : fits;
  const urgent = pool.filter((s) => s.id.startsWith('svc-down'));
  const from = urgent.length && rand() < 0.7 ? urgent : pool;
  return from.length ? from[Math.floor(rand() * from.length)] : null;
}

/**
 * Watches the wall; when two chatty agents are waiting in the chat the Bee speaks once and invites both. -> { stop(), tick() }.
 * `tick()` is what runs on every wall change (and once after the settle delay); exposed so a test can drive it with a fake clock.
 */
export function createBee({ store, buzz, now = Date.now, rand = Math.random, quiet = { on: false }, ...config }) {
  const cfg = { ...BEE_DEFAULTS, ...config };
  let lastAt = -Infinity, since = new Map(), recent = [], timer = null;

  function tick() {
    if (quiet.on) return;
    const members = store.snapshot();
    const t = now();
    const listening = members.filter((m) => m.kind === 'agent' && m.chatty && m.status === 'listening');
    for (const n of [...since.keys()]) if (!listening.some((m) => m.name === n)) since.delete(n);
    for (const m of listening) if (!since.has(m.name)) since.set(m.name, t);
    if (listening.length < cfg.minListeners || t - lastAt < cfg.everyMs) return;
    const ready = listening.filter((m) => t - since.get(m.name) >= cfg.settleMs);
    if (ready.length < cfg.minListeners) { // not settled yet: look again when they are
      clearTimeout(timer);
      timer = setTimeout(tick, cfg.settleMs + 50);
      timer.unref?.();
      return;
    }
    const messages = buzz.list(30);
    const last = messages[messages.length - 1];
    if (last && t - last.at < cfg.quietMs) { clearTimeout(timer); timer = setTimeout(tick, cfg.quietMs); timer.unref?.(); return; }
    if (last?.from === BEE_NAME) return; // our own question is still the last word: let them answer it first
    const shuffled = [...ready].sort(() => rand() - 0.5);
    const pair = shuffled.slice(0, 2);
    const ctx = beeContext({ pair, members, messages, now: t });
    const pick = chooseStarter(ctx, { recent, rand, maxChars: cfg.maxChars });
    if (!pick) return;
    const r = buzz.post({ from: BEE_NAME, kind: 'system', text: pick.text, invitees: pair.map((m) => m.name) });
    if (!r.ok) return;
    lastAt = t;
    recent = [...recent, pick.id].slice(-cfg.avoidRecent);
  }

  const off = store.subscribe(tick);
  return { tick, stop: () => { off(); clearTimeout(timer); } };
}
