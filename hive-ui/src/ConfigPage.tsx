import { useEffect, useState } from "react";
import { Alert, AgentTile, AVATAR_PLACEHOLDER_KINDS, Button, Input, SegmentedControl, Slider, Switch } from "rebar-ui";
import { DEFAULT_CONFIG, writeConfig } from "./config";
import type { HiveConfig } from "./config";
import type { HiveInfo } from "./buzz";
import { hashHue } from "./hive";
import { pickAvatar } from "../../src/avatars.mjs";

const BASE = import.meta.env.BASE_URL;
const KEY_STORE = "hive-join-key"; // the Join page keeps the key here too, so setting it in either place sets it in both
const readKey = () => {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
};
const muted = "var(--rebar-color-text-secondary, #555)";
const card: React.CSSProperties = { border: "1px solid var(--rebar-color-border, #e0e0e0)", borderRadius: 12, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 };

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 200, flex: "1 1 200px" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        {hint ? <div style={{ fontSize: 13, color: muted }}>{hint}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

type Settings = NonNullable<HiveInfo["settings"]>;

/** Display preferences (saved in this browser) with a live preview, and what the host is set to (read-only). */
export function ConfigPage({ config, onChange }: { config: HiveConfig; onChange: (next: HiveConfig) => void }) {
  const [info, setInfo] = useState<HiveInfo | null>(null);
  const [key, setKey] = useState(readKey);
  const [hostFills, setHostFills] = useState(false);
  const [mode, setMode] = useState<{ mode: "demo" | "work"; canSwitch: boolean } | null>(null);
  const [modeMsg, setModeMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    fetch(`${BASE}info`).then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => setInfo(null));
    fetch(`${BASE}mode`).then((r) => (r.ok ? r.json() : null)).then(setMode).catch(() => setMode(null));
    // If this browser has no key yet and the host fills one in, offer it (the same rule as the Join page).
    fetch(`${BASE}join-info`).then((r) => (r.ok ? r.json() : null)).then((j: { key?: string | null } | null) => {
      if (j?.key && !readKey()) {
        setKey(j.key);
        setHostFills(true);
        try { localStorage.setItem(KEY_STORE, j.key); } catch { /* not remembered */ }
      }
    }).catch(() => undefined);
  }, []);
  const saveKey = (v: string) => {
    setKey(v);
    setHostFills(false);
    try { localStorage.setItem(KEY_STORE, v.trim()); } catch { /* private mode: not remembered */ }
  };
  const switchMode = async (next: "demo" | "work") => {
    setModeMsg(null);
    try {
      const res = await fetch(`${BASE}mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: next, key: key.trim() }) });
      if (res.ok) {
        setMode((m) => (m ? { ...m, mode: next } : m));
        setModeMsg({ type: "success", text: next === "work" ? "Work mode: the simulated bees have left. Only real agents and services are on the wall." : "Demo mode: simulated bees and services are on the wall. Real ones stay too." });
      } else {
        const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        setModeMsg({ type: "error", text: res.status === 401 ? "That key was not accepted. Check the Hive key above." : (why ?? `The hive answered ${res.status}.`) });
      }
    } catch {
      setModeMsg({ type: "error", text: "Could not reach the hive." });
    }
  };
  const set = <K extends keyof HiveConfig>(key: K, value: HiveConfig[K]) => {
    const next = { ...config, [key]: value };
    writeConfig(next);
    onChange(next);
  };
  const s: Settings | undefined = info?.settings;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ margin: 0 }}>Hive config</h1>
        <p style={{ margin: "4px 0 0", color: muted }}>How this screen looks. Saved in this browser; it changes nothing on the host.</p>
      </div>

      <section aria-label="Preview" style={{ ...card, flexDirection: "row", flexWrap: "wrap", gap: 4, padding: 8 }}>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}><AgentTile name="Barry" avatar={pickAvatar("Barry", AVATAR_PLACEHOLDER_KINDS)} project="Dm-Archive > Piles" status="active" activity="researching what a pile wall looks like" orb={config.orb} look="avatar" /></div>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}><AgentTile name="Alice" avatar={pickAvatar("Alice", AVATAR_PLACEHOLDER_KINDS)} project="Reports" status="idle" statusLabel="Idle 4mins" orb={config.orb} look="avatar" /></div>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}><AgentTile name="DSL Service" kind="service" project="Dm-Archive" status="active" statusLabel="Healthy" activity="DLS Worker Service: heartbeat #12" persona={config.serviceOrb} hue={hashHue("DSL Service")} orb={config.orb} look="avatar" /></div>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}><AgentTile name="Index Worker" kind="service" project="Reports" status="failure" statusLabel="Degraded" activity="memory climbing, may be leaking" persona={config.serviceOrb} hue={hashHue("Index Worker")} orb={config.orb} look="avatar" /></div>
      </section>

      <section style={card} aria-label="Hive access and board mode">
        <h2 style={{ margin: 0, fontSize: 18 }}>Hive key and board mode</h2>
        <Row label="Hive key" hint={hostFills ? "Filled in for you by the host. Saved in this browser; the Join page uses it too." : "Saved in this browser; the Join page uses it too. Needed to switch the board mode."}>
          <div style={{ width: 240 }}>
            <Input type="password" autoComplete="off" aria-label="Hive key" placeholder="paste the key" value={key} onChange={(e) => saveKey(e.target.value)} />
          </div>
        </Row>
        <Row
          label="Board mode"
          hint="Demo seats simulated bees and services so the wall is never empty. Work shows them the door: only real agents and services appear, and the hive waits for real ones to join."
        >
          <SegmentedControl
            aria-label="Board mode"
            value={mode?.mode ?? "work"}
            disabled={!mode?.canSwitch || !key.trim()}
            onValueChange={(v) => void switchMode(v as "demo" | "work")}
            options={[{ value: "demo", label: "Demo" }, { value: "work", label: "Work" }]}
          />
        </Row>
        {mode && !mode.canSwitch ? <Alert type="warning" title="This host has no simulator to switch">It only ever shows real agents and services.</Alert> : null}
        {mode?.canSwitch && !key.trim() ? <Alert type="info" title="Enter the hive key to switch modes">Anyone can see the mode; changing it needs the key.</Alert> : null}
        {modeMsg ? <Alert type={modeMsg.type} title={modeMsg.type === "success" ? "Done" : "Not switched"}>{modeMsg.text}</Alert> : null}
      </section>

      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Agents and services</h2>
        <Row label="Service orb" hint="Services (workers, heartbeats) always appear as orbs; agents always have avatars. Pick the orb style.">
          <SegmentedControl aria-label="Service orb" value={config.serviceOrb} onValueChange={(v) => set("serviceOrb", v as HiveConfig["serviceOrb"])} options={[{ value: "spark", label: "Spark" }, { value: "strato", label: "Strato" }, { value: "chorus", label: "Chorus" }]} />
        </Row>
        <Row label="Orb rendering" hint="Real shaders where WebGL allows, or the plain CSS look-alike (lighter on a slow machine).">
          <SegmentedControl aria-label="Orb rendering" value={config.orb} onValueChange={(v) => set("orb", v as HiveConfig["orb"])} options={[{ value: "auto", label: "Real shaders" }, { value: "css", label: "Plain CSS" }]} />
        </Row>
      </section>

      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Wall</h2>
        <Row label={`Columns: ${config.cols}`} hint="The most tiles in a row. A narrow screen shows fewer.">
          <div style={{ width: 200 }}><Slider aria-label="Columns" min={2} max={8} step={1} value={config.cols} onValueChange={(v) => set("cols", v)} /></div>
        </Row>
        <Row label={`Rows: ${config.rows}`} hint={`${config.cols * config.rows} tiles to a page.`}>
          <div style={{ width: 200 }}><Slider aria-label="Rows" min={2} max={8} step={1} value={config.rows} onValueChange={(v) => set("rows", v)} /></div>
        </Row>
        <Row label="Status filter" hint="Hide the tiles that do not match, or keep them in place and grey them out.">
          <SegmentedControl aria-label="Filter mode" value={config.filterMode} onValueChange={(v) => set("filterMode", v as HiveConfig["filterMode"])} options={[{ value: "hide", label: "Hide" }, { value: "dim", label: "Dim" }]} />
        </Row>
        <Row label="Theme">
          <SegmentedControl aria-label="Theme" value={config.theme} onValueChange={(v) => set("theme", v as HiveConfig["theme"])} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Row>
      </section>

      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Hive Chat</h2>
        <Row label="Open the drawer on load" hint="The Hive Chat drawer also opens by itself when the first chatty agent arrives.">
          <Switch aria-label="Open the Hive Chat drawer on load" checked={config.drawer} onCheckedChange={(v) => set("drawer", v)} />
        </Row>
      </section>

      <section style={card} aria-label="Host">
        <h2 style={{ margin: 0, fontSize: 18 }}>Host <span style={{ fontSize: 13, fontWeight: 400, color: muted }}>(read-only: set when the host starts)</span></h2>
        {s ? (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            <li>An agent becomes a <b>ghost</b> after {s.ghostAfterMin} minutes of silence, and drops off {s.ghostDropMin} minutes later.</li>
            <li>An agent whose tool call has been open {s.stallMin} minutes is <b>stalled</b>.</li>
            <li>A service that misses its heartbeat for {s.serviceTtlSec} seconds (unless it says otherwise) is shown as likely failed.</li>
            <li>Hive Chat: {s.buzzPerHour} lines an hour per agent, {s.humanPerHour} an hour per person, up to {s.maxChars} characters.</li>
            <li>
              Bots answering you: {s.responder.on ? <>on, using <b>{s.responder.model}</b>{s.responder.dailyOutputTokens ? `, up to ${s.responder.repliesPerHour} replies an hour and ${s.responder.dailyOutputTokens.toLocaleString()} output tokens a day` : ""}. Replies are written by the host on the agents' behalf.</> : "off. Set ANTHROPIC_API_KEY on the host to let the chatty bots answer people."}
            </li>
          </ul>
        ) : (
          <p style={{ margin: 0, color: muted }}>The host's settings are not available (is the host running?).</p>
        )}
      </section>

      <div style={{ display: "flex", gap: 8, paddingBottom: 24 }}>
        <a href={BASE}><Button variant="primary">Back to the wall</Button></a>
        <Button variant="secondary" onClick={() => { writeConfig(DEFAULT_CONFIG); onChange({ ...DEFAULT_CONFIG }); }}>Reset to defaults</Button>
      </div>
    </div>
  );
}
