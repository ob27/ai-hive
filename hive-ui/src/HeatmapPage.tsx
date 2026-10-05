import { useEffect, useMemo, useState } from "react";
import { CalendarHeatmap } from "rebar-ui";

const BASE = import.meta.env.BASE_URL;
const muted = "var(--rebar-color-text-secondary, #555)";
const HONEY = "#F6BE5A";
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });

type Day = { date: string; value: number };

/** Cream to deep amber: a day with little production is pale wax, a busy one is full honey. */
const honey = (t: number) => `color-mix(in srgb, #D98A00 ${Math.round(Math.max(0, Math.min(1, t)) * 100)}%, #FFF1C9)`;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** ?demo: a year of plausible, made-up production so the page can be worked on without a host. */
function demoDays(): Day[] {
  const out: Day[] = [];
  const today = new Date();
  for (let i = 0; i < 364; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const r = Math.sin(i * 12.9898) * 43758.5453; const rnd = r - Math.floor(r);
    if (rnd < (weekend ? 0.55 : 0.12)) continue;
    out.push({ date: iso(d), value: Math.round((0.5 + rnd * (weekend ? 4 : 14)) * 10) / 10 });
  }
  return out.reverse();
}

function useDays(demo: boolean) {
  const [days, setDays] = useState<Day[] | null>(null);
  useEffect(() => {
    if (demo) { setDays(demoDays()); return; }
    let dead = false;
    fetch(`${BASE}production-days`).then((r) => (r.ok ? r.json() : [])).then((j: Day[]) => { if (!dead) setDays(Array.isArray(j) ? j : []); }).catch(() => { if (!dead) setDays([]); });
    return () => { dead = true; };
  }, [demo]);
  return days;
}

/** Production by day, as a honeycomb: one hexagon a day, the last year, shaded from pale wax to full honey. */
export function HeatmapPage({ demo }: { demo: boolean }) {
  const days = useDays(demo);
  const { start, end } = useMemo(() => { const e = new Date(); const s = new Date(e); s.setDate(e.getDate() - 364); return { start: iso(s), end: iso(e) }; }, []);
  const stats = useMemo(() => {
    const d = days ?? [];
    const total = d.reduce((t, x) => t + x.value, 0);
    const best = d.reduce<Day | null>((b, x) => (!b || x.value > b.value ? x : b), null);
    return { total, active: d.length, best };
  }, [days]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1100 }}>
      <div>
        <a href={BASE} style={{ color: muted, fontSize: 13 }}>← Back to the wall</a>
        <h1 style={{ margin: "6px 0 2px", fontSize: 24 }}>Hive Production</h1>
        <p style={{ margin: 0, color: muted }}>Every hexagon is a day. The more the Hive got done, the fuller the honey.</p>
      </div>

      <div role="group" aria-label="Production summary" style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
        <Stat label="Last 12 months" value={fmt(stats.total)} />
        <Stat label="Active days" value={String(stats.active)} />
        <Stat label="Best day" value={stats.best ? `${fmt(stats.best.value)} · ${stats.best.date}` : "—"} />
      </div>

      <div style={{ overflowX: "auto", paddingBottom: 8 }}>
        {days === null ? (
          <p style={{ color: muted }}>Loading…</p>
        ) : (
          <CalendarHeatmap
            data={days}
            startDate={start}
            endDate={end}
            title="Production per day, last 12 months"
            cellShape="hexagon"
            cellSize={20}
            colorScale={honey}
          />
        )}
        {days !== null && days.length === 0 ? <p style={{ color: muted, marginTop: 8 }}>Nothing recorded yet. Each finished turn adds to the day it happened on; the history starts the day production tracking was added.</p> : null}
      </div>

      <section aria-label="How a turn is worth" style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 640 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>How a turn is worth</h2>
        <p style={{ margin: "0 0 8px" }}>Each finished turn adds a share of a hexagon to its day, depending on what it did, how long it ran and how big the model is.</p>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px" }}>
          <dt style={{ fontWeight: 700 }}>What it did</dt>
          <dd style={{ margin: 0 }}>A chat answer only: a sliver (0.15). Some looking around: about a third. Edits, real research, or lots of reading and running: a whole hexagon.</dd>
          <dt style={{ fontWeight: 700 }}>How long</dt>
          <dd style={{ margin: 0 }}>A long turn counts for more: up to 5x for half an hour or more.</dd>
          <dt style={{ fontWeight: 700 }}>Model size</dt>
          <dd style={{ margin: 0 }}>Small models count 0.6x, big ones such as Opus or Fable 1.5x.</dd>
        </dl>
        <p style={{ margin: "8px 0 0", color: muted }}>For example, a quick Haiku edit is 0.6; the same on Opus is 1.5; a half-hour Fable turn that wrote code is 7.5. Counts are kept per agent in its project's cast, so renames and restarts don't lose them, and agents that have left still count. The demo's pretend agents are never saved.</p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: muted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: HONEY, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
