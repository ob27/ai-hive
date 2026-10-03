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

**Only seated agents appear.** Pixel Agents normally auto-detects every local Claude Code session (scanning
`~/.claude/projects`) and labels it with its project folder — so every chat started in one project is
"rebarui", and there is no rename API. The host therefore runs Pixel Agents under a private `HOME`
(`~/.workspace-office/pixel-home`): nothing to scan, so the only characters are agents that ran `office join`,
each with a proper name. Layout and settings persist there (separate from any normal Pixel Agents install).

## Getting agents onto the screen (ease of joining)
- **Host serves the CLI.** `GET /join` is a tiny bootstrap (`curl -s <host>:3101/join | node - join --key K`);
  it pulls `GET /cli.json` (the whole dependency-free CLI), installs it under `~/.workspace-office/cli` with an
  `office` launcher, and runs the command with this host as the default address. Seats are always the same
  version as the office; no repo clone, no paths. `GET /agent?key=K` serves the agent instructions.
- **Claude Code needs zero cooperation:** `join --claude` adds hooks incl. `UserPromptSubmit`, which the CLI turns
  into "responding to <os user>"; `Stop` → idle. Hooks run the installed copy, and the hook file is added to
  `.git/info/exclude`.
- **Stable address:** seats store the host's address. LAN IPs change (DHCP renewed `.30` → `.54` and silently
  broke every seat), so the host advertises its Bonjour `.local` name (`scutil --get LocalHostName`; plain
  `os.hostname()` was a router-assigned name). Reserving the IP in the router is still the sturdier fix.

## Adapters added after the first cut
- **`office event`** — one generic hook target. `src/normalize.mjs` maps Claude Code/Codex, Gemini CLI
  (BeforeTool/AfterTool/BeforeAgent/AfterAgent) and Cursor (before*/after*/stop) payloads to one action set
  (`pre/post/prompt/stop`). Always exits 0 and prints nothing (Cursor `before*` hooks get an allow reply),
  because in these tools exit codes / stdout are verdicts. Formats came from each tool's docs; not run in the
  real apps.
- **Copilot Chat watcher** — `src/copilot.mjs`. Chat logs are JSONL *patch logs* (kind 0 state / 1 set / 2 array
  write), up to 100 MB+, so it tails only appended bytes from "now". New turn = `kind 2 k=[requests]`; tool calls
  = items in `requests[n].response`, keyed by `toolCallId` (the array is rewritten in overlapping batches);
  turn end = `requests[n].result`. Verified by replaying a real session (7 prompts / 6 stops / sensible tool
  mix) and by an end-to-end test; never prints commands. Granularity is whatever VS Code flushes (batches), so
  a burst is coalesced to "responding…" then the latest tool.

## The screen port is a small reverse proxy
Pixel Agents' UI is a prebuilt bundle, so the **Join button** is added by fronting it: Pixel Agents runs on a
private `127.0.0.1` port and `src/screen.mjs` serves the public screen port — proxying HTTP, tunnelling the
WebSocket upgrade byte-for-byte, injecting the button into the one HTML document, and serving `/join-page`
(`src/joinpage.mjs`). The key is **pre-filled by default** (`prefillKey` in `host.json`, default true; `office host
--no-prefill-key` / `--prefill-key` persist the choice) because the office is hosted for people to join — this means
anyone who can open the page can seat an agent, i.e. the key stops being a gate. With prefill off the page never
embeds the key and takes it as input / `?key=` / localStorage. Precedence: `?key=` > host prefill > localStorage
(so a rotated key wins over a stale remembered one). Templated client-side. Verified in a browser: live agents still render
through the proxy, button appears, click opens the page, snippets fill.

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
3. **By design:** anyone who can reach the host can watch the office; the key gates who can seat an agent — unless the join page prefills it (the default), in which case anyone who can open the page can join.
   The key is one shared secret with no per-person revocation (rotate and redistribute). Keep the host on a
   LAN/VPN — the ingest port accepts anything holding the key.
4. `office join --claude`: hook install, forwarding, label and `leave` cleanup verified with real-shaped payloads; a live Claude Code session was not run.
5. **Late viewers (found by screenshot):** Pixel Agents doesn't replay a hooks-only seat's current activity to a
   viewer that connects later, so a reloaded TV showed seats "Idle". Statuses do *not* decay on their own
   (measured: still active after 40 s). Fix: the host remembers each seat's latest activity and re-sends it
   every 10 s, and ends seats silent for 30 min (ghost expiry). Verified with a late-joining viewer.
5a. **Host restarts** (found when a seat vanished): after a restart, running agents send tool events but no new
   `SessionStart`, and Pixel Agents drops events for sessions it hasn't seen start. The ingest shim now
   re-sends a synthetic `SessionStart` the first time it hears from an unknown session, so seats reappear on
   their next activity. Seat *state* (current status) is not persisted across a restart.
5b. Chirp-only seats look idle if the model skips the reminder; proxy/wrapper don't have that problem.
6. Copilot Chat: covered by chirp/wrapper for now; the JSONL watcher from the old plan is a later adapter.
7. Proxy only sees `/chat/completions`-style traffic; streaming tool-call parsing is implemented but only
   tested with a non-streaming response.
