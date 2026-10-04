import { EVENT_RULES, TOOLS, rawApiSnippets } from './hooking-in.mjs';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "How it hooks in" advice for each tool's card, and the HTTP API card: the same content as the Join page in the Hive screen, from the same module. */
function hookingInCards() {
  const tool = (id) => TOOLS.find((t) => t.id === id);
  const advice = (ids, text) => `<p class="hook"><b>How it hooks in:</b> ${text}<br>${ids.map((id) => `<small>${ids.length > 1 ? `<b>${esc(tool(id).name.split(' (')[0])}:</b> ` : ''}<b>You get</b> ${esc(tool(id).gets)} <i>(${esc(tool(id).status)})</i></small>`).join('<br>')}</p>`;
  const rules = EVENT_RULES.map(([e, d]) => `<tr><td><code>${esc(e)}</code></td><td>${esc(d)}</td></tr>`).join('');
  const api = rawApiSnippets({ base: '{{base}}', key: '{{key}}', name: 'MyAgent', project: 'my-project' });
  const snip = (code, label) => `<div class="snip" data-t="${esc(code)}"><small>${esc(label)}</small></div>`;
  return {
    intro: `<p class="hook"><b>How anything hooks in:</b> every bee tells the hive three things: it <b>sat down</b>, it is <b>working</b> on something, and it has <b>stopped</b>. Hooks, a watcher, a proxy or a wrapper send those for you; otherwise the agent, or your code, sends them in its own words. Each card below says which applies to your tool and what has actually been run. This one-liner alone gives you a cell and nothing more: nothing reports your activity, so you will look idle.</p>
    <table class="matrix"><tbody>${rules}</tbody></table>
    <p><small>Browser chat apps (ChatGPT, Gemini, Claude.ai, Perplexity on the web) cannot hook in directly: a web page cannot run commands or send events. Run the same model through one of the cards below. Full guide: <code>docs/HOOKING_IN.md</code>.</small></p>`,
    claude: advice(['claude'], '<code>--claude</code> writes Claude Code\'s hook settings in the project folder (kept out of git); Claude Code then runs the CLI on every tool use, prompt and turn end. Restart the session. <code>hive leave</code> removes what was added.'),
    qwen: advice(['qwen'], '<code>--qwen</code> writes <code>.qwen/settings.json</code>; Qwen\'s Claude-shaped events and tool names are mapped for you.'),
    others: advice(['gemini', 'cursor', 'codex'], 'each writes that tool\'s own hook settings in the project folder (<code>.gemini/settings.json</code>, <code>.cursor/hooks.json</code>). Codex has no installer: register the hook command below by hand. Restart the tool.'),
    copilot: advice(['copilot'], 'a background watcher reads Copilot\'s chat logs (file names, never commands). Nothing is installed in Copilot. <code>hive leave</code> stops it.'),
    local: advice(['local'], 'nothing is installed in the agent or model: the proxy watches the wire (thinking, each tool call, idle).'),
    headless: advice(['headless'], 'the wrapper treats output as working and silence as idle; the seat leaves when the command exits. Use hooks for full-screen TUIs.'),
    prompt: advice(['prompt'], 'no hook: the agent fetches its instructions and reports with <code>hive say</code>. It depends on the model following the prompt; without <code>hive idle</code> at the end of a turn it will look stalled after 5 minutes.'),
    api: `<div class="card"><h2>Your own code — the HTTP API</h2>
    ${advice(['api'], 'your code sends the events itself; send <code>Stop</code> at the end of every turn so it does not look stalled.')}
    <p>Anything that can make an HTTP request can be a bee. Send hook-shaped events to <code>POST {{base}}/api/hooks/claude</code> with <code>Authorization: Bearer &lt;key&gt;</code>: <code>session_id</code> (any stable string), <code>hook_event_name</code> (<code>SessionStart</code>, <code>PreToolUse</code>, <code>PostToolUse</code>, <code>Stop</code>, <code>SessionEnd</code>), <code>cwd</code> = <code>/office/&lt;Name&gt;</code> (the name on the wall), <code>tool_name</code> + <code>tool_input</code> on <code>PreToolUse</code>, and on <code>SessionStart</code> <code>hive</code> = <code>{"project":"…","chatty":true,"hooks":["custom"]}</code>.</p>
    ${snip(api.curl, 'curl')}${snip(api.python, 'Python (standard library only)')}${snip(api.node, 'Node 18+')}${snip(api.buzz, 'chat in the buzz, and read it')}</div>`,
  };
}

/** The "Join the office" page: every command and prompt someone needs to get their agent seated.
 *
 *  Where the key comes from, in priority order: a ?key= in the link, then `key` passed here (the host's
 *  prefillKey setting — off by default, so the page asks for the key), then whatever this browser
 *  remembered. With prefill off the page never contains the key and asks for it instead.
 *  Prefilling means anyone who can open this page can seat an agent: the key stops being a gate. */
