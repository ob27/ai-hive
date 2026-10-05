import { useCallback, useEffect, useState } from "react";
import { adminAction } from "./admin";

const BASE = import.meta.env.BASE_URL; // "/hive/"
const border = "1px solid var(--rebar-color-border, #e0e0e0)";

type Booted = { id: string; name: string };

/** Agents the host removed and is still ignoring, each with "Let back in". A booted agent is off the wall, so this is the only place it can be undone from. */
export function BootedBar() {
  const [booted, setBooted] = useState<Booted[]>([]);
  const [asking, setAsking] = useState<Booted | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`${BASE}booted`).then((r) => (r.ok ? r.json() : [])).then((j: Booted[]) => setBooted(Array.isArray(j) ? j : [])).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const letBack = async (b: Booted, typed?: string) => {
    setMsg(null);
    const r = await adminAction("unboot", b.id, typed);
    if (r.ok) { setAsking(null); setKey(""); load(); return; }
    setAsking(r.needKey ? b : null);
    setMsg(r.error);
  };

  if (!booted.length) return null;
  return (
    <section aria-label="Booted from the hive" style={{ marginBottom: 12, padding: "8px 12px", border, borderRadius: 8, fontSize: 13 }}>
      <div style={{ opacity: 0.75, marginBottom: 6 }}>Booted from the hive. Their events are ignored until you let them back in.</div>
      {booted.map((b) => (
        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}>
          <strong>{b.name}</strong>
          {asking?.id === b.id ? (
            <form onSubmit={(e) => { e.preventDefault(); if (key.trim()) void letBack(b, key); }} style={{ display: "flex", gap: 6 }}>
              <input type="password" aria-label="Hive key" placeholder="Hive key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus style={{ font: "inherit", fontSize: 13 }} />
              <button type="submit">Send</button>
            </form>
          ) : (
            <button type="button" onClick={() => void letBack(b)}>Let back in</button>
          )}
        </div>
      ))}
      {msg ? <div role="alert" style={{ color: "var(--rebar-color-danger, #d32f2f)", marginTop: 4 }}>{msg}</div> : null}
    </section>
  );
}
