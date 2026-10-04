import { useEffect, useId, useRef, useState } from "react";
import type { HiveMember } from "./hive";
import { adminAction } from "./admin";

const danger = "var(--rebar-color-danger, #d32f2f)";
const border = "1px solid var(--rebar-color-border, #e0e0e0)";
const item: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: 0, background: "none", color: "inherit", font: "inherit", fontSize: 13, cursor: "pointer", borderRadius: 4, minHeight: 28 };

/** Cog in the corner of the details box: "Tap on shoulder" and "Boot from hive" for an agent. */
export function MemberMenu({ member, onBooted }: { member: HiveMember; onBooted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [needKey, setNeedKey] = useState(false);
  const [pending, setPending] = useState<"tap" | "boot" | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cog = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = (refocus = true) => {
    setOpen(false); setConfirming(false); setNeedKey(false); setPending(null); setMsg(null); setKey("");
    if (refocus) cog.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const run = async (action: "tap" | "boot", typed?: string) => {
    setPending(action); setMsg(null);
    const r = await adminAction(action, member.id, typed);
    if (r.ok) {
      setNeedKey(false);
      setMsg({ text: action === "tap" ? `Tapped ${member.name} on the shoulder. It will see it on its next move.` : `Booted ${member.name}.`, bad: false });
      setTimeout(() => { close(false); if (action === "boot") onBooted(); }, 1600);
      return; // pending stays set so the buttons stay disabled until close
    }
    setPending(null);
    setNeedKey(!!r.needKey);
    setMsg({ text: r.error, bad: true });
  };

  const onMenuKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  };

  const done = msg && !msg.bad;
  // Cursor has no hook that carries text back to the agent, so neither a tap nor the boot notice can reach it: both are switched off.
  const noMail = !!member.tools?.length && member.tools.every((t) => t === "cursor");
  const noMailWhy = "Cursor can't receive messages from the Hive, so this isn't available for this agent.";
  return (
    <div ref={root} style={{ position: "absolute", top: 6, right: 6, zIndex: 5 }}>
      <button
        ref={cog}
        type="button"
        aria-label="Agent actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 28, minHeight: 28, padding: 0, border: 0, borderRadius: 4, background: "none", color: "inherit", cursor: "pointer", opacity: 0.8 }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${member.name}`}
          onKeyDown={onMenuKeys}
          style={{ position: "absolute", top: 32, right: 0, width: 260, padding: 6, border, borderRadius: 6, background: "var(--rebar-color-bg-primary, #fff)", color: "var(--rebar-color-text-primary, inherit)", boxShadow: "0 4px 16px rgba(0,0,0,.25)", display: "flex", flexDirection: "column", gap: 4 }}
        >
          {confirming ? (
            <div role="group" aria-label="Confirm boot" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 6px", fontSize: 13 }}>
              <span style={{ color: danger }}>Boot {member.name}? It is removed from the Hive.</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button type="button" role="menuitem" disabled={!!pending} onClick={() => run("boot")} style={{ ...item, width: "auto", color: "#fff", background: danger, textAlign: "center", padding: "4px 12px" }}>Boot</button>
                <button type="button" role="menuitem" disabled={!!pending} onClick={() => { setConfirming(false); setMsg(null); setNeedKey(false); }} style={{ ...item, width: "auto", border, textAlign: "center", padding: "4px 12px" }}>Cancel</button>
              </span>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" disabled={!!pending || noMail} title={noMail ? noMailWhy : undefined} onClick={() => run("tap")} style={{ ...item, ...(noMail ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}>Tap on shoulder</button>
              <button type="button" role="menuitem" disabled={!!pending || noMail} title={noMail ? noMailWhy : undefined} onClick={() => { setConfirming(true); setMsg(null); }} style={{ ...item, color: danger, ...(noMail ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}>Boot from hive</button>
              {noMail ? <div style={{ fontSize: 12, padding: "2px 6px 4px", color: "var(--rebar-color-text-secondary, #555)" }}>{noMailWhy}</div> : null}
            </>
          )}
          {needKey && !done ? (
            <form
              onSubmit={(e) => { e.preventDefault(); if (key.trim()) void run(confirming ? "boot" : "tap", key); }}
              style={{ display: "flex", gap: 6, padding: "0 6px" }}
            >
              <input
                type="password"
                autoComplete="off"
                aria-label="Hive key"
                placeholder="Hive key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus
                style={{ flex: 1, minWidth: 0, padding: "2px 6px", font: "inherit", fontSize: 13, border, borderRadius: 4, background: "var(--rebar-color-bg-primary, #fff)", color: "inherit" }}
              />
              <button type="submit" disabled={!key.trim() || !!pending} style={{ ...item, width: "auto", border, textAlign: "center", padding: "2px 10px" }}>
                {confirming ? "Boot" : "Send"}
              </button>
            </form>
          ) : null}
          {msg ? <div role="status" style={{ fontSize: 12, padding: "0 6px 2px", color: msg.bad ? danger : "var(--rebar-color-text-secondary, #555)" }}>{msg.text}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
