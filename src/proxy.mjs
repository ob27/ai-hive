import http from 'node:http';
import { chirp, idle } from './chirp.mjs';

// Proxy mode: sits between a locally hosted agent and its OpenAI-compatible endpoint
// (llama.cpp, vLLM, Ollama /v1, LM Studio…) and chirps on the model's behalf from what it
// sees on the wire — zero cooperation from the agent or the model.
//   request in flight                → "thinking"
//   response carries tool_calls      → one chirp per tool call, with its real name + arguments
//   response ends with no tool_calls → idle
export function startProxy(seat, { listen, target }) {
  const upstream = new URL(target);
  const server = http.createServer((req, res) => {
    chirp(seat, 'thinking', { tool: 'Read', input: { file_path: 'thinking…' } });
    const out = http.request(
      { host: upstream.hostname, port: upstream.port || 80, path: upstream.pathname.replace(/\/$/, '') + req.url, method: req.method, headers: { ...req.headers, host: upstream.host } },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        let body = '';
        up.on('data', (c) => { body += c; res.write(c); });
        up.on('end', () => { res.end(); announce(seat, body); });
      },
    );
    out.on('error', (e) => { res.writeHead(502).end(String(e)); });
    req.pipe(out);
  });
  server.listen(listen);
  return server;
}

// Handles both a plain JSON completion and an SSE stream (`data: {...}` lines with delta.tool_calls).
export function toolCallsFrom(body) {
  const calls = new Map();
  const take = (tc, i) => {
    const prev = calls.get(i) ?? { name: '', args: '' };
    calls.set(i, { name: tc.function?.name || prev.name, args: prev.args + (tc.function?.arguments ?? '') });
  };
  const chunks = body.trimStart().startsWith('data:')
    ? body.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => l.slice(5))
    : [body];
  for (const raw of chunks) {
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    for (const choice of json.choices ?? []) {
      const tcs = choice.message?.tool_calls ?? choice.delta?.tool_calls ?? [];
      tcs.forEach((tc, n) => take(tc, tc.index ?? n));
    }
  }
  return [...calls.values()].filter((c) => c.name);
}

async function announce(seat, body) {
  const calls = toolCallsFrom(body);
  if (!calls.length) return idle(seat);
  for (const { name, args } of calls) {
    let input;
    try { input = JSON.parse(args); } catch { input = { command: args }; }
    await chirp(seat, name, { tool: name, input });
  }
}
