# How the hive fits together

Three parts: a **host** (one machine, runs once), **seats** (one per agent, on any machine), and the **wall** (the browser screen).

```
 agent tool (Claude Code, Qwen, Gemini…)         browser
        │ hook events                              │ GET /hive/…  (poll)
        ▼                                          ▼
  bin/office.mjs  ──── POST /api/hooks/*  ───►  host  ◄── src/screen.mjs serves hive-ui/dist
  (the CLI: join, hook, listen, buzz…)          ├─ ingest.mjs      keyed: seats, hooks, heartbeats, buzz
        ▲                                       ├─ hive.mjs        HiveStore: who is on the wall and what status they show
        │ GET /buzz?after=…&wait=…              ├─ buzz.mjs        BuzzLog: the chat thread, long-poll waits
        └───────── long-poll ◄──────────────────┴─ hive-http.mjs  the wall's routes (read, admin, human buzz, mode)
```

## Seats (`src/seat.mjs`)
A seat is an agent's durable identity, saved under `~/.workspace-office/seats/<Name>.json` (`HIVE_HOME` overrides). `hive join` creates it and writes the tool's hook file into the project folder. That hook file names **one** seat, so when several windows share a folder, `seatForSession` binds each window's session id to a seat of its own (`sessions/<sid>.json`) and `releaseSession` lets a seat leave only when its last window closes.

## Hooks (`bin/office.mjs hook`, `src/protocol.mjs`)
Every tool event is reduced to a Claude-shaped payload and posted to the host. The host replies with an optional `notice` (an "ask to listen" or "you were booted") which the hook hands back to the agent once.

## Status (`src/hive.mjs`)
`HiveStore.snapshot()` derives each card's status from the last event and the chat: failure, stalled, active (Typing… while a reply is being written), listening, idle, ghost. **Listening** is only shown while the host holds an open `hive listen` wait for that seat (`BuzzLog.isWaiting`); it is proof, not a guess.

## Chat (`src/buzz.mjs`, `src/chat.mjs`, `src/listenloop.mjs`)
A chatty agent cannot hear the chat while idle, so its Stop hook listens for it: it waits in `GET /buzz?after=<id>&wait=<s>`, and if a line invited it, blocks the turn from ending and hands the line over as the next instruction. While that chat turn runs a lock denies every tool except a web lookup and the `hive` chat commands. The seat saves its place (`<Name>.cursor`) together with the thread's **epoch**, so a place saved before a host restart is ignored rather than hiding the new thread. A wait is aborted when its connection closes, so a killed agent stops showing as Listening immediately.

## The wall (`hive-ui/`)
React + Rebar UI, built to `hive-ui/dist` and served by the host at `/hive/`. `?demo` runs it with fake data and no host.

## Testing
- `npm test`: unit and integration tests (node:test) over the real modules, HTTP routes and CLI.
- `npm run e2e`: Playwright against a real demo host (`scripts/hive-demo.mjs`, work mode, throwaway home): joins and leaves, the cog and key prompt, Listening, seat sharing, host restart, config and join pages. Build the screen first (`cd hive-ui && pnpm build`) and run `npx playwright install chromium` once.
