import type { HiveMember } from "./hive";

const NAMES = ["Barry", "Alice", "Cora", "Dev", "Esme", "Finn", "Gus", "Hana", "Ivo", "June", "Kit", "Lena", "Milo", "Nora", "Otto", "Pia", "Quin", "Rhys", "Sana", "Tess", "Uma", "Vic"];
const GHOSTS = new Set(["Dev", "Milo"]);
const LINES = [
  "researching what a pile wall looks like",
  "reading the retaining wall drawings",
  "comparing two geotechnical reports",
  "drafting the site inspection summary",
  "checking the pile schedule against the plan",
  "crawling the council planning site",
  "building a DSL layer",
  "cross-checking the survey levels",
];
const LISTENING = ["Need anything else?", "Anything else I can do?", "Happy to help with more", "Just say the word"];
const AWAY = ["Out for smoko", "Grabbing a coffee", "Off to the loo", "Gone to lunch", "Stretching my legs"];
const LISTEN_MS = 100_000;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const expo = (mean: number) => -Math.log(1 - Math.random()) * mean;
/** What a finished turn is worth in the demo: mostly a normal one, often a chat-ish sliver, now and then a long one. */
const turnWorth = () => { const r = Math.random(); return Math.round((r < 0.3 ? rand(0.1, 0.2) : r < 0.92 ? rand(0.4, 1.5) : rand(3, 6)) * 100) / 100; };
const add = (x: number, y: number) => Math.round((x + y) * 100) / 100;
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const SEVERITY: Record<string, number> = { failure: 0, stalled: 1, active: 2, listening: 3, idle: 4, ghost: 5 };

const MODELS: [NonNullable<HiveMember["modelFamily"]>, string][] = [
  ["claude", "claude-haiku-4-5-20251001"], ["claude", "claude-sonnet-4-5"], ["claude", "claude-opus-4-1"],
  ["qwen", "qwen3-coder-30b"], ["qwen", "qwen2.5-coder-32b-instruct"], ["gemini", "gemini-2.5-pro"],
];

type Agent = { name: string; model: [NonNullable<HiveMember["modelFamily"]>, string]; turns: number; composingUntil: number; composingTo: "human" | "agent"; nextCompose: number; project: string; chatty: boolean; status: "active" | "listening" | "idle" | "stalled" | "ghost" | "away"; since: number; until: number; activity?: string; nextLine: number };
type Svc = { id: string; name: string; project: string; beat: number; outageAt: number; outageUntil: number; leakAt: number; leakUntil: number; outageEvery: number; leakEvery: number };

/**
 * A fake wall that behaves like people, not a clock: every agent sits in a state for a random length of time, then moves on
 * (active work that changes what it is doing at its own moments, short rests and the odd long one, a rare hang, and now and
 * then leaving and coming back); services have irregular outages and suspected leaks. Call `tick()` often, read `members()`.
 */
export class DemoSim {
  private agents: Agent[];
  private services: Svc[];

  constructor(now = Date.now()) {
    this.agents = NAMES.map((name, i) => {
      const ghost = GHOSTS.has(name);
      const active = !ghost && Math.random() < 0.65;
      const model = i % 7 === 0 ? MODELS[5] : i % 2 ? MODELS[3 + (i % 3 === 0 ? 1 : 0)] : MODELS[i % 3];
      return { name, model, turns: Math.round(rand(3, 400) * 100) / 100, composingUntil: 0, composingTo: "human" as const, nextCompose: now + rand(3000, 40_000), project: i % 3 === 0 ? "Reports > Salary" : "Dm-Archive > Piles", chatty: i < 5, status: ghost ? "ghost" : active ? "active" : "idle", since: now - (ghost ? 35 * 60_000 : rand(0, 90_000)), until: now + rand(500, 25_000), activity: active ? pick(LINES) : ghost ? undefined : pick(AWAY), nextLine: now + rand(2000, 12_000) };
    });
    this.services = [
      { id: "dsl", name: "DSL Service", project: "Dm-Archive", beat: 0, outageAt: now + expo(120_000), outageUntil: 0, leakAt: now + 1e12, leakUntil: 0, outageEvery: 150_000, leakEvery: 1e12 },
      { id: "idx", name: "Index Worker", project: "Reports", beat: 0, outageAt: now + 1e12, outageUntil: 0, leakAt: now + expo(90_000), leakUntil: 0, outageEvery: 1e12, leakEvery: 110_000 },
    ];
  }