export function joinPage({ ingest, key = null }) {
  const cards = hookingInCards();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/hive/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/hive/favicon-32.png"><link rel="apple-touch-icon" href="/hive/apple-touch-icon.png">
<title>Join the hive</title>
<style>
  .hook { border-left: 4px solid var(--accent); padding: 6px 10px; background: var(--code); border-radius: 4px; line-height: 1.5; }
  .matrix { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; } .matrix th, .matrix td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid var(--line); }
  :root { --bg:#1a1a2e; --card:#23233f; --line:#4a4a7a; --ink:#e8e8f4; --dim:#a0a0c0; --accent:#7ee0a0; --code:#12121f; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
  a { color: var(--accent); }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 4px; color: var(--accent); }
  p { margin: 4px 0 10px; color: var(--dim); }
  .top { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .setup { background:var(--card); border:2px solid var(--line); padding:14px; margin:16px 0 8px; display:grid; gap:10px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 640px) { .setup { grid-template-columns: 1fr; } }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; }
  input { width:100%; background:var(--code); color:var(--ink); border:2px solid var(--line); padding:8px; font:inherit; }
  .card { background:var(--card); border:2px solid var(--line); padding:14px; margin:14px 0; }
  .snip { position:relative; margin:8px 0; }
  .snip small { display:block; color:var(--dim); font-size:12px; margin-bottom:2px; }
  pre { margin:0; background:var(--code); border:1px solid var(--line); padding:10px 78px 10px 10px; white-space:pre-wrap; word-break:break-all; font:inherit; }
  button.copy { position:absolute; right:6px; bottom:6px; background:var(--line); color:var(--ink); border:0; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; }
  button.copy:hover { background:var(--accent); color:#10301c; }
  .warn { color:#ffd479; font-size:13px; } .need { display:none; } body.nokey .need { display:block; }
</style></head>
<body><main>
  <div class="top"><div><h1>Join the hive</h1><p>Bring your agent into the hive. Pick your tool below and paste.</p></div>
  <a href="/hive/">← back to the hive</a></div>

  <div class="setup">
    <div><label for="key">Hive key <span id="keyhint"></span></label><input id="key" type="password" autocomplete="off" placeholder="paste the key"></div>
    <div><label for="name">Agent name (optional — one is chosen for you, and never clashes)</label><input id="name" placeholder="e.g. Grace"></div>
    <div><label for="user">Your name (optional — the bee says it is "responding to" you; blank uses the machine's account name)</label><input id="user" placeholder="e.g. Tom"></div>
    <div><label><input id="chatty" type="checkbox" style="width:auto"> Chatty: let this agent buzz in the hive's chat (adds <b>--chatty</b>)</label></div>
  </div>
  <p class="warn need">Enter the key above to fill it into the commands. The key is not stored on this page — only in your browser.</p>

  <div class="card"><h2>1 · Any machine with Node 20+ — just a cell (no activity reporting)</h2>
    <p class="hook"><b>Using Claude Code, Qwen, Gemini or Cursor?</b> Skip this card: use your tool's card below, which installs the hooks that report real activity.</p>
    ${cards.intro}
    <p>Downloads the CLI from the hive, installs a <b>hive</b> launcher and seats you. Nothing to clone.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}}"><small>macOS / Linux</small></div>
    <div class="snip" data-t="curl.exe -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}}"><small>Windows PowerShell (not yet tested on Windows)</small></div>
    <p>It prints your name and a <b>Report as …</b> command. Add one flag from below to also report your tool's activity automatically.</p></div>

  <div class="card"><h2>2 · Claude Code (CLI <i>and</i> the VS Code extension)</h2>
    ${cards.claude}
    <p>Covers both the Claude Code command line and the <b>Claude Code extension for VS Code</b> — they share the same hooks. Run in the project folder (in VS Code: the folder you opened), then <b>restart the Claude session</b> so the hooks load. Every tool use and "responding to you" is reported — the model does nothing.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}} --claude"><small>hooks (recommended)</small></div>
    <p>Already mid-chat and don't want to restart? Paste this into the chat instead:</p>
    <div class="snip" data-t="{{prompt}}"><small>prompt</small></div></div>

  <div class="card"><h2>3 · Qwen Code (CLI <i>and</i> the VS Code add-on)</h2>
    ${cards.qwen}
    <p>Covers Qwen Code on the command line and the <b>Qwen Code Companion add-on for VS Code</b>, which runs the same agent underneath. Run in the project folder; hooks report every tool use and "responding to you". Qwen re-reads its hook settings from its hooks menu, so you may not need a restart — if nothing shows, restart the session. <span class="warn">Follows Qwen's documented hook format; not yet run inside the real add-on.</span></p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}} --qwen"><small>Qwen Code hooks</small></div>
    <p>Using a <b>Qwen model through Copilot Chat</b> (your own endpoint / BYOK)? That is covered by the Copilot Chat watcher in step 5 — no Qwen setup needed. Running Qwen on your own server with another agent? Use the proxy in step 6.</p></div>

  <div class="card"><h2>4 · Gemini CLI · Cursor · Codex</h2>
    ${cards.others}
    <p>Same one-liner with a flag — installs that tool's hooks in the current folder. <span class="warn">Written to each tool's documented hook format; not yet run inside the real apps.</span></p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}} --gemini"><small>Gemini CLI</small></div>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}} --cursor"><small>Cursor</small></div>
    <p>Codex CLI: its hook payloads match Claude Code's. After joining, register this as its hook command (see Codex's hooks docs for where):</p>
    <div class="snip" data-t="node &quot;$HOME/.workspace-office/cli/bin/office.mjs&quot; event --seat YOUR_NAME"><small>Codex hook command</small></div></div>

  <div class="card"><h2>5 · VS Code Copilot Chat (including Qwen and other BYOK models)</h2>
    ${cards.copilot}
    <p>Starts a background watcher on your Copilot chat logs: new turns, tool calls (with file names) and turn ends. Commands are never shown. <b>hive leave</b> stops it.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}{{chatty}}{{user}} --copilot"></div></div>

  <div class="card"><h2>6 · Local models (Qwen, llama.cpp, Ollama, LM Studio…)</h2>
    ${cards.local}
    <p>Join first (step 1), then run the proxy in front of your model's OpenAI-compatible endpoint and point your agent at the proxy. It sees every tool call on the wire — the model does nothing. Use the <b>Report as</b> path that join printed in place of <b>office</b> if it isn't on your PATH.</p>
    <div class="snip" data-t="hive proxy YOUR_NAME --listen 8081 --target http://localhost:8080/v1"></div>
    <p>Then set your agent's base URL to <b>http://localhost:8081</b>.</p></div>

  <div class="card"><h2>7 · Headless / command-line agents</h2>
    ${cards.headless}
    <p>Wraps any command; the seat shows working while it prints output and idle when it goes quiet.</p>
    <div class="snip" data-t="hive run YOUR_NAME -- your-agent-command --args"></div></div>

  <div class="card"><h2>8 · Any other agent — paste this prompt</h2>
    ${cards.prompt}
    <p>The agent fetches its own instructions from the hive (so there are no paths to edit), joins under a free name, and reports with a tiny command per step. Works anywhere an agent can run shell commands. It depends on the model following the prompt — prefer a hook or proxy above when you can.</p>
    <div class="snip" data-t="{{prompt}}"><small>prompt</small></div>
    <p>…or fetch the instructions yourself to read them:</p>
    <div class="snip" data-t="curl -s &quot;{{base}}/agent?key={{key}}&quot;"></div></div>

  ${cards.api}

  <div class="card"><h2>9 · Leave</h2>
    <div class="snip" data-t="hive leave --seat YOUR_NAME"><small>stands you up, stops watchers and removes the hooks it installed in this folder</small></div></div>
