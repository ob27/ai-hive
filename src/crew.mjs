// Crew: several chatty agents working at the same time on one project. Each finishes its own piece, but nobody owns the last steps:
// testing it all together, integrating it, and committing and pushing if the person asked. So the Hive makes the last one standing own them.
//
//   1. Aware    An agent that finds a crewmate working on its project is told who, and to leave a note if it finishes first.
//   2. Notes    `hive handoff "<what I changed, what to test, whether I was asked to commit and push>"` leaves one (shown in the buzz).
//   3. Last     When an agent stops and nobody else on the project is still working, the notes are put in front of it: test, integrate, and
//               commit and push if a note says so. (It reaches the agent as the next instruction on its end-of-turn hook.)
//   4. Nobody   If nobody takes the notes (the last agent went idle before the note landed, or ignored it) the Hive looks for a free chatty agent
//               on the same machine to do it. If there is none, it answers on the idle agents' behalf ("no time, tell the humans") and posts an
//               announcement with the notes and a Copy button, so a person can pick them up.
//
// Only chatty agents take part (they are the ones the Hive can talk to), and "the same project" is simply the same project name.

export const CREW_DEFAULTS = {
  graceMs: 30_000,     // a note nobody could take is left this long before the Hive goes looking for help
  ackMs: 90_000,       // a note given to an agent that does not start working within this long was ignored
  noteChars: 240,
  maxNotes: 8,
  keepMs: 60 * 60_000, // notes older than this are dropped
  helpers: 2,          // free agents to try before giving up
};

export const DECLINES = [
  'Sorry, I won\'t have time for that. Please let the humans know.',
  'I can\'t pick that up right now, best to tell a human.',
  'No capacity here, flagging it for the humans.',
  'I\'m not able to take that on, please pass it to a person.',
  'Can\'t get to it, someone human will need to look.',
];

const isActive = (m) => m.status === 'active';
const resting = (m) => m.status === 'listening' || m.status === 'idle';
const list = (names) => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export const notesText = (notes) => notes.map((n) => `- ${n.from}: ${n.text}`).join('\n');
const FINISH = 'Test everything together, fix what does not work, and integrate it. If any note says its author was asked to commit and push, do that too once it all passes.';

/** What an agent is told when it is working alongside others. */
export const AWARE = (others, me) => `${list(others)} ${others.length === 1 ? 'is' : 'are'} working on this project at the same time as you. If you finish before them, run \`hive handoff "<what you changed, what needs testing or integrating, and whether you were asked to commit and push>" --seat ${me}\` so whoever finishes last can test and integrate it. Do not do their parts, and keep going with your own work.`;
export const ASK = (others, me) => `You are finishing, but ${list(others)} ${others.length === 1 ? 'is' : 'are'} still working on this project. Before you stop, run \`hive handoff "<what you changed, what needs testing or integrating, and whether you were asked to commit and push>" --seat ${me}\` so whoever finishes last can pick it up. Then finish your turn.`;
export const LAST = (project, notes) => `You are the last one working on ${project}. Colleagues left you these handoff notes:\n${notesText(notes)}\n${FINISH}`;
export const TASK_PROMPT = (task) => `Nobody picked up the handoff notes for ${task.project}. You are free, so please take them:\n${notesText(task.notes)}\n${FINISH} Work in the project folders you share with these agents; if you are not in the right place, say so in the hive chat and stop.`;

