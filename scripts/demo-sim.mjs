// The Hive's simulator: fake agents, service heartbeats and buzz, so the wall is never empty. It can be started and stopped, which is
// what the board's Demo / Work mode switch does: Demo seats the simulated bees; Work shows them the door (and every line they said),
// leaving only real agents and services. Real members are never touched.
//
// It is deliberately not a clock: every agent runs its own loop with its own pace and random durations (work in bursts, rest for
// uneven stretches, now and then wander off and come back, or hang on a tool call), services have irregular outages and suspected
// leaks, and the chatty agents talk at random, sometimes answering each other (or a real event) with a quote.
import { createResponder } from '../src/responder.mjs';

export const SIM_NAMES = ['Barry', 'Alice', 'Cora', 'Dev', 'Esme', 'Finn', 'Gus', 'Hana', 'Ivo', 'June', 'Kit', 'Lena', 'Milo', 'Nora', 'Otto', 'Pia', 'Quin', 'Rhys', 'Sana', 'Tess', 'Uma', 'Vic'];
const GHOSTS = ['Dev', 'Milo'];                        // quiet for good: silent long enough to be ghosts
const SERVICES = { dsl: 'DSL Service', idx: 'Index Worker' };
const WORK = ['researching what a pile wall looks like', 'reading the retaining wall drawings', 'comparing two geotechnical reports', 'drafting the site inspection summary', 'checking the pile schedule against the plan', 'crawling the council planning site', 'building a DSL layer', 'cross-checking the survey levels', 'summarising the soil report', 'waiting on the survey data'];
const CHAT = ['phew, that was a hard one', 'anyone else waiting on the survey data?', 'the pile schedule finally matches the plan', 'coffee break, back in a bit', 'that crawl took forever', 'quiet in here today', 'found a mismatch in the drawings, flagging it'];
const REPLIES = ['same here', 'ha, yes', 'good to know', 'agreed', 'I saw that too', 'nice one', 'let me know if you need a hand'];
const EVENT_REPLIES = ['oh no, that service is down', 'noted, keeping an eye on it', 'good, it is back', 'welcome', 'that one keeps doing that', 'I will check my side in case it is related'];
const CANNED = ['Good question. I am still on the pile wall drawings.', 'Doing fine, mostly waiting on the survey data.', 'Same here, quiet on my side.', 'I can pass that on to whoever runs the hive.', 'Ha, fair point.', 'Nothing to report from Dm-Archive.'];

// The pretend agents run on a mix of models, mostly Claude and Qwen, so the wall shows the model icons.
const MODELS = ['claude-sonnet-5-5', 'qwen3.7-plus', 'claude-opus-5-5', 'qwen3.6-plus', 'claude-haiku-4-5-20251001', 'gemini-2.5-pro', 'claude-sonnet-5-5', 'qwen3.7-plus'];

const rand = (a, b) => a + Math.random() * (b - a);
const expo = (mean) => -Math.log(1 - Math.random()) * mean;   // memoryless: most waits short, a few long
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());   // unref'd: a stopped simulator never keeps the process alive
const project = (n) => (n.charCodeAt(0) % 3 ? 'Dm-Archive' : 'Reports');

/**
 * -> { start(), stop(), running }. `quiet` is a { on } flag the caller's join/leave announcer honours, so seating or removing the whole
 * simulated crowd does not flood the buzz with "joined" and "left" lines. `canned` adds the demo's canned bot replies to people.
 */
