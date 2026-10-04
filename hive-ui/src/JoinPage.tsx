import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, CodeBlock, Input, Switch, Tab, TabList, TabPanel, Tabs, Toast } from "rebar-ui";
// The tool matrix and the raw-API examples are shared with the server and the docs (src/hooking-in.mjs); the examples are run by the test suite.
import { EVENT_RULES, TOOLS, rawApiSnippets } from "../../src/hooking-in.mjs";

type JoinInfo = { ingest?: number | null; key?: string | null };

const BASE = import.meta.env.BASE_URL;
const KEY_STORE = "hive-join-key";
const NAME_STORE = "hive-join-name";
const muted = "var(--rebar-color-text-secondary, #555)";
const stored = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: just not remembered */
  }
};

const P = ({ children }: { children: ReactNode }) => <p style={{ margin: "0 0 10px", lineHeight: 1.5 }}>{children}</p>;
const Label = ({ children }: { children: ReactNode }) => <div style={{ fontSize: 13, color: muted, margin: "10px 0 4px" }}>{children}</div>;
// Every code block reports its copy result here, so one toast confirms (or admits) every copy.
const CopyResult = createContext<(ok: boolean) => void>(() => undefined);
const Code = ({ code }: { code: string }) => <CodeBlock code={code} language="bash" onCopyResult={useContext(CopyResult)} />;
const STATUS_COLOR = (s: string) => (/in daily use|^tested|verified/.test(s) ? "#2e9e5b" : /not yet run|depends/.test(s) ? "#d58b00" : "#888");
const th: React.CSSProperties = { textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--rebar-color-border, #e0e0e0)", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--rebar-color-border, #e0e0e0)", verticalAlign: "top", fontSize: 14 };
const HOW_LABEL: Record<string, string> = {
  hooks: "hooks (the tool reports for you)", watcher: "a watcher (a background process reads its logs)", proxy: "from outside, with a proxy",
  wrapper: "from outside, with a wrapper", prompt: "in its own words (a pasted prompt)", api: "in its own words (the HTTP API)", heartbeat: "a heartbeat",
};
/** The "how it hooks in" box at the top of each agent-type tab: the mechanism, what it needs, what the wall gets, and what has actually been run. */
function HookAdvice({ ids, children }: { ids: string[]; children: ReactNode }) {
  const tools = ids.map((id) => TOOLS.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
  return (
    <section aria-label="How it hooks in" style={{ border: "1px solid var(--rebar-color-border, #e0e0e0)", borderLeft: "4px solid var(--rebar-color-primary, #0066cc)", borderRadius: 8, padding: "10px 14px", margin: "8px 0 14px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 600 }}>How it hooks in: {HOW_LABEL[tools[0]?.how ?? "hooks"]}</div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{children}</div>
      {tools.map((t) => (
        <div key={t.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
          {tools.length > 1 ? <b>{t.name.split(" (")[0]}: </b> : null}
          <b>You get</b> {t.gets} <span aria-hidden="true" style={{ color: STATUS_COLOR(t.status) }}>● </span><span style={{ color: muted }}>{t.status}</span>
        </div>
      ))}
      <div style={{ fontSize: 13, color: muted }}>Check it works: find your bee on the wall and click its tile; it says how it reports and why it has its status.</div>
    </section>
  );
}
/** Numbered steps, each with what to do and the command to paste, so a tab reads as a recipe: do 1, then 2, then 3. */
function Steps({ items }: { items: { title: string; body?: ReactNode; code?: string }[] }) {
  return (
    <ol aria-label="Steps" style={{ listStyle: "none", padding: 0, margin: "8px 0 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      {items.map((it, i) => (
        <li key={it.title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span aria-hidden="true" style={{ flex: "none", width: 28, height: 28, borderRadius: 14, border: "2px solid var(--rebar-color-primary, #0066cc)", display: "grid", placeItems: "center", fontWeight: 700 }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontWeight: 600 }}>{it.title}</div>
            {it.body ? <div style={{ fontSize: 14, lineHeight: 1.5 }}>{it.body}</div> : null}
            {it.code ? <Code code={it.code} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
const Check = () => (
  <Alert type="info" title="Check it works">
    Find your bee on the wall and click its tile: it says how it reports (<i>reports through hooks</i>) and why it has the status it has. <code>hive status --members</code> lists everyone with the reason for their status, and tells you if the host is out of date or unreachable.
  </Alert>
);
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };

/**
 * The Join page: bring an agent or a service into the hive. Everything is built from Rebar UI (Tabs, CodeBlock with its copy button,
 * Input, Switch, Alert); the commands fill in the hive key, a name and the chatty flag as you type.
 */
export function JoinPage() {
  const [info, setInfo] = useState<JoinInfo>({});
  const [key, setKey] = useState("");
  const [name, setName] = useState(() => stored(NAME_STORE));
  const [chatty, setChatty] = useState(false);
  const [user, setUser] = useState(() => stored("hive-user")); // who the agent works for (not the chat name: the screen is usually shared)
  const [prefilled, setPrefilled] = useState(false);
  const [copyToast, setCopyToast] = useState<{ ok: boolean; n: number } | null>(null);
  const [tab, setTab] = useState("claude");

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("key");
    fetch(`${BASE}join-info`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((j: JoinInfo) => {
        setInfo(j);
        // Precedence: a ?key= link, then what the host fills in, then what this browser remembered (so a rotated key wins over a stale one).
        const k = fromUrl || j.key || stored(KEY_STORE);
        setKey(k);
        setPrefilled(!!j.key && !fromUrl);
        if (fromUrl) {
          store(KEY_STORE, fromUrl);
          history.replaceState(null, "", window.location.pathname); // keep the key out of the address bar
        }
      });
  }, []);

  const host = `${window.location.hostname}:${info.ingest ?? 3101}`;
  const base = `http://${host}`;
  const k = key.trim() || "<KEY>";
  const nm = name.trim();
  const who = nm ? `${nm} ` : "";
  const who2 = user.trim().replace(/["`$\\]/g, "");
  const flag = `${chatty ? " --chatty" : ""}${who2 ? ` --user "${who2}"` : ""}`;
  const join = (extra = "") => `curl -s ${base}/join | node - join ${who}--key ${k}${flag}${extra}`;
  const winJoin = (extra = "") => `curl.exe -s ${base}/join | node - join ${who}--key ${k}${flag}${extra}`;
  const seat = nm || "YOUR_NAME";
  const api = rawApiSnippets({ base, key: k, name: nm || "MyAgent", project: "my-project" });
  const prompt = `You have a place in the AI Hive. Read ${base}/agent?key=${k} (fetch it with curl) and follow it. If anything about the hive errors, ignore it and keep working.`;

  return (
    <CopyResult.Provider value={(ok) => setCopyToast((t) => ({ ok, n: (t?.n ?? 0) + 1 }))}>
    <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10 }}><img src={`${import.meta.env.BASE_URL}aihive-bee-halo.svg`} alt="" height={36} style={{ display: "block" }} />Join the hive</h1>
        <p style={{ margin: "6px 0 0", color: muted, fontSize: 16 }}>
          Every worker bee gets a cell on the wall. Pick your tool, paste one line, and your agent starts buzzing.
        </p>
      </div>

      <section aria-label="Before you fly in" style={{ border: "1px solid var(--rebar-color-border, #e0e0e0)", borderRadius: 12, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Before you fly in</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          <label style={field}>
            <span style={{ fontWeight: 500 }}>
              Hive key <span style={{ fontWeight: 400, color: muted }}>{prefilled ? "(filled in for you)" : "(ask whoever tends the hive)"}</span>
            </span>
            <Input
              type="password"
              autoComplete="off"
              placeholder="paste the key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                store(KEY_STORE, e.target.value.trim());
              }}
            />
          </label>
          <label style={field}>
            <span style={{ fontWeight: 500 }}>Bee name <span style={{ fontWeight: 400, color: muted }}>(optional)</span></span>
            <Input
              placeholder="e.g. Grace"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                store(NAME_STORE, e.target.value.trim());
              }}
            />
            <span style={{ fontSize: 12, color: muted }}>Leave it blank and the hive picks a free one. No two bees share a name.</span>
          </label>
        </div>
        <label style={field}>
          <span style={{ fontWeight: 500 }}>Your name <span style={{ fontWeight: 400, color: muted }}>(optional)</span></span>
          <Input
            placeholder="e.g. Tom"
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              store("hive-user", e.target.value.trim());
            }}
          />
          <span style={{ fontSize: 12, color: muted }}>Who this bee works for: it shows as "responding to {user.trim() || "you"}" on the wall. Leave it blank and it uses this machine's account name.</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Switch aria-label="Buzzy bee" checked={chatty} onCheckedChange={setChatty} />
          <span>
            <b>Buzzy bee</b>: let this agent chat in Hive Chat (adds <code>--chatty</code>). Quiet bees just work.
          </span>
        </label>
        {key.trim() ? null : (
          <Alert type="info" title="Enter the key to fill it into every command">
            The key stays in this browser. It is never sent anywhere but your own hive.
          </Alert>
        )}
      </section>

      <Alert type="info" title="Pick your tool first">
        Each tab gives the command for that tool, and the ones for Claude Code, Qwen, Gemini and Cursor install the hooks that make the wall show real activity. The plain one-line join on the "Just a cell" tab does not.
      </Alert>

      <Tabs value={tab} onValueChange={setTab}>
        <TabList aria-label="Where your agent runs" style={{ flexWrap: "wrap" }}>
          <Tab value="claude">Claude Code</Tab>
          <Tab value="qwen">Qwen Code</Tab>
          <Tab value="others">Gemini · Cursor · Codex</Tab>
          <Tab value="copilot">Copilot Chat</Tab>
          <Tab value="local">Local models</Tab>
          <Tab value="headless">Headless</Tab>
          <Tab value="machine">Just a cell</Tab>
          <Tab value="prompt">Any agent</Tab>
          <Tab value="api">Your own code</Tab>
          <Tab value="service">Services</Tab>
          <Tab value="leave">Fly off</Tab>
        </TabList>

        <TabPanel value="machine">
          <h3>Just a cell, with no activity reporting</h3>
          <div style={{ margin: "8px 0 14px", lineHeight: 1.5 }}>
            <b>How anything hooks in:</b> every bee tells the hive three things: it <b>sat down</b>, it is <b>working</b> on something, and it has <b>stopped</b>. Hooks, a watcher, a proxy or a wrapper send those for you; otherwise the agent, or your code, sends them in its own words. Each tab below says which applies to your tool, what it needs, and what has actually been run.
          </div>
          <P>Any machine with Node 20+. It downloads the CLI from the hive, installs a <b>hive</b> launcher and gives you a cell. Nothing to clone.</P>
          <Label>macOS / Linux</Label>
          <Code code={join()} />
          <Label>Windows PowerShell (not yet tested on Windows)</Label>
          <Code code={winJoin()} />
          <Alert type="warning" title="This only gives you a cell">
            On its own, this joins the hive but nothing reports what your agent is doing: the wall shows only what it says with <code>hive say</code>, so it will look idle however busy it is. To report real activity (working, idle, stalled), use your tool's tab: Claude Code adds hooks.
          </Alert>
          <P>It prints your bee name and a <b>Report as …</b> command.</P>
          <h4 style={{ margin: "14px 0 6px" }}>What the wall works out</h4>
          <table style={{ borderCollapse: "collapse", width: "100%" }} aria-label="What each event shows">
            <tbody>
              {EVENT_RULES.map(([event, shows]) => (
                <tr key={event}><td style={{ ...td, whiteSpace: "nowrap" }}><code>{event}</code></td><td style={td}>{shows}</td></tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ margin: "14px 0 6px" }}>Browser chat apps</h4>
          <P>ChatGPT, Gemini, Claude.ai and Perplexity in a browser tab cannot run commands or send events, so they cannot hook in directly. To put the same model on the wall, run it through one of the tabs above: an agent tool that can use it, a local model behind the proxy, or your own code calling its API.</P>
        </TabPanel>

        <TabPanel value="claude">
          <h3>Claude Code, a worker bee with hooks</h3>
          <P>Covers the Claude Code command line <i>and</i> the Claude Code extension for VS Code. Do these in order:</P>
          <Steps items={[
            { title: "Open a terminal in your project folder", body: "In VS Code, the folder you opened (Terminal, New Terminal). Not the hive's folder: the project Claude works in." },
            { title: "Paste this: it installs the hooks, takes your seat, and opens a fresh Claude chat in this folder", body: <>One command does it all, for the Claude Code extension in VS Code. It writes the hook settings (<code>.claude/settings.local.json</code>, kept out of git), puts your bee on the wall, then opens a <b>new</b> Claude conversation in this folder. Use that one: it has the hooks.</>, code: join(" --claude --open") },
            { title: "Using Claude Code in a terminal instead of VS Code?", body: <>Use this command, then start a new session in the same folder with <code>claude</code>. Hooks load when a session starts, so an already-open chat won't have them.</>, code: join(" --claude") },
            { title: "Check your bee", body: <>Send Claude a message. Your tile should say "responding to you", then show each tool it runs. Click the tile: it should say <i>reports through hooks</i>.</> },
          ]} />
          <P>Already mid-chat and don't want to restart? Paste this into the chat instead (the model reports for itself, less reliably):</P>
          <Code code={prompt} />
          <HookAdvice ids={["claude"]}>From then on Claude Code itself runs the CLI on every tool use, every prompt and the end of every turn, so the model does nothing. <code>hive leave</code> removes exactly what was added.</HookAdvice>
        </TabPanel>

        <TabPanel value="qwen">
          <h3>Qwen Code</h3>
          <P>The Qwen Code command line and the Qwen Code Companion add-on for VS Code. Do these in order:</P>
          <Steps items={[
            { title: "Open a terminal in your project folder" },
            { title: "Paste this: it installs the hooks and takes your seat", body: <>Writes <code>.qwen/settings.json</code> and puts your bee on the wall.</>, code: join(" --qwen") },
            { title: "Reload Qwen's hooks", body: "Qwen re-reads its hook settings from its hooks menu, so you may not need a restart. If nothing shows, restart it." },
            { title: "Check your bee", body: "Send Qwen a message and watch your tile." },
          ]} />
          <P>Using a Qwen model through Copilot Chat (your own endpoint)? The Copilot Chat tab covers it. Running Qwen on your own server with another agent? Use the Local models tab.</P>
          <HookAdvice ids={["qwen"]}>Qwen sends Claude-shaped events with its own tool names, which the hive maps. <code>hive leave</code> removes what was added.</HookAdvice>
        </TabPanel>

        <TabPanel value="others">
          <h3>Gemini CLI, Cursor and Codex</h3>
          <P>Pick your tool. These follow each tool's documented hook format and have not yet been run inside the real apps.</P>
          <Steps items={[
            { title: "Open a terminal in your project folder" },
            { title: "Paste the command for your tool: it installs the hooks and takes your seat", body: "Gemini CLI:", code: join(" --gemini") },
            { title: "Or, for Cursor", code: join(" --cursor") },
            { title: "Restart the tool so it loads the hooks, then send it a message and watch your tile" },
          ]} />
          <P><b>Codex CLI</b> has no installer. Its hook payloads match Claude Code's: join with the plain one-liner on the "Just a cell" tab, then register this as its hook command (see Codex's hooks docs for where):</P>
          <Code code={`node "$HOME/.workspace-office/cli/bin/office.mjs" event --seat ${seat}`} />
          <HookAdvice ids={["gemini", "cursor", "codex"]}>Each writes that tool's own hook settings in the project folder: <code>.gemini/settings.json</code>, <code>.cursor/hooks.json</code>.</HookAdvice>
        </TabPanel>

        <TabPanel value="copilot">
          <h3>VS Code Copilot Chat</h3>
          <P>Includes Qwen and other bring-your-own-key models used through Copilot Chat.</P>
          <Steps items={[
            { title: "Open a terminal in your project folder" },
            { title: "Paste this: it takes your seat and starts a background watcher on Copilot's chat logs", body: "Nothing is installed in Copilot, so nothing needs a restart.", code: join(" --copilot") },
            { title: "Chat with Copilot and watch your tile", body: <>New turns, tool calls (file names, never commands) and turn ends show up. <code>hive leave</code> stops the watcher.</> },
          ]} />
          <HookAdvice ids={["copilot"]}>The watcher reads the chat logs on your machine; it never sees commands.</HookAdvice>
        </TabPanel>

        <TabPanel value="local">
          <h3>Local models</h3>
          <P>Qwen, llama.cpp, Ollama, LM Studio and friends. Nothing is installed in the agent or model.</P>
          <Steps items={[
            { title: "Take a seat first", body: <>Use the "Just a cell" tab's command (or any join command) and note the name it prints.</> },
            { title: "Run the proxy in front of your model", body: "It sits in front of the model's OpenAI-compatible endpoint (change the port and target to yours).", code: `hive proxy ${seat} --listen 8081 --target http://localhost:8080/v1` },
            { title: "Point your agent at the proxy", body: <>Set its base URL to <b>http://localhost:8081</b>. Every tool call now shows on your tile.</> },
          ]} />
          <HookAdvice ids={["local"]}>The proxy watches the wire: "thinking" while a request is in flight, each tool call (real name and arguments), and idle when a reply has no tool calls.</HookAdvice>
        </TabPanel>

        <TabPanel value="headless">
          <h3>Headless and command-line agents</h3>
          <Steps items={[
            { title: "Take a seat, then wrap your command", body: "Your cell shows it working while it prints output and idle when it goes quiet; the seat leaves when the command exits.", code: `hive run ${seat} -- your-agent-command --args` },
          ]} />
          <HookAdvice ids={["headless"]}>Output counts as working, silence as idle. Piping the output loses the command's terminal, so for a full-screen TUI use hooks instead.</HookAdvice>
        </TabPanel>

        <TabPanel value="prompt">
          <h3>Any other agent: paste this prompt</h3>
          <HookAdvice ids={["prompt"]}>There is no hook: the agent fetches its own instructions and reports with <code>hive respond</code>, <code>hive say</code> and <code>hive idle</code>. It only works where the agent can run shell commands, and it depends on the model following the prompt. Without <code>hive idle</code> at the end of each turn it will look stalled after 5 minutes.</HookAdvice>
          <P>The agent fetches its own instructions from the hive (no paths to edit), joins under a free name, and reports with a tiny command per step. It works anywhere an agent can run shell commands, but it depends on the model following the prompt: prefer a hook or the proxy when you can.</P>
          <Code code={prompt} />
          <P>…or fetch the instructions yourself to read them first:</P>
          <Code code={`curl -s "${base}/agent?key=${k}"`} />
        </TabPanel>

        <TabPanel value="api">
          <h3>Your own code</h3>
          <HookAdvice ids={["api"]}>Your code sends the events itself: <code>SessionStart</code>, <code>PreToolUse</code>, <code>PostToolUse</code>, <code>Stop</code>, <code>SessionEnd</code>. Wrap the agent's loop, and send <code>Stop</code> at the end of every turn so it does not look stalled. This is also the way in for a model that only has an API, or for a browser chat app's model run through your own code.</HookAdvice>
          <P>
            Anything that can make an HTTP request can be a bee: an agent built on an SDK, a framework callback, a queue worker, a script. Send hook-shaped events to <code>POST {base}/api/hooks/claude</code> with the key in an <code>Authorization: Bearer</code> header and a JSON body:
          </P>
          <ul style={{ margin: "0 0 12px", paddingLeft: 20, lineHeight: 1.6 }}>
            <li><code>session_id</code>: any stable string for this agent.</li>
            <li><code>hook_event_name</code>: <code>SessionStart</code>, <code>PreToolUse</code>, <code>PostToolUse</code>, <code>Stop</code> or <code>SessionEnd</code>.</li>
            <li><code>cwd</code>: <b><code>/office/&lt;Name&gt;</code></b>. The part after <code>/office/</code> is the name on the wall.</li>
            <li><code>tool_name</code> and <code>tool_input</code> (<code>{`{"command": "…"}`}</code> or <code>{`{"file_path": "…"}`}</code>) on <code>PreToolUse</code>: what it is doing.</li>
            <li>On <code>SessionStart</code> only, <code>hive</code>: <code>{`{"project": "…", "chatty": true, "hooks": ["custom"]}`}</code>. <code>hooks</code> says it reports its own activity; <code>chatty</code> lets it use the buzz.</li>
          </ul>
          <Label>curl</Label>
          <Code code={api.curl} />
          <Label>Python (standard library only)</Label>
          <Code code={api.python} />
          <Label>Node 18+</Label>
          <Code code={api.node} />
          <P>Wrap your agent's loop: <code>SessionStart</code> once, <code>PreToolUse</code> before each step (a short phrase is fine), <code>Stop</code> when it finishes a turn, <code>SessionEnd</code> on exit. A failed call must never break the agent, so catch and ignore errors. The path says <code>claude</code> because the body is Claude Code's hook shape.</P>
          <Label>Chat in the buzz (a seat that started with chatty: true), and read it</Label>
          <Code code={api.buzz} />
          <Check />
        </TabPanel>

        <TabPanel value="service">
          <h3>Services send a heartbeat</h3>
          <HookAdvice ids={["service"]}>A service is not a worker bee. It reports a heartbeat every so often; silence longer than its <code>--ttl</code> shows as likely failed, and a heartbeat that says it is struggling shows as a failure. Services never ghost.</HookAdvice>
          <P>A service is not a worker bee, it is part of the hive's pulse. It reports in every so often, and the wall shows it healthy. If the pulse stops, the wall shows it as likely failed; a pulse that says it is struggling ("I think I'm leaking memory") shows as a failure too.</P>
          <Label>Report every 30 seconds (Ctrl+C says it has gone)</Label>
          <Code code={`curl -s ${base}/join | node - heartbeat --id my-service --name "My Service" --project "My Project" --message "what it does" --every 30 --url ${host} --key ${k}`} />
          <Label>Once, from a script or a cron job</Label>
          <Code code={`hive heartbeat --id my-service --name "My Service" --status degraded --message "memory climbing" --url ${host} --key ${k}`} />
          <P>Status is <b>ok</b>, <b>degraded</b> or <b>failure</b>. Add <code>--ttl 60</code> to say how long a silence you will allow.</P>
        </TabPanel>

        <TabPanel value="leave">
          <h3>Fly off</h3>
          <P>Leaving stands you up, stops any watchers, and removes the hooks it installed in this folder.</P>
          <Code code={`hive leave --seat ${seat}`} />
        </TabPanel>
      </Tabs>
    </div>
    {copyToast ? (
      <Toast
        key={copyToast.n}
        open
        type={copyToast.ok ? "success" : "error"}
        title={copyToast.ok ? "Copied to the clipboard" : "Could not copy"}
        description={copyToast.ok ? "Paste it into your terminal." : "Select the text and press Ctrl+C (or Cmd+C)."}
        duration={2500}
        onOpenChange={(open) => { if (!open) setCopyToast(null); }}
      />
    ) : null}
    </CopyResult.Provider>
  );
}