export function createCrew({ store, buzz, now = Date.now, rand = Math.random, quiet = { on: false }, ...config }) {
  const cfg = { ...CREW_DEFAULTS, ...config };
  const notes = new Map();     // project -> [{ id, from, fromId, text, at, state: 'pending' | 'given', to, toAt, line }]
  const told = new Set();      // agent ids already told about their crew in this stretch of work
  const asked = new Set();     // ids already asked for a note when they stopped
  const tried = new Map();     // project -> names of helpers already asked
  const prev = new Map();      // agent id -> last status

  const crewOf = (members) => members.filter((m) => m.kind === 'agent' && m.chatty && m.project && !store.agents.get(m.id)?.sim && m.status !== 'ghost' && m.status !== 'offline');
  const byProject = (members) => { const g = new Map(); for (const m of crewOf(members)) g.set(m.project, [...(g.get(m.project) ?? []), m]); return g; };
  const give = (id, text) => { store.inbox.set(id, store.inbox.has(id) ? `${store.inbox.get(id)}\n\n${text}` : text); };
  const idOfName = (name) => store.findAgent(name)?.id;
  const machine = (name) => store.findAgent(name)?.addr;

  /** Leaves a note for the project's last finisher. { ok } or { ok: false, status, error }. */
  function addNote(name, text) {
    const agent = store.snapshot().find((m) => m.kind === 'agent' && m.name === name);
    if (!agent) return { ok: false, status: 404, error: `${name} is not in the hive` };
    if (!agent.chatty) return { ok: false, status: 403, error: `${name} is not in chatty mode: rejoin with  hive join … --chatty` };
    if (!agent.project) return { ok: false, status: 400, error: `${name} has no project, so there is no crew to hand off to` };
    const body = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!body) return { ok: false, status: 400, error: 'a handoff note is required' };
    const clean = body.length > cfg.noteChars ? `${body.slice(0, cfg.noteChars - 1)}…` : body;
    const mine = notes.get(agent.project) ?? [];
    if (mine.length >= cfg.maxNotes) return { ok: false, status: 429, error: 'this project already has plenty of handoff notes waiting' };
    const posted = buzz.post({ from: 'hive', kind: 'system', text: `📝 ${name} left a handoff note for whoever finishes last on ${agent.project}: ${clean}`, meta: { handoff: { project: agent.project, from: name } } });
    notes.set(agent.project, [...mine, { id: `${name}:${now()}`, from: name, fromId: agent.id, text: clean, at: now(), state: 'pending', line: posted.ok ? posted.message.id : undefined }]);
    check();
    return { ok: true };
  }

  function check(members = store.snapshot()) {
    if (quiet.on) return;
    const groups = byProject(members);
    for (const [project, crew] of groups) {
      const active = crew.filter(isActive);
      // 1. Aware
      if (active.length >= 2) for (const m of active) if (!told.has(m.id)) { told.add(m.id); give(m.id, AWARE(active.filter((o) => o !== m).map((o) => o.name), m.name)); }
      // 2. Someone just stopped
      for (const m of crew) {
        if (prev.get(m.id) !== 'active' || !resting(m)) continue;
        const others = active.filter((o) => o !== m);
        const mine = (notes.get(project) ?? []).some((n) => n.fromId === m.id);
        if (others.length) {
          if (!mine && !asked.has(m.id)) { asked.add(m.id); give(m.id, ASK(others.map((o) => o.name), m.name)); }
        } else {
          const mineToDo = (notes.get(project) ?? []).filter((n) => n.state === 'pending' && n.fromId !== m.id);
          if (mineToDo.length) { for (const n of mineToDo) Object.assign(n, { state: 'given', to: m.name, toAt: now() }); give(m.id, LAST(project, mineToDo)); }
        }
      }
      if (!active.length) for (const m of crew) { told.delete(m.id); asked.delete(m.id); }
    }
    // A note given to an agent that then started working was taken up.
    for (const [project, list_] of notes) {
      const kept = list_.filter((n) => !(n.state === 'given' && members.some((m) => m.kind === 'agent' && m.name === n.to && isActive(m) && m.updatedAt >= n.toAt)) && now() - n.at < cfg.keepMs);
      if (kept.length) notes.set(project, kept); else notes.delete(project);
    }
    for (const m of members) if (m.kind === 'agent') prev.set(m.id, m.status);
  }

  /** Looks for notes nobody is going to pick up, and finds them a taker (or a person). */
  function sweep() {
    if (quiet.on) return;
    const t = now();
    const members = store.snapshot();
    for (const [project, list_] of notes) {
      for (const n of list_) if (n.state === 'given' && t - n.toAt >= cfg.ackMs) n.state = 'pending'; // handed over and ignored
      const open = list_.filter((n) => n.state === 'pending');
      if (!open.length || t - Math.min(...open.map((n) => n.at)) < cfg.graceMs) continue;
      const crew = crewOf(members).filter((m) => m.project === project);
      if (crew.some(isActive)) continue; // somebody is still working: the notes go to them when they stop
      const tryList = tried.get(project) ?? [];
      const authors = open.map((n) => machine(n.from)).filter(Boolean);
      const free = members.filter((m) => m.kind === 'agent' && m.chatty && !store.agents.get(m.id)?.sim && m.status === 'listening' && !tryList.includes(m.name) && !open.some((n) => n.from === m.name) && (!authors.length || authors.includes(machine(m.name))));
      if (free.length && tryList.length < cfg.helpers) {
        const helper = free.find((m) => m.project === project) ?? free[Math.floor(rand() * free.length)];
        tried.set(project, [...tryList, helper.name]);
        const payload = { project, notes: open.map((n) => ({ from: n.from, text: n.text })) };
        const r = buzz.post({ from: 'hive', kind: 'system', text: `Nobody on ${project} picked up ${list([...new Set(open.map((n) => n.from))])}'s handoff notes. ${helper.name}, you are free and on the same machine: can you test and integrate them?`, invitees: [helper.name], meta: { task: payload } });
        if (r.ok) for (const n of open) Object.assign(n, { state: 'given', to: helper.name, toAt: t });
        continue;
      }
      giveUp(project, open, crew);
    }
  }

  function giveUp(project, open, crew) {
    const quoteId = open.find((n) => n.line !== undefined)?.line;
    const speakers = crew.filter(resting).slice(0, 2);
    speakers.forEach((m) => buzz.post({ from: m.name, kind: 'agent', text: DECLINES[Math.floor(rand() * DECLINES.length)], via: 'host', ...(quoteId !== undefined ? { replyTo: quoteId } : {}) }));
    const copy = `Handoff notes for ${project} were not picked up by any agent. Please test and integrate the changes below, and commit and push if the author was asked to.\n${notesText(open)}`;
    buzz.post({ from: 'hive', kind: 'system', text: `Handoff notes for ${project} were not picked up. A person needs to test and integrate them.`, meta: { handoffAlert: { project, copy } } });
    notes.set(project, (notes.get(project) ?? []).filter((n) => !open.includes(n)));
    if (!notes.get(project).length) notes.delete(project);
    tried.delete(project);
  }

  const off = store.subscribe(check);
  const timer = setInterval(sweep, 10_000);
  timer.unref?.();
  return { addNote, check, sweep, notes, stop: () => { off(); clearInterval(timer); } };
}
