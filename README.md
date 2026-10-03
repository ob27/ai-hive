# workspace-office

A shared office on the big screen where every agent on the team — Claude Code, Qwen, anything — takes a seat.
Built on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT). Design notes: [PLAN.md](PLAN.md).

Requires Node 20+ (Node 22+ on the machine that hosts the office). No `npm install` needed.

## Host the office (one machine, once)

```
node bin/office.mjs host
```

It prints the big-screen URL (open it on the TV) and the lines to share, using the machine's stable `.local`
name so seats keep working when its IP changes:

```
Big screen:  http://Thomass-MacBook-Pro.local:3100/
Join:        curl -s http://Thomass-MacBook-Pro.local:3101/join | node - join --key 1f89e0d6…
For agents:  "Read http://…:3101/agent?key=… and follow it"
```

Anyone on the network can *watch*; the key controls who can *take a seat*. Only agents that `join` appear —
local Claude Code sessions are not auto-detected (the office runs in its own private Pixel Agents home).
Keep it on a LAN/VPN. `--rotate-key` issues a new key. Ports: `--port` (screen, 3100), `--ingest` (agents, 3101).

## Take a seat (any machine with Node 20+ — nothing to clone or install)

```
curl -s http://<host>:3101/join | node - join --key <key>
```

This downloads the CLI from the host, installs an `office` launcher, and seats you. The name is optional: by
default it is derived from your user, machine and project folder (e.g. "Grace"); if that name is already taken
in the room you get a different free one. Add a name (`… join Grace --key …`) to choose your own.

**Claude Code:** add `--claude`. Hooks report every tool use *and* "responding to <you>" at the start of each
turn — the model has to do nothing. (Restart the Claude session so the hooks load. The hook file is kept out of
git via `.git/info/exclude`; `office leave` removes it.)

**Any other agent:** tell it *"Read http://<host>:3101/agent?key=<key> and follow it"* (it fetches with curl).
Or pick a mode:

| Agent | Do this |
|---|---|
| Local model (Qwen, llama.cpp, Ollama…) | `office proxy <name> --listen 8081 --target http://localhost:8080/v1`, then point the agent at `:8081` |
| Headless CLI agent | `office run <name> -- <command>` |
| Anything else | it runs `office say "<what it's doing>"` per step, `office idle` when done (see agent.md) |

`office leave --seat <name>` stands you up.

## For agents

Agents: read [agent.md](agent.md) — it tells you when to chirp (`office respond tom` at the start of a turn, `office say` per step, `office idle` at the end) so your character shows what you are doing.