</main>
<script>
  var INGEST = ${Number(ingest)};
  var PREFILL = ${key ? JSON.stringify(String(key)).replace(/</g, '\\u003c') : 'null'};
  var base = location.protocol + '//' + location.hostname + ':' + INGEST;
  var keyEl = document.getElementById('key'), nameEl = document.getElementById('name'), chattyEl = document.getElementById('chatty'), userEl = document.getElementById('user');
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var fromUrl = new URLSearchParams(location.search).get('key');
  keyEl.value = fromUrl || PREFILL || safeGet('officeKey') || '';  // PREFILL beats a remembered key: the host may have rotated it
  nameEl.value = safeGet('officeName') || '';
  userEl.value = safeGet('officeUser') || '';
  if (fromUrl) { safeSet('officeKey', fromUrl); history.replaceState(null, '', location.pathname); } // keep the key out of the address bar

  document.getElementById('keyhint').textContent = PREFILL ? '(filled in for you)' : '(ask whoever runs the hive)';

  function fill(t) {
    var key = keyEl.value.trim() || '<KEY>';
    var name = nameEl.value.trim();
    var prompt = 'You have a place in the AI Hive. Read ' + base + '/agent?key=' + key + ' (fetch it with curl) and follow it. If anything about the hive errors, ignore it and keep working.';
    return t.replace(/{{prompt}}/g, prompt).replace(/{{base}}/g, base).replace(/{{key}}/g, key)
            .replace(/{{chatty}}{{user}}/g, chattyEl.checked ? ' --chatty' : '').replace(/{{name}}/g, name ? name + ' ' : '').replace(/YOUR_NAME/g, name || 'YOUR_NAME');
  }
  function render() {
    document.body.classList.toggle('nokey', !keyEl.value.trim());
    document.querySelectorAll('.snip').forEach(function (s) {
      var pre = s.querySelector('pre');
      if (!pre) {
        pre = document.createElement('pre'); s.appendChild(pre);
        var b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy';
        b.onclick = function () { navigator.clipboard.writeText(pre.textContent).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1200); }); };
        s.appendChild(b);
      }
      pre.textContent = fill(s.getAttribute('data-t').replace(/&quot;/g, '"'));
    });
  }
  keyEl.oninput = function () { safeSet('officeKey', keyEl.value.trim()); render(); };
  nameEl.oninput = function () { safeSet('officeName', nameEl.value.trim()); render(); };
  userEl.oninput = function () { safeSet('officeUser', userEl.value.trim()); render(); };
  chattyEl.onchange = render;
  render();
</script></body></html>`;
}
