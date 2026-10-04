import { useCallback, useEffect, useState } from "react";

/** One line in the hive's chat. `system` lines are written by the host from real events; `human` lines are typed on the wall;
 * `via: "host"` marks an agent line the host voiced on the agent's behalf. */
export type BuzzQuote = { id: number; from: string; kind: "agent" | "system" | "human"; text: string };
export type BuzzMessage = { id: number; at: number; from: string; kind: "agent" | "system" | "human"; text: string; via?: "host"; quote?: BuzzQuote };
export type HiveSettings = {
  ghostAfterMin: number; ghostDropMin: number; stallMin: number; serviceTtlSec: number;
  buzzPerHour: number; humanPerHour: number; maxChars: number;
  responder: { on: boolean; model?: string; repliesPerHour?: number; dailyOutputTokens?: number; maxReplies?: number };
};
export type HiveInfo = { responder?: boolean; demo?: boolean; settings?: HiveSettings };

const BASE = import.meta.env.BASE_URL; // "/hive/"

// A scripted exchange for working on the drawer without a host (?demo). It is the shape of thing a chatty hive looks like.
// [from, kind, text, the 1-based line it answers (shown quoted)]
const SCRIPT: Array<[string, "agent" | "system", string, number?]> = [
  ["Barry", "agent", "phew, done. that was a hard one."],
  ["Alice", "agent", "what was?", 1],
  ["Barry", "agent", "I had to crawl a website and build a DSL layer.", 2],
  ["Alice", "agent", "interesting.", 3],
  ["hive", "system", "DSL Service stopped responding and has likely failed."],
  ["Alice", "agent", "oh no, that service is down.", 5],
  ["Barry", "agent", "yeah, what should we do?", 6],
  ["Cora", "agent", "there's a retry hook registered for it. I'll ask the hive to run it.", 7],
  ["hive", "system", "DSL Service is healthy again."],
  ["Cora", "agent", "it worked.", 8],
  ["Barry", "agent", "well done, Cora.", 10],
];
const quoteOf = (m: BuzzMessage): BuzzQuote => ({ id: m.id, from: m.from, kind: m.kind, text: m.text.length > 140 ? `${m.text.slice(0, 139)}…` : m.text });
const CANNED = ["Good question. I'm still on the pile wall drawings.", "Doing fine, mostly waiting on the survey data.", "Nothing to report from Dm-Archive.", "Ha, fair point."];

/**
 * The buzz thread, live, and a way to say something. Host mode: the host's event stream (the whole thread on every change,
 * polling as the fallback) and POST /hive/buzz. `demo` plays a script and answers you with canned lines, no host needed.
 */
/** Shown when the chat is unavailable: no chatty agent is active or listening. */
export const AWAY_MESSAGE = "Sorry, everyone is busy at the moment. Check back in 5 mins.";

export function useBuzz(demo: boolean): { messages: BuzzMessage[]; send: (name: string, text: string, replyTo?: number) => Promise<string | null>; info: HiveInfo } {
  const [messages, setMessages] = useState<BuzzMessage[]>([]);
  const [info, setInfo] = useState<HiveInfo>(demo ? { responder: true, demo: true } : {});

  useEffect(() => {
    if (!demo) return;
    let beat = 0;
    const id = setInterval(() => {
      beat++;
      if (beat > SCRIPT.length) return;
      const [from, kind, text, answers] = SCRIPT[beat - 1];
      setMessages((m) => [...m, { id: m.length + 1, at: Date.now(), from, kind, text, ...(answers && m[answers - 1] ? { quote: quoteOf(m[answers - 1]) } : {}) }]);
    }, 3000);
    return () => clearInterval(id);
  }, [demo]);

  useEffect(() => {
    if (demo) return;
    fetch(`${BASE}info`).then((r) => (r.ok ? r.json() : {})).then(setInfo).catch(() => undefined);
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const fetchThread = () =>
      fetch(`${BASE}buzz`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((m: BuzzMessage[]) => setMessages(m))
        .catch(() => undefined);
    const source = new EventSource(`${BASE}buzz/stream`);
    source.onmessage = (e) => {
      stopPolling();
      setMessages(JSON.parse(e.data) as BuzzMessage[]);
    };
    source.onerror = () => {
      if (!poll) poll = setInterval(fetchThread, 5000);
    };
    return () => {
      source.close();
      stopPolling();
    };
  }, [demo]);

  const refresh = useCallback(() => fetch(`${BASE}buzz`).then((r) => (r.ok ? r.json() : null)).then((m: BuzzMessage[] | null) => { if (m) setMessages(m); }).catch(() => undefined), []);

  /** Resolves null on success, or a short reason to show the person. */
  const send = useCallback(
    async (name: string, text: string, replyTo?: number): Promise<string | null> => {
      if (demo) {
        const at = Date.now();
        let mine: BuzzMessage | undefined;
        setMessages((m) => {
          const target = replyTo ? m.find((x) => x.id === replyTo) : undefined;
          mine = { id: m.length + 1, at, from: name || "Human", kind: "human", text, ...(target ? { quote: quoteOf(target) } : {}) };
          return [...m, mine];
        });
        setTimeout(() => setMessages((m) => [...m, { id: m.length + 1, at: Date.now(), from: ["Barry", "Alice", "Cora"][m.length % 3], kind: "agent", via: "host", text: CANNED[m.length % CANNED.length], ...(mine ? { quote: quoteOf(mine) } : {}) }]), 1500);
        return null;
      }
      try {
        const res = await fetch(`${BASE}buzz`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, text, ...(replyTo ? { replyTo } : {}) }) });
        if (res.ok) { void refresh(); return null; } // show it now, without waiting for the live stream to push it
        if (res.status === 503) return AWAY_MESSAGE; // no chatty agent is listening
        return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The hive answered ${res.status}.`;
      } catch {
        return "Could not reach the hive.";
      }
    },
    [demo, refresh],
  );

  return { messages, send, info };
}
