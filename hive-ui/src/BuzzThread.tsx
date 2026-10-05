import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BuzzMessage } from "./buzz";

export const SNIPPET: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
const muted = "var(--rebar-color-text-secondary, #555)";

// TODO: this is hand-rolled because Rebar's ChatThread is a two-sided user/assistant chat with no sender names and no
// system lines. A multi-speaker mode on ChatThread (a `sender` per message, a `system` role) would replace this.
/**
 * The hive's chat, newest at the bottom. Agents' lines show the speaker (and "voiced by host" when the host wrote it for
 * them); people's lines are tinted and marked; the host's own lines are muted and marked ⚡.
 * It fills the height it is given and scrolls inside itself (it never makes the page taller), pinned to the newest line
 * unless you have scrolled up to read.
 */
export function BuzzThread({ messages, onReply }: { messages: BuzzMessage[]; onReply?: (m: BuzzMessage) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight; // opening the drawer starts at the newest line
  }, []);

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; // "at the bottom" with a little slack
      }}
      style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 4 }}
    >
      {messages.length ? (
        <ul aria-label="Buzz" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.map((m) =>
            m.handoffAlert ? (
              <HandoffAlert key={m.id} m={m} />
            ) : m.kind === "system" ? (
              <li key={m.id} style={{ fontSize: 13, fontStyle: "italic", color: muted }}>
                <span aria-hidden="true">{m.from.startsWith("🐝") ? "🐝 " : m.handoff ? "" : "⚡ "}</span>
                {m.from.startsWith("🐝") ? <strong style={{ fontStyle: "normal" }}>Bee: </strong> : null}
                {m.text}
                {onReply ? (
                  <button type="button" onClick={() => onReply(m)} aria-label={`Reply to the event: ${m.text}`} style={{ marginLeft: 8, padding: 0, border: 0, background: "none", color: "inherit", font: "inherit", cursor: "pointer", textDecoration: "underline" }}>
                    Reply
                  </button>
                ) : null}
              </li>
            ) : (
              <li key={m.id} style={{ fontSize: 14, ...(m.kind === "human" ? { background: "var(--rebar-color-bg-secondary, #f5f5f5)", borderRadius: 8, padding: "6px 8px" } : {}) }}>
                <div style={{ fontSize: 12, color: muted }}>
                  <strong style={{ color: "var(--rebar-color-text-primary, #1a1a1a)" }}>{m.from}</strong> · {hhmm(m.at)}
                  {m.kind === "human" ? " · human" : ""}
                  {m.via === "host" ? <span title="This line was written by the hive's host on the agent's behalf, not by the agent itself"> · voiced by host</span> : ""}
                  {onReply ? (
                    <button type="button" onClick={() => onReply(m)} aria-label={`Reply to ${m.from}`} style={{ marginLeft: 8, padding: 0, border: 0, background: "none", color: "inherit", font: "inherit", cursor: "pointer", textDecoration: "underline" }}>
                      Reply
                    </button>
                  ) : null}
                </div>
                {m.quote ? <Quote q={m.quote} /> : null}
                <div style={{ overflowWrap: "anywhere" }}>{m.text}</div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p style={{ margin: 0, color: muted, fontSize: 14 }}>Quiet in the hive. Agents that join with --chatty can buzz here, and you can say something below.</p>
      )}
    </div>
  );
}

/** The line a message answers, quoted above it the way modern chat apps do: a bar down the side, who said it, a one-line snippet. */
export function Quote({ q }: { q: NonNullable<BuzzMessage["quote"]> }) {
  return (
    <div
      aria-label={`In reply to ${q.from}`}
      style={{ borderLeft: "3px solid var(--rebar-color-primary, #0066cc)", background: "var(--rebar-color-bg-secondary, #f5f5f5)", borderRadius: 4, padding: "3px 8px", margin: "3px 0 5px", fontSize: 12, color: muted, minWidth: 0 }}
    >
      <strong style={{ color: "var(--rebar-color-text-primary, #1a1a1a)" }}>{q.kind === "system" ? "⚡ hive event" : q.from}</strong>
      <div style={{ ...SNIPPET, ...(q.kind === "system" ? { fontStyle: "italic" } : {}) }}>{q.text}</div>
    </div>
  );
}

/** The hive's notice that handoff notes were not picked up by any agent: the notes, and a button to copy them for a person to act on. */
function HandoffAlert({ m }: { m: BuzzMessage }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.handoffAlert?.copy ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the text is still on screen */ }
  };
  return (
    <li role="alert" style={{ fontSize: 13, border: "1px solid var(--rebar-color-border, #e0a800)", borderLeft: "4px solid #f6be5a", borderRadius: 8, padding: "8px 10px", background: "var(--rebar-color-bg-secondary, #fff8e6)" }}>
      <div style={{ fontWeight: 600 }}>📝 {m.text}</div>
      <pre style={{ margin: "6px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 12, color: muted }}>{m.handoffAlert?.copy}</pre>
      <button type="button" onClick={copy} style={{ cursor: "pointer", font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid currentColor", background: "none", color: "inherit" }}>
        {copied ? "Copied" : "Copy to clipboard"}
      </button>
    </li>
  );
}
