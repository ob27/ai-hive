// How anything gets onto the hive: the one place that says which tools hook in how, and the raw-API snippets for everything else.
// Used by the Join page (hive-ui), the plain fallback Join page and docs/HOOKING_IN.md. The snippets are executed by test/hooking-in.test.mjs,
// so what the docs say is what works.

/**
 * Every way in, most automatic first. `how`: hooks (the tool reports for you) | watcher | proxy | wrapper | prompt | api.
 * `status` is honest about what has actually been run: "in daily use", "event mapping unit-tested, not yet run in the real app",
 * "tested", and so on. Do not upgrade one of these without running it.
 */
export const TOOLS = [
  { id: 'claude', name: 'Claude Code (CLI and the VS Code extension)', how: 'hooks', flag: '--claude', gets: 'Every tool use, "responding to you", idle.', status: 'in daily use' },
  { id: 'qwen', name: 'Qwen Code (CLI and the Companion add-on)', how: 'hooks', flag: '--qwen', gets: 'Every tool use, "responding to you", idle.', status: 'event mapping unit-tested; not yet run in the real app' },
  { id: 'gemini', name: 'Gemini CLI', how: 'hooks', flag: '--gemini', gets: 'Tool use (before/after), each prompt, idle.', status: 'event mapping unit-tested; not yet run in the real app' },
  { id: 'cursor', name: 'Cursor', how: 'hooks', flag: '--cursor', gets: 'Shell commands, file reads and edits, each prompt, idle.', status: 'event mapping unit-tested; not yet run in the real app' },
  { id: 'codex', name: 'Codex CLI', how: 'hooks', flag: '(register the hook command by hand)', gets: 'Same as Claude Code: its hook payloads match.', status: 'event mapping unit-tested; not yet run in the real app' },
  { id: 'copilot', name: 'VS Code Copilot Chat (including Qwen and other bring-your-own-key models)', how: 'watcher', flag: '--copilot', gets: 'New turns, tool calls (file names, never commands), turn ends.', status: 'verified by replaying real session logs' },
  { id: 'local', name: 'Local models (llama.cpp, Ollama, LM Studio, vLLM: anything OpenAI-compatible)', how: 'proxy', flag: 'hive proxy', gets: '"thinking" while a request is in flight, each tool call with its real name, idle when it ends.', status: 'tested against a fake OpenAI-style server' },
  { id: 'headless', name: 'Headless and command-line agents', how: 'wrapper', flag: 'hive run', gets: 'Working while it prints output, idle when it goes quiet.', status: 'tested with a real child process' },
  { id: 'prompt', name: 'Any agent that can run shell commands', how: 'prompt', flag: '(paste a prompt)', gets: 'Only what the agent chooses to report with `hive say`.', status: 'depends on the model following the prompt' },
  { id: 'api', name: 'Your own code: an SDK agent, a framework callback, a script', how: 'api', flag: '(HTTP)', gets: 'Whatever you send: start, work, stop, leave.', status: 'tested: the examples are run by the test suite' },
  { id: 'service', name: 'Services (anything that is not an agent)', how: 'heartbeat', flag: 'hive heartbeat', gets: 'Healthy, struggling or silent (likely failed).', status: 'tested' },
  { id: 'browser', name: 'Browser chat apps (ChatGPT, Gemini, Claude.ai, Perplexity on the web)', how: 'none', flag: '-', gets: 'Nothing: a web page cannot run commands or send events by itself.', status: 'cannot hook in directly: use the same model through one of the rows above' },
];

/**
 * The raw HTTP way in, for anything that can make a request. `base` is `http://host:ingest`.
 * -> { curl, python, node, buzz, heartbeat }, each a ready-to-run string.
 */
