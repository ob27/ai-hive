import { HoneycombCount, Popover } from "rebar-ui";

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
const muted = "var(--rebar-color-text-secondary, #555)";

/** The Hive Production counter in the header. Click it to read what it counts. */
export function ProductionInfo({ total, agents }: { total: number; agents: { name: string; turns: number }[] }) {
  return (
    <Popover
      sideOffset={8}
      contentProps={{ style: { maxWidth: 380, padding: 16 }, "aria-label": "About Hive Production" }}
      trigger={
        <button
          type="button"
          aria-label="About Hive Production"
          title="Click to see what this is"
          style={{ border: 0, background: "none", padding: "2px 6px", color: "inherit", font: "inherit", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, borderRadius: 6 }}
        >
          <span style={{ color: "#F6BE5A", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", lineHeight: 1 }}>Hive Production</span>
          <HoneycombCount value={total} maxDigits={6} size={18} title={`${fmt(total)} production in the Hive`} />
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, lineHeight: 1.45 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Hive Production</div>
        <p style={{ margin: 0 }}>
          The total production of everyone in this Hive. Each finished turn adds a share of a hexagon, depending on what it did, how long it ran and how big the model is. The hexagons count whole production; hover a count to see the exact figure.
        </p>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: muted, marginBottom: 4 }}>How a turn is worth</div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px" }}>
            <dt style={{ fontWeight: 700 }}>What it did</dt>
            <dd style={{ margin: 0 }}>A chat answer only: a sliver (0.15). Some looking around: about a third. Edits, real research, or lots of reading and running: a whole hexagon.</dd>
            <dt style={{ fontWeight: 700 }}>How long</dt>
            <dd style={{ margin: 0 }}>A long turn counts for more: up to 5x for half an hour or more.</dd>
            <dt style={{ fontWeight: 700 }}>Model size</dt>
            <dd style={{ margin: 0 }}>Small models count 0.6x, big ones such as Opus or Fable 1.5x.</dd>
          </dl>
        </div>
        <p style={{ margin: 0 }}>
          For example, a quick Haiku edit is 0.6; the same on Opus is 1.5; a half-hour Fable turn that wrote code is 7.5.
        </p>
        <p style={{ margin: 0 }}>
          Each count on an agent's tile is that agent's own production. Counts are kept per agent in its project's cast, by name and slot, so renames and restarts don't lose them, and agents that have left still count.
        </p>
        {agents.length ? (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: muted, marginBottom: 4 }}>Most productive</div>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {agents.slice(0, 5).map((a) => (
                <li key={a.name}>
                  {a.name} <span style={{ color: muted }}>· {fmt(a.turns)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <p style={{ margin: 0, fontSize: 12, color: muted }}>The demo's pretend agents count while they are on the wall, but are never saved.</p>
      </div>
    </Popover>
  );
}
