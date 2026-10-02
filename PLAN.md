# workspace-office

Agents take a seat in a shared [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) office
from any machine, with one command. Supersedes the "Copilot bridge + forked hook" plan in
`pixel-agents-copilot-bridge-plan.md` (kept on the Projects share): one CLI replaces both the forked
`claude-hook.js` and the Copilot VS Code extension.

```
 agent machine                                   office server (always on)
 ┌──────────────────────────┐   POST /api/hooks/claude   ┌──────────────────────────┐
 │ office say / run / proxy │ ─────────────────────────▶ │ npx pixel-agents         │ ─▶ big screen
 │ office hook (Claude)     │   Bearer <token>           │   --host 0.0.0.0 --port  │    (browser)
 └──────────────────────────┘                            └──────────────────────────┘
```

## Decisions
- Keep Pixel Agents as server + display (MIT; bundled art is internal-use only — see old plan §3).
- Own repo, plain Node ≥ 20, no dependencies. Distributed as a single folder on SharePoint.
- **Chirp is the base protocol.** Every adapter reduces to four hook-shaped events
  (`SessionStart`, `PreToolUse`, `PostToolUse`/`Stop`, `SessionEnd`) — see `src/protocol.mjs`.
- Rebar UI is not used: the office is a sprite canvas, not forms/docs.

## Two roles, one repo
- **Host** (one machine): `node bin/office.mjs host` — runs Pixel Agents on `:3100` (big screen, open to
  browsers on the LAN) plus an ingest shim on `:3101` that only accepts `POST /api/hooks/*` with the shared
  key, forwarding with Pixel Agents' own per-boot token (which never leaves the host). The key is generated
  once in `~/.workspace-office/host.json` (`--rotate-key` to change). Also flips on Watch All Sessions.
  Prints the exact `office join …` line to share (e.g. on SharePoint). Needs Node ≥ 22 (global WebSocket).
- **Seat** (any machine): `node bin/office.mjs join <host:3101> <name> --key <key>` — zero dependencies.

## Three ways to report activity (cheapest cooperation first)
| Mode | Command | Needs the agent to… | Best for |
|---|---|---|---|
| Hooks | `office join … --claude` | nothing | Claude Code |
| Proxy | `office proxy <name> --listen 8081 --target <openai-compatible url>` | change its base URL | Qwen / local models |
| Wrapper | `office run <name> -- <cmd>` | nothing (loses TTY) | headless/line-oriented agents |
| Chirp | `office say "…"` | be told to (one line in its prompt) | anything else; the universal floor |

## Verified against pixel-agents@1.4.1 (spike, 2026-10-02)
- `POST /api/hooks/claude` + `Authorization: Bearer <token>` accepts synthetic payloads from any host.
- A session with **no `transcript_path`** becomes a "hooks-only external session" — no local files needed.
  `cwd` basename becomes the character's label, so a seat sets `cwd=/office/<name>`.
- `tool_name` + `tool_input` drive the animation and status text ("Reading b.ts", "Running: …").
- End-to-end tested: chirp, wrapper and proxy each created a character and updated live.

## Open items (found in the spike)
1. ~~Watch All Sessions~~ and ~~stable token~~ — solved by `office host` (see above); verified: wrong key → 401,
   right key → seat appears.
3. **By design:** anyone who can reach the host can watch the office; the key only gates who can seat an agent.
   The key is one shared secret with no per-person revocation (rotate and redistribute). Keep the host on a
   LAN/VPN — the ingest port accepts anything holding the key.
4. `office join --claude`: hook install, forwarding, label and `leave` cleanup verified with real-shaped payloads; a live Claude Code session was not run.
5. Chirp-only seats look idle if the model skips the reminder; proxy/wrapper don't have that problem.
6. Copilot Chat: covered by chirp/wrapper for now; the JSONL watcher from the old plan is a later adapter.
7. Proxy only sees `/chat/completions`-style traffic; streaming tool-call parsing is implemented but only
   tested with a non-streaming response.
