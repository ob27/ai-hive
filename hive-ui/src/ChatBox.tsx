import { useState } from "react";
import { AiChatInput } from "rebar-ui";
import { AWAY_MESSAGE } from "./buzz";
import type { BuzzMessage, HiveInfo } from "./buzz";
import { Quote } from "./BuzzThread";

const muted = "var(--rebar-color-text-secondary, #555)";
const NAME_KEY = "hive-name";
const read = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Say something to the hive's chatty bots. Pinned under the thread. `send` resolves null on success or a reason to show. */
export function ChatBox({ send, info, available, replyTo, onCancelReply, name: savedName }: { available: boolean; send: (name: string, text: string, replyTo?: number) => Promise<string | null>; info: HiveInfo; replyTo: BuzzMessage | null; onCancelReply: () => void; name?: string }) {
  const [name, setName] = useState(() => savedName || read());
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const hint = !available
    ? AWAY_MESSAGE
    : info.demo
    ? "Demo: the bots answer with canned lines."
    : info.responder
      ? "Chatty bots may answer. Replies are written by the host on their behalf."
      : "No bots are set to answer. Chatty agents will see this the next time they read the buzz.";

  return (
    <div style={{ borderTop: "1px solid var(--rebar-color-border, #e0e0e0)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {replyTo ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Quote q={{ id: replyTo.id, from: replyTo.from, kind: replyTo.kind, text: replyTo.text }} />
          </div>
          <button type="button" onClick={onCancelReply} aria-label="Cancel reply" style={{ border: 0, background: "none", color: muted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>
            ×
          </button>
        </div>
      ) : null}
      <label title={available ? undefined : AWAY_MESSAGE} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted }}>
        Your name (optional)
        <input
          value={name}
          disabled={!available}
          maxLength={24}
          placeholder="Human"
          onChange={(e) => {
            setName(e.target.value);
            try {
              localStorage.setItem(NAME_KEY, e.target.value);
            } catch {
              /* private mode: the name just is not remembered */
            }
          }}
          style={{ flex: 1, minWidth: 0, padding: "2px 6px", font: "inherit", border: "1px solid var(--rebar-color-border, #e0e0e0)", borderRadius: 4, background: "var(--rebar-color-bg-primary, #fff)", color: "inherit" }}
        />
      </label>
      <div title={available ? undefined : AWAY_MESSAGE}>
      <AiChatInput
        disabled={!available}
        value={text}
        onValueChange={setText}
        placeholder="Say something to the hive"
        maxRows={3}
        onSend={(value) => {
          setProblem(null);
          setText("");
          void send(name.trim(), value, replyTo?.id).then((p) => {
            if (p) { setProblem(p); setText((t) => t || value); } // not sent: put the words back, so a refused post is never lost
            else onCancelReply();
          });
        }}
      />
      </div>
      <div role="status" style={{ fontSize: 12, color: problem ? "var(--rebar-color-danger, #d32f2f)" : muted }}>
        {available ? (problem ?? hint) : hint}
      </div>
    </div>
  );
}
