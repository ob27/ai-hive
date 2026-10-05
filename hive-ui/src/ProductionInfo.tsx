import { HoneycombCount, Popover } from "rebar-ui";

const BASE = import.meta.env.BASE_URL;
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
const muted = "var(--rebar-color-text-secondary, #555)";
const HONEY = "#F6BE5A";

/** The Hive Production counter in the header. Click it for the leaderboard: the five most productive projects, and a way to the heatmap. */
export function ProductionInfo({ total, projects }: { total: number; projects: { name: string; turns: number }[] }) {
  const top = projects.slice(0, 5);
  const best = Math.max(...top.map((p) => p.turns), 0.0001);
  return (
    <Popover
      sideOffset={8}
      contentProps={{ style: { width: 320, padding: 16 }, "aria-label": "Hive Production leaderboard" }}
      trigger={
        <button
          type="button"
          aria-label="About Hive Production"
          title="Click to see the leaderboard"
          style={{ border: 0, background: "none", padding: "2px 6px", color: "inherit", font: "inherit", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, borderRadius: 6 }}
        >
          <span style={{ color: HONEY, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", lineHeight: 1 }}>Hive Production</span>
          <HoneycombCount value={total} maxDigits={6} size={18} title={`${fmt(total)} production in the Hive`} />
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.45 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Top projects</div>
        {top.length ? (
          <ol aria-label="Top projects by production" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {top.map((p, i) => (
              <li key={p.name} style={{ display: "grid", gridTemplateColumns: "20px 1fr auto", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, color: i === 0 ? HONEY : muted, textAlign: "right" }}>{i + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.name}>{p.name}</span>
                  <span aria-hidden="true" style={{ display: "block", height: 4, borderRadius: 2, background: HONEY, width: `${Math.max(4, (p.turns / best) * 100)}%`, marginTop: 3 }} />
                </span>
                <span style={{ color: muted, fontVariantNumeric: "tabular-nums" }}>{fmt(p.turns)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p style={{ margin: 0, color: muted }}>No production yet. Each finished turn adds to its project.</p>
        )}
        <a
          href={`${BASE}heatmap`}
          style={{ alignSelf: "stretch", textAlign: "center", padding: "7px 12px", borderRadius: 6, background: HONEY, color: "#3a2a00", fontWeight: 700, textDecoration: "none" }}
        >
          See heatmap
        </a>
      </div>
    </Popover>
  );
}