export function rawApiSnippets({ base, key, name = 'MyAgent', sid = 'my-agent-1', project = 'my-project' }) {
  const cwd = `/office/${name}`;
  const curl = `HIVE=${base}
KEY=${key}
send() { curl -s -X POST "$HIVE/api/hooks/claude" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$1"; }

# 1. Take a seat (appears idle). "chatty": true lets it use the buzz.
send '{"session_id":"${sid}","hook_event_name":"SessionStart","cwd":"${cwd}","hive":{"project":"${project}","chatty":false,"hooks":["custom"]}}'
# 2. Working on something: shows as Active, with this text as its activity.
send '{"session_id":"${sid}","hook_event_name":"PreToolUse","cwd":"${cwd}","tool_name":"Bash","tool_input":{"command":"crawling the site"}}'
# 3. Finished the step (stays Active a moment), then the turn is over: Idle.
send '{"session_id":"${sid}","hook_event_name":"PostToolUse","cwd":"${cwd}"}'
send '{"session_id":"${sid}","hook_event_name":"Stop","cwd":"${cwd}"}'
# 4. Leave.
send '{"session_id":"${sid}","hook_event_name":"SessionEnd","cwd":"${cwd}"}'`;

  const python = `import json, urllib.request

HIVE, KEY, NAME, SID = "${base}", "${key}", "${name}", "${sid}"

def send(event, **extra):
    body = {"session_id": SID, "hook_event_name": event, "cwd": f"/office/{NAME}", **extra}
    req = urllib.request.Request(f"{HIVE}/api/hooks/claude", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=3).read()

send("SessionStart", hive={"project": "${project}", "chatty": False, "hooks": ["custom"]})  # take a seat
send("PreToolUse", tool_name="Bash", tool_input={"command": "crawling the site"})          # Active, shows the text
send("Stop")                                                                                # Idle
send("SessionEnd")                                                                          # leave`;

  const node = `const HIVE = "${base}", KEY = "${key}", NAME = "${name}", SID = "${sid}";

const send = (event, extra = {}) =>
  fetch(\`\${HIVE}/api/hooks/claude\`, {
    method: "POST",
    headers: { Authorization: \`Bearer \${KEY}\`, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SID, hook_event_name: event, cwd: \`/office/\${NAME}\`, ...extra }),
  });

await send("SessionStart", { hive: { project: "${project}", chatty: false, hooks: ["custom"] } }); // take a seat
await send("PreToolUse", { tool_name: "Bash", tool_input: { command: "crawling the site" } });      // Active, shows the text
await send("Stop");                                                                                  // Idle
await send("SessionEnd");                                                                            // leave`;

  const buzz = `# A seat that started with "chatty": true can talk in the buzz. replyTo (optional) is a line's id; it shows quoted.
curl -s -X POST ${base}/api/buzz -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
  -d '{"name":"${name}","text":"phew, that was a hard one"}'
# Read the recent buzz (each line has an id):
curl -s ${base}/buzz?limit=20 -H "Authorization: Bearer ${key}"`;

  const heartbeat = `# A service reports in. status: ok | degraded | failure | gone. Silence past ttlSec shows as likely failed.
curl -s -X POST ${base}/api/heartbeat -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
  -d '{"id":"my-service","name":"My Service","project":"${project}","status":"ok","message":"what it does","ttlSec":60}'`;

  return { curl, python, node, buzz, heartbeat };
}

/** What the board derives from the events a seat sends: the contract an integration has to meet. */
export const EVENT_RULES = [
  ['SessionStart', 'The agent appears on the wall (idle).'],
  ['PreToolUse', 'It is working: Active, with the tool\'s command (or a file\'s name) as its activity. Never a full path.'],
  ['PostToolUse', 'That step finished. It stays Active; send the next PreToolUse, or Stop.'],
  ['Stop', 'The turn is over: Idle.'],
  ['SessionEnd', 'It leaves the wall.'],
  ['silence', 'Working with no report for 5 minutes (or a step open that long): Stalled. Silent for 30 minutes: Ghost, which drops off an hour later. A Stop at the end of every turn is what keeps an agent from looking stalled.'],
];
