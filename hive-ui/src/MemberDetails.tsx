import { Alert } from "rebar-ui";
import type { HiveMember } from "./hive";
import { MemberMenu } from "./MemberMenu";

const TYPE = { failure: "error", stalled: "warning", ghost: "info", idle: "info", listening: "success", offline: "info", active: "success" } as const;

const ago = (at?: number) => {
  if (!at) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

/** Click a tile and this says, in a sentence, why it has the status it has, when it last reported, and how it reports. */
export function MemberDetails({ member, onClose }: { member: HiveMember; onClose: () => void }) {
  const status = (member.status ?? "idle") as keyof typeof TYPE;
  return (
    <div style={{ position: "relative" }}>
    <Alert type={TYPE[status] ?? "info"} title={`${member.name} · ${member.statusLabel ?? member.status}`} role="region" aria-label={`Details for ${member.name}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div>{member.statusReason ?? "No explanation is available for this status."}</div>
        <div style={{ fontSize: 13 }}>
          {member.kind === "service" ? "Service" : "Agent"}
          {member.project ? ` · ${member.project}` : ""} · last report {ago(member.updatedAt)}
          {member.reports === "hooks" ? " · reports through hooks" : ""}
          {member.reports === "chirps" ? " · reports only what it says with `hive say` (joined without hooks)" : ""}
        </div>
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
    </Alert>
    {member.kind === "agent" ? <MemberMenu member={member} onBooted={onClose} /> : null}
    </div>
  );
}
