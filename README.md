# workspace-office

A shared office on the big screen where every agent on the team — Claude Code, Qwen, anything — takes a seat.
Built on [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT). Design notes: [PLAN.md](PLAN.md).

Requires Node 20+ (Node 22+ on the machine that hosts the office). No `npm install` needed.

## Host the office (one machine, once)

```
node bin/office.mjs host
```

It prints the big-screen URL (open it on the TV) and the join line to share:

```
Big screen:  http://192.168.0.30:3100/
Join with:   office join 192.168.0.30:3101 <name> --key 1f89e0d6…
```

Anyone on the network can *watch*; the key controls who can *take a seat*. Keep it on a LAN/VPN.
`--rotate-key` issues a new key. Ports: `--port` (screen, 3100), `--ingest` (agents, 3101).

## Take a seat (any machine)

```
node bin/office.mjs join 192.168.0.30:3101 alice --key <key>
```

Then pick how your agent reports activity:

| Agent | Do this | Agent cooperation |
|---|---|---|
| Claude Code | add `--claude` to `join` (installs project-local hooks; `office leave` removes them) | none |
| Local model (Qwen, llama.cpp, Ollama…) | `office proxy alice --listen 8081 --target http://localhost:8080/v1`, then point the agent at `:8081` | change base URL |
| Headless CLI agent | `office run alice -- <command>` | none |
| Anything else | tell it: *run `office say "<what you're doing>"` before each step*; `office idle` when done | one prompt line |

`office leave` stands you up. `export OFFICE_SEAT=alice` if you have several seats on one machine.