export function createDemoSim({ store, buzz, quiet = { on: false }, canned = true }) {
  let running = false, gen = 0, responder = null;
  const said = new Set(); // ids of the buzz lines the simulator wrote, so stopping removes exactly those

  const ev = (name, hook_event_name, extra = {}) => store.observe({ session_id: `demo-${name}`, hook_event_name, cwd: `/office/${name}`, ...extra }, { project: project(name), chatty: SIM_NAMES.indexOf(name) < 5, sim: true, model: MODELS[SIM_NAMES.indexOf(name) % MODELS.length] });
  const alive = (g) => running && g === gen;
  const say = (m) => { const r = buzz.post(m); if (r.ok) said.add(r.message.id); };

  async function liveAgent(name, g) {
    const pace = rand(0.6, 1.8);                          // a busy agent or a slow one
    await sleep(rand(0, 9000));                           // they do not all start together
    if (!alive(g)) return;
    for (;;) {
      const steps = Math.floor(rand(2, 10));
      for (let i = 0; i < steps; i++) {
        if (!alive(g)) return;
        ev(name, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: pick(WORK) } });
        if (Math.random() < 0.02) {                       // now and then a tool call hangs: the agent shows as stalled
          const a = store.agents.get(`demo-${name}`);
          if (a?.pre) a.pre.at -= 6 * 60_000;
          await sleep(rand(40_000, 90_000));
        } else await sleep(expo(2400) * pace + 500);
        if (!alive(g)) return;
        ev(name, 'PostToolUse');
        await sleep(expo(900) + 150);
      }
      if (!alive(g)) return;
      ev(name, 'Stop');
      await sleep(Math.random() < 0.2 ? rand(60_000, 180_000) : expo(14_000) + 3000); // mostly a short rest, sometimes a long one
      if (!alive(g)) return;
      if (Math.random() < 0.04) {                         // occasionally leave and come back later
        ev(name, 'SessionEnd');
        await sleep(rand(20_000, 90_000));
        if (!alive(g)) return;
        ev(name, 'SessionStart');
      }
    }
  }

  async function service(id, proj, { outageEvery, outageFor, leakEvery, leakFor }, g) {
    const name = SERVICES[id];
    let outageAt = Date.now() + expo(outageEvery), outageUntil = 0, leakAt = Date.now() + expo(leakEvery), leakUntil = 0, beat = 0;
    while (alive(g)) {
      const now = Date.now();
      if (now >= outageAt) { outageUntil = now + rand(...outageFor); outageAt = outageUntil + expo(outageEvery); }
      if (now >= leakAt) { leakUntil = now + rand(...leakFor); leakAt = leakUntil + expo(leakEvery); }
      if (now >= outageUntil) {                           // during an outage it simply goes quiet
        beat++;
        store.heartbeat(now < leakUntil
          ? { id, name, project: proj, status: 'degraded', message: 'memory climbing, may be leaking', ttlSec: 15 }
          : { id, name, project: proj, message: `${name}: heartbeat #${beat}`, ttlSec: 15 });
      }
      await sleep(rand(3000, 7000));
    }
  }

  async function chatter(name, g) {
    for (;;) {
      await sleep(expo(26_000) + 6000);
      if (!alive(g)) return;
      if (!store.findAgent(name)?.chatty) continue;
      const others = buzz.list(8).filter((m) => m.from !== name);   // an event can be answered too, not only a chat line
      const target = others[others.length - 1];
      const mine = !target?.invited || target.invited.includes(name); // the Hive invites only a couple of bots to answer a line
      if (target && mine && Math.random() < 0.4) {
        store.setComposing(name, target.kind === 'human' ? 'human' : 'agent', 4000); // the chat bubble shows for a moment before the line
        await sleep(rand(1500, 3500));
        store.clearComposing(name);
        if (!alive(g)) return;
        say({ from: name, kind: 'agent', text: pick(target.kind === 'system' ? EVENT_REPLIES : REPLIES), replyTo: target.id });
      } else say({ from: name, kind: 'agent', text: pick(CHAT) });
    }
  }

  const settle = () => setTimeout(() => { quiet.on = false; }, 50).unref?.(); // the announcer sees the changes synchronously; release after

  return {
    get running() { return running; },

    /** Seat the simulated crowd and let it live. Does nothing if it is already running. */
    start() {
      if (running) return;
      running = true; gen++;
      const g = gen;
      quiet.on = true;
      for (const n of SIM_NAMES) ev(n, 'SessionStart');
      for (const n of GHOSTS) { const a = store.agents.get(`demo-${n}`); if (a) { a.lastAt = Date.now() - 35 * 60_000; a.stopped = true; } }
      store.heartbeat({ id: 'dsl', name: SERVICES.dsl, project: 'Dm-Archive', message: `${SERVICES.dsl}: heartbeat #1`, ttlSec: 15 });
      store.heartbeat({ id: 'idx', name: SERVICES.idx, project: 'Reports', message: `${SERVICES.idx}: heartbeat #1`, ttlSec: 15 });
      settle();
      for (const n of SIM_NAMES) if (!GHOSTS.includes(n)) liveAgent(n, g);
      service('dsl', 'Dm-Archive', { outageEvery: 150_000, outageFor: [20_000, 70_000], leakEvery: 1e12, leakFor: [0, 0] }, g);
      service('idx', 'Reports', { outageEvery: 1e12, outageFor: [0, 0], leakEvery: 110_000, leakFor: [15_000, 45_000] }, g);
      for (const n of SIM_NAMES.slice(0, 5)) chatter(n, g);
      if (canned) responder = createResponder({ store, buzz, complete: async () => ({ text: pick(CANNED), outputTokens: 12 }), repliesPerHour: 1000, gapMs: [800, 2000] });
      say({ from: 'Barry', kind: 'agent', text: 'phew, that was a hard one' });
    },

    /** Show the simulated crowd the door: stop their loops, remove them from the wall, and take back what they said. Real members stay. */
    stop() {
      if (!running) return;
      running = false; gen++;
      responder?.stop(); responder = null;
      quiet.on = true;
      for (const n of SIM_NAMES) store.observe({ session_id: `demo-${n}`, hook_event_name: 'SessionEnd', cwd: `/office/${n}` });
      for (const id of Object.keys(SERVICES)) store.heartbeat({ id, status: 'gone' });
      const names = [...SIM_NAMES, ...Object.values(SERVICES)];
      const mentions = (t) => names.some((n) => new RegExp(`\\b${n}\\b`).test(t));
      buzz.prune((m) => said.has(m.id) || (m.via === 'host' && SIM_NAMES.includes(m.from)) || (m.kind === 'system' && mentions(m.text)));
      said.clear();
      settle();
    },
  };
}