  tick(now = Date.now()) {
    for (const a of this.agents) {
      if (a.status === "ghost") continue;
      if ((a.status === "active" || a.status === "listening") && now >= a.nextCompose) { // now and then writes a reply, briefly
        a.composingUntil = now + rand(1800, 4500); a.composingTo = Math.random() < 0.6 ? "human" : "agent"; a.nextCompose = now + rand(12_000, 50_000);
        a.turns = add(a.turns, turnWorth());
      }
      if (a.status === "active" && Math.random() < 0.03) a.turns = add(a.turns, turnWorth()); // the busy ones rack up turns
      if (a.status === "active" && now >= a.nextLine) { a.activity = pick(LINES); a.nextLine = now + rand(3000, 18_000); } // changes what it is doing, on its own schedule
      if (now < a.until) continue;
      if (a.status === "listening") { a.status = "idle"; a.since = now; a.until = now + rand(3000, 15_000); a.activity = pick(AWAY); continue; }
      if (a.status === "away") { a.status = "idle"; a.since = now; a.until = now + rand(3000, 15_000); a.activity = pick(AWAY); continue; }
      if (a.status === "stalled") { a.status = "active"; a.since = now; a.until = now + rand(4000, 20_000); continue; }
      if (a.status === "active") {
        const r = Math.random();
        if (r < 0.02) { a.status = "stalled"; a.since = now; a.until = now + rand(20_000, 40_000); }
        else if (r < 0.5) { a.until = now + rand(3000, 20_000); a.activity = pick(LINES); }      // carries on working
        else if (a.chatty) { a.status = "listening"; a.since = now; a.until = now + LISTEN_MS; a.activity = pick(LISTENING); }  // sits in the chat for a while: it will answer
        else { a.status = "idle"; a.since = now; a.until = now + (Math.random() < 0.2 ? rand(40_000, 120_000) : expo(11_000) + 3000); a.activity = pick(AWAY); }
      } else if (Math.random() < 0.04) { a.status = "away"; a.since = now; a.until = now + rand(15_000, 60_000); }   // leaves, comes back
      else { a.status = "active"; a.since = now; a.until = now + rand(5000, 40_000); a.activity = pick(LINES); a.nextLine = now + rand(3000, 14_000); }
    }
    for (const s of this.services) {
      if (now >= s.outageAt) { s.outageUntil = now + rand(20_000, 70_000); s.outageAt = s.outageUntil + expo(s.outageEvery); }
      if (now >= s.leakAt) { s.leakUntil = now + rand(15_000, 45_000); s.leakAt = s.leakUntil + expo(s.leakEvery); }
      if (now >= s.outageUntil) s.beat += 1;
    }
  }

  /** The pooled turns, as GET /hive/production would report it. */
  production() {
    return { total: Math.round(this.agents.reduce((n, a) => n + a.turns, 0) * 100) / 100, agents: this.agents.map((a) => ({ name: a.name, turns: a.turns })) };
  }

  members(now = Date.now()): HiveMember[] {
    const out: HiveMember[] = [];
    for (const a of this.agents) {
      if (a.status === "away") continue;
      const mins = Math.floor((now - a.since) / 60_000);
      const label = a.status === "active" ? "Active Now" : a.status === "stalled" ? "Stalled" : a.status === "listening" ? "Listening" : a.status === "ghost" ? "Ghost" : mins < 1 ? "Idle" : `Idle ${mins}min${mins === 1 ? "" : "s"}`;
      out.push({ id: a.name, name: a.name, kind: "agent", project: a.project, status: a.status, statusLabel: label, activity: a.status === "ghost" ? undefined : a.activity, chatty: a.chatty, modelFamily: a.model[0], modelName: a.model[1], turns: a.turns, composing: now < a.composingUntil ? a.composingTo : undefined });
    }
    for (const s of this.services) {
      const silent = now < s.outageUntil;
      const leaking = now < s.leakUntil;
      out.push({
        id: s.id, name: s.name, kind: "service", project: s.project,
        status: silent || leaking ? "failure" : "active",
        statusLabel: silent ? "Not responding" : leaking ? "Degraded" : "Healthy",
        activity: silent ? `${s.name}: no heartbeat, likely failed` : leaking ? `${s.name}: memory climbing, may be leaking` : `${s.name}: heartbeat #${s.beat}`,
      });
    }
    return out.sort((x, y) => SEVERITY[x.status as string] - SEVERITY[y.status as string] || x.name.localeCompare(y.name));
  }
}
