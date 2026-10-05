import { useState } from "react";
import { ChatThread } from "rebar-ui";
import type { ChatMessage } from "rebar-ui";
import type { BuzzMessage } from "./buzz";

export const SNIPPET: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const muted = "var(--rebar-color-text-secondary, #555)";

const linkButton: React.CSSProperties = { marginLeft: 8, padding: 0, border: 0, background: "none", color: "inherit", font: "inherit", cursor: "pointer", textDecoration: "underline" };

/**
 * The hive's chat, newest at the bottom: Rebar's multi-speaker ChatThread. Agents' lines show the speaker (and "voiced by host" when
 * the host wrote it for them); people's lines are highlighted and marked; the host's own lines are muted system lines marked ⚡.
 * It fills the height it is given and scrolls inside itself, pinned to the newest line unless you have scrolled up to read.
 */
export function BuzzThread({ messages, onReply }: { messages: BuzzMessage[]; onReply?: (m: BuzzMessage) => void }) {
  const reply = (m: BuzzMessage, label: string) =>
    onReply ? (
      <button type="button" onClick={() => onReply(m)} aria-label={label} style={linkButton}>
        Reply
      </button>
    ) : undefined;

  const rows: ChatMessage[] = messages.map((m) => {
    const id = String(m.id);
    const timestamp = new Date(m.at);
    if (m.handoffAlert) return { id, role: "system", timestamp, content: `📝 ${m.text}`, actions: <HandoffNotes m={m} /> };
    if (m.kind === "system") {
      const bee = m.from.startsWith("🐝");
      const robot = m.from.startsWith("🤖"); // a service speaking through <ai-hive-buzz> in its logs: "🤖 Billing: 50% complete"
      return { id, role: "system", timestamp, content: `${bee ? "🐝 Bee: " : robot ? `${m.from}: ` : m.handoff ? "" : "⚡ "}${m.text}`, actions: reply(m, `Reply to the event: ${m.text}`) };
    }
    return {
      id,
      role: m.kind === "human" ? "user" : "assistant",
      tone: m.kind === "human" ? "highlight" : "default",
      sender: `${m.from}${m.kind === "human" ? " · human" : ""}`,
      timestamp,
      content: m.text,
      header: m.quote ? <Quote q={m.quote} /> : undefined,
      actions: (
        <>
          {m.via === "host" ? <span title="This line was written by the hive's host on the agent's behalf, not by the agent itself"> · voiced by host</span> : null}
          {reply(m, `Reply to ${m.from}`)}
        </>
      ),
    };
  });

  return (
    <ChatThread
      messages={rows}
      align="start"
      markdown={false}
      style={{ flex: 1, minHeight: 0 }}
      emptyMessage="Quiet in the hive. Agents that join with --chatty can buzz here, and you can say something below."
    />
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

/** What the hive says when handoff notes were not picked up by any agent: the notes, and a button to copy them for a person to act on. */
function HandoffNotes({ m }: { m: BuzzMessage }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.handoffAlert?.copy ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the text is still on screen */ }
  };
  return (
    <span role="alert" style={{ display: "block", fontStyle: "normal", marginTop: 4 }}>
      <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 12, color: muted }}>{m.handoffAlert?.copy}</pre>
      <button type="button" onClick={copy} style={{ cursor: "pointer", font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid currentColor", background: "none", color: "inherit" }}>
        {copied ? "Copied" : "Copy to clipboard"}
      </button>
    </span>
  );
}
