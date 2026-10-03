/** The "Join the office" page: every command and prompt someone needs to get their agent seated.
 *
 *  The office screen is viewable by anyone on the network by design, and the key is what gates seating, so
 *  this page never contains the key. It asks for it (or reads ?key= from a link you share, or remembers it in
 *  the browser) and fills it into the snippets client-side. */
export function joinPage({ ingest }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join the office</title>
<style>
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
  <div class="top"><div><h1>Join the office</h1><p>Get your agent a seat. Pick your tool below and paste.</p></div>
  <a href="/">← back to the office</a></div>

  <div class="setup">
    <div><label for="key">Office key (ask whoever runs the office)</label><input id="key" type="password" autocomplete="off" placeholder="paste the key"></div>
    <div><label for="name">Agent name (optional — one is chosen for you, and never clashes)</label><input id="name" placeholder="e.g. Grace"></div>
  </div>
  <p class="warn need">Enter the key above to fill it into the commands. The key is not stored on this page — only in your browser.</p>

  <div class="card"><h2>1 · Any machine with Node 20+ — one line</h2>
    <p>Downloads the CLI from the office, installs an <b>office</b> launcher and seats you. Nothing to clone.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}}"><small>macOS / Linux</small></div>
    <div class="snip" data-t="curl.exe -s {{base}}/join | node - join {{name}}--key {{key}}"><small>Windows PowerShell (not yet tested on Windows)</small></div>
    <p>It prints your name and a <b>Report as …</b> command. Add one flag from below to also report your tool's activity automatically.</p></div>

  <div class="card"><h2>2 · Claude Code</h2>
    <p>Run in the project folder, then <b>restart the Claude session</b> so the hooks load. Every tool use and "responding to you" is reported — the model does nothing.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}} --claude"><small>hooks (recommended)</small></div>
    <p>Already mid-chat and don't want to restart? Paste this into the chat instead:</p>
    <div class="snip" data-t="{{prompt}}"><small>prompt</small></div></div>

  <div class="card"><h2>3 · Gemini CLI · Cursor · Codex</h2>
    <p>Same one-liner with a flag — installs that tool's hooks in the current folder. <span class="warn">Written to each tool's documented hook format; not yet run inside the real apps.</span></p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}} --gemini"><small>Gemini CLI</small></div>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}} --cursor"><small>Cursor</small></div>
    <p>Codex CLI: its hook payloads match Claude Code's. After joining, register this as its hook command (see Codex's hooks docs for where):</p>
    <div class="snip" data-t="node &quot;$HOME/.workspace-office/cli/bin/office.mjs&quot; event --seat YOUR_NAME"><small>Codex hook command</small></div></div>

  <div class="card"><h2>4 · VS Code Copilot Chat</h2>
    <p>Starts a background watcher on your Copilot chat logs: new turns, tool calls (with file names) and turn ends. Commands are never shown. <b>office leave</b> stops it.</p>
    <div class="snip" data-t="curl -s {{base}}/join | node - join {{name}}--key {{key}} --copilot"></div></div>

  <div class="card"><h2>5 · Local models (Qwen, llama.cpp, Ollama, LM Studio…)</h2>
    <p>Join first (step 1), then run the proxy in front of your model's OpenAI-compatible endpoint and point your agent at the proxy. It sees every tool call on the wire — the model does nothing. Use the <b>Report as</b> path that join printed in place of <b>office</b> if it isn't on your PATH.</p>
    <div class="snip" data-t="office proxy YOUR_NAME --listen 8081 --target http://localhost:8080/v1"></div>
    <p>Then set your agent's base URL to <b>http://localhost:8081</b>.</p></div>

  <div class="card"><h2>6 · Headless / command-line agents</h2>
    <p>Wraps any command; the seat shows working while it prints output and idle when it goes quiet.</p>
    <div class="snip" data-t="office run YOUR_NAME -- your-agent-command --args"></div></div>

  <div class="card"><h2>7 · Any other agent — paste this prompt</h2>
    <p>The agent fetches its own instructions from the office (so there are no paths to edit), joins under a free name, and reports with a tiny command per step. Works anywhere an agent can run shell commands. It depends on the model following the prompt — prefer a hook or proxy above when you can.</p>
    <div class="snip" data-t="{{prompt}}"><small>prompt</small></div>
    <p>…or fetch the instructions yourself to read them:</p>
    <div class="snip" data-t="curl -s &quot;{{base}}/agent?key={{key}}&quot;"></div></div>

  <div class="card"><h2>8 · Leave</h2>
    <div class="snip" data-t="office leave --seat YOUR_NAME"><small>stands you up, stops watchers and removes the hooks it installed in this folder</small></div></div>
</main>
<script>
  var INGEST = ${Number(ingest)};
  var base = location.protocol + '//' + location.hostname + ':' + INGEST;
  var keyEl = document.getElementById('key'), nameEl = document.getElementById('name');
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var fromUrl = new URLSearchParams(location.search).get('key');
  keyEl.value = fromUrl || safeGet('officeKey') || '';
  nameEl.value = safeGet('officeName') || '';
  if (fromUrl) { safeSet('officeKey', fromUrl); history.replaceState(null, '', location.pathname); } // keep the key out of the address bar

  function fill(t) {
    var key = keyEl.value.trim() || '<KEY>';
    var name = nameEl.value.trim();
    var prompt = 'You have a seat in the workspace office. Read ' + base + '/agent?key=' + key + ' (fetch it with curl) and follow it. If anything about the office errors, ignore it and keep working.';
    return t.replace(/{{prompt}}/g, prompt).replace(/{{base}}/g, base).replace(/{{key}}/g, key)
            .replace(/{{name}}/g, name ? name + ' ' : '').replace(/YOUR_NAME/g, name || 'YOUR_NAME');
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
  render();
</script></body></html>`;
}
