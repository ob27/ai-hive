import { Alert } from "rebar-ui";
import type { ReactNode } from "react";
import type { HiveMember, MetricKey } from "./hive";
import { MemberMenu } from "./MemberMenu";

const TYPE = { failure: "error", stalled: "warning", ghost: "info", idle: "info", listening: "success", offline: "info", active: "success" } as const;

const ago = (at?: number) => {
  if (!at) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

const svg = (children: ReactNode) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICONS: Record<MetricKey, ReactNode> = {
  gpu: svg(<><rect x="2.5" y="7" width="19" height="10" rx="1.5" /><circle cx="9" cy="12" r="2.6" /><circle cx="9" cy="12" r=".6" /><path d="M15 10v4M17.5 10v4M5 17v2.5M8 17v2.5" /></>),
  cpu: svg(<><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" /></>),
  mem: svg(<><rect x="2" y="7" width="20" height="9" rx="1" /><path d="M5 10v3M8.5 10v3M12 10v3M15.5 10v3M19 10v3M5 16v2M9 16v2M15 16v2M19 16v2" /></>),
  load: svg(<><path d="M4.5 18a8.5 8.5 0 1 1 15 0" /><path d="M12 15l4-5" /><circle cx="12" cy="15" r="1" /><path d="M6 12.5l.8.5M12 6.5V8M18 12.5l-.8.5" /></>),
  disk: svg(<><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 14h18" /><circle cx="7" cy="16" r=".5" /><path d="M16 16h2" /></>),
  net: svg(<><path d="M7 17V7M4 10l3-3 3 3" /><path d="M17 7v10M14 14l3 3 3-3" /></>),
  temp: svg(<><path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z" /><path d="M12 9v7" /></>),
};
const LABELS: Record<MetricKey, (n: number) => [string, string]> = {
  gpu: (n) => [`${n}%`, `GPU ${n}% (average of all GPUs)`],
  cpu: (n) => [`${n}%`, `CPU ${n}%`],
  mem: (n) => [`${n}%`, `Memory ${n}%`],
  load: (n) => [`${n}%`, `Load ${n}% of the cores`],
  disk: (n) => [`${n}%`, `Disk ${n}% full`],
  net: (n) => [n >= 1000 ? `${Math.round(n / 100) / 10}G` : `${n}M`, `Network ${n} Mbit/s (received + sent, all interfaces)`],
  temp: (n) => [`${n}°`, `Temperature ${n} °C`],
};
const WORDS: Record<MetricKey, RegExp> = { cpu: /cpu|processor/i, gpu: /gpu|graphics/i, mem: /memory|\bmem\b|leak|swap/i, load: /load/i, disk: /disk|storage|space/i, net: /network|bandwidth|traffic|mbit/i, temp: /temp|hot|heat|thermal/i };
const COLOURS = { warn: "#E8A33D", bad: "var(--rebar-color-danger, #d32f2f)" };

function Gauges({ member }: { member: HiveMember }) {
  const m = member.metrics;
  if (!m) return null;
  const keys = (["cpu", "gpu", "mem", "load", "net", "temp", "disk"] as MetricKey[]).filter((k) => typeof m[k] === "number" && Number.isFinite(m[k]));
  if (!keys.length) return null;
  return (
    <div role="group" aria-label="Machine readings" style={{ display: "flex", gap: 14, alignItems: "center" }}>
      {keys.map((k) => {
        const state = member.metricStates?.[k];
        const [text, tip] = LABELS[k](Math.round(m[k] as number));
        const sign = state ? (member.signs ?? []).find((x) => WORDS[k].test(x)) : undefined;
        const title = state ? `${tip}: ${sign ?? "(flagged by the Hive's rules)"}` : tip;
        return (
          <div key={k} title={title} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 34, color: state ? COLOURS[state] : "inherit" }}>
            {ICONS[k]}
            <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Click a tile and this says, in a sentence, why it has the status it has, when it last reported, and how it reports. */
export function MemberDetails({ member, onClose }: { member: HiveMember; onClose: () => void }) {
  const status = (member.status ?? "idle") as keyof typeof TYPE;
  return (
    <div style={{ position: "relative" }}>
    <Alert type={TYPE[status] ?? "info"} title={`${member.name} · ${member.statusLabel ?? member.status}`} role="region" aria-label={`Details for ${member.name}`}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 24px", }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 260px", minWidth: 0 }}>
        <div>{member.statusReason ?? "No explanation is available for this status."}</div>
        <div style={{ fontSize: 13 }}>
          {member.kind === "service" ? "Service" : "Agent"}
          {member.project ? ` · ${member.project}` : ""} · last report {ago(member.updatedAt)}
          {member.reports === "hooks" ? " · reports through hooks" : ""}
          {member.reports === "chirps" ? " · reports only what it says with `hive say` (joined without hooks)" : ""}
        </div>
        {member.signs?.length ? (
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            <div style={{ fontWeight: 600 }}>What the Hive noticed</div>
            <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>{member.signs.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        ) : null}
        {member.reports === "chirps" ? (
          <div style={{ fontSize: 13 }}>
            To report its real activity, rejoin from its project folder with the flag for its tool, for example <code>curl -s &lt;host&gt;:3101/join | node - join {member.name} --key &lt;KEY&gt; --claude</code>, then restart the session. The Join page has the exact command for each tool.
          </div>
        ) : null}
        <div>
          <button type="button" onClick={onClose} style={{ padding: 0, border: 0, background: "none", color: "inherit", font: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 13 }}>
            Close details
          </button>
        </div>
      </div>
      {member.metrics ? <div style={{ flex: "0 0 auto", marginRight: 40 }}><Gauges member={member} /></div> : null}
      </div>
    </Alert>
    {member.kind === "agent" ? <MemberMenu member={member} onBooted={onClose} /> : null}
    </div>
  );
}
