import { useEffect, useState } from "react";
import { AVATAR_PLACEHOLDER_KINDS } from "rebar-ui";
import type { AgentWallMember } from "rebar-ui";
import { pickAvatar } from "../../src/avatars.mjs";
import type { ServiceOrb } from "./config";

/** AgentWall has no "listening" status yet: the wall draws it as "active" (it is awake and will answer) but keeps its own label. */
export type HiveStatus = NonNullable<AgentWallMember["status"]> | "listening";
/** A stable hue (0-359) from a name, so a service keeps its colour across reloads. */
export const hashHue = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return h % 360;
};

/**
 * Agents get a portrait that suits their name (a male name a male portrait, a female name a female one; creatures only for androgynous
 * names). Services get the chosen orb style, in their own colour, in every state (a failure shows in the status dot).
 */
export const forWall = (serviceOrb: ServiceOrb) => (m: HiveMember): AgentWallMember => ({
  ...m,
  status: m.status === "listening" ? "active" : m.status,
  ...(m.kind === "service" ? { persona: serviceOrb, hue: hashHue(m.name) } : { avatar: pickAvatar(m.name, AVATAR_PLACEHOLDER_KINDS) }),
});

/** Chat is available iff a chatty agent is sitting in the chat. One that is busy mid-turn will not answer for minutes (the host answers 503 otherwise). */
export const chatAvailable = (members: HiveMember[]) => members.some((m) => m.kind === "agent" && m.chatty === true && (m.chatOpen ?? m.status === "listening")); // chatOpen: listening, or only just stopped (a few seconds' grace)
import { DemoSim } from "./demo";

/** What the host sends: an AgentWallMember plus when it last reported. See rebarui/ref/AI_HIVE.md. */
export type HiveMember = Omit<AgentWallMember, "status"> & { status?: HiveStatus; updatedAt?: number; chatty?: boolean; reports?: "hooks" | "chirps"; tools?: string[]; chatOpen?: boolean };

const BASE = import.meta.env.BASE_URL; // "/hive/"

/** The Hive's pooled turn count (GET /hive/production). Fetched on load, every 5s and whenever the member list changes; failures are ignored. `demo` fakes one that creeps upwards. */
export type Production = { total: number | null; agents: { name: string; turns: number }[] };

export function useProduction(demo: boolean, members: HiveMember[]): Production {
  const [total, setTotal] = useState<number | null>(null);
  const [agents, setAgents] = useState<Production["agents"]>([]);
  const roster = members.map((m) => m.id).join("|");
  useEffect(() => {
    if (demo) return;
    let dead = false;
    const load = () =>
      fetch(`${BASE}production`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { total?: number; agents?: Production["agents"] } | null) => { if (!dead && typeof j?.total === "number") { setTotal(j.total); setAgents(Array.isArray(j.agents) ? j.agents : []); } })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => { dead = true; clearInterval(id); };
  }, [demo, roster]);
  useEffect(() => {
    if (!demo) return;
    setTotal((t) => t ?? 98_212.35);
    const id = setInterval(() => setTotal((t) => Math.round(((t ?? 98_212.35) + (Math.random() < 0.3 ? 0.1 + Math.random() * 0.1 : Math.random() < 0.9 ? 0.4 + Math.random() * 1.1 : 3 + Math.random() * 3)) * 100) / 100), 1500);
    return () => clearInterval(id);
  }, [demo]);
  // The demo has no host to ask, so its top contributors are whoever on the fake wall has taken the most turns.
  const topDemo = demo ? members.filter((m) => m.kind === "agent" && m.turns).sort((a, b) => (b.turns ?? 0) - (a.turns ?? 0)).slice(0, 5).map((m) => ({ name: m.name, turns: m.turns ?? 0 })) : agents;
  return { total, agents: topDemo };
}

/**
 * The wall, live. Opens the host's event stream (a full snapshot on every change) and, if the stream is down,
 * polls /hive/state until it comes back. `demo` swaps in a fake, self-animating wall: no host needed.
 */
export function useHive(demo: boolean): { members: HiveMember[]; live: boolean } {
  const [members, setMembers] = useState<HiveMember[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!demo) return;
    const sim = new DemoSim();
    setMembers(sim.members());
    setLive(true);
    const id = setInterval(() => {
      sim.tick();
      setMembers(sim.members());
    }, 700);
    return () => clearInterval(id);
  }, [demo]);

  useEffect(() => {
    if (demo) return;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const fetchState = () =>
      fetch(`${BASE}state`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((m: HiveMember[]) => {
          setMembers(m);
          setLive(true);
        })
        .catch(() => setLive(false));
    source = new EventSource(`${BASE}stream`);
    source.onmessage = (e) => {
      stopPolling();
      setMembers(JSON.parse(e.data) as HiveMember[]);
      setLive(true);
    };
    source.onerror = () => {
      setLive(false);
      if (!poll) poll = setInterval(fetchState, 5000); // EventSource keeps retrying on its own; polling covers the gap
    };
    return () => {
      source?.close();
      stopPolling();
    };
  }, [demo]);

  return { members, live };
}
