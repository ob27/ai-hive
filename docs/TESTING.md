# Testing

- `npm test`: unit and integration tests (node:test) over the real modules, HTTP routes and CLI.
- `npm run e2e`: the Playwright **agent-interaction harness**. Build the screen first (`cd hive-ui && pnpm build`) and run `npx playwright install chromium` once.

## The harness (`e2e/harness/`)

Each Playwright worker starts its own real hive (`scripts/hive-demo.mjs`: the real routes, store, ingest and screen) on free ports, with a throwaway home, so spec files run in parallel and **nothing touches your real hive, seats or any project's hook files**. Every fake agent runs in its own temp project folder, because `hive join` writes the tool's hook file into the current folder.

| File | Purpose |
|---|---|
| `harness/hive.mjs` | `startHive()` (start / restart / kill / stop, `state()`, `member()`, `say()`), `runCli()`, `spawnCli()`, `until()` |
| `harness/agents.mjs` | One fake agent per way in, each speaking that tool's **real wire format through the real CLI**: `ClaudeAgent` (+ sub-agents, chat Stop, listen), `CodexAgent`, `QwenAgent`, `GeminiAgent`, `CursorAgent`, `CopilotAgent` (writes the VS Code chat log the watcher reads), `ApiAgent` (raw HTTP), `ChirpAgent` (`hive say`), `ServiceAgent` (heartbeats) |
| `harness/fixtures.mjs` | `test` with `hive` (per worker) and `wall` (a `Wall` page object: `tile`, `expectStatus`, `expectText`, `expectGone`, `helpers`, `thread`) |
| `matrix.spec.mjs` | The same journey for **every** adapter: seat, work, idle, leave. One failure names the integration that regressed. |
| `claude.spec.mjs` | Sub-agents, windows sharing a folder, the chat loop and its tool lock, real Listening and a dying listener, host restart with a stale place, Ask to listen, boot |
| `services.spec.mjs` | Heartbeat states, metric rules, gauges, refusal of per-core lists |
| `ui.spec.mjs` | The screen: logos, chat thread, reply quotes, the cog's key prompt, config and join pages |

### Adding a new way in
Write an adapter class in `agents.mjs` with `join`, `prompt`, `work`, `idle`, `leave` and an `activity` pattern, and add it to `ADAPTERS` in `matrix.spec.mjs`. It then gets the whole journey for free. Add anything tool-specific to its own spec.

### Not covered yet
The `hive proxy` and `hive run` wrappers (unit-tested in `test/adapters.test.mjs`, not driven through the screen), time-based states (Stalled, Ghost: they need a clock the host does not expose), and real tools (the harness fakes their payloads; the real apps have to be tried by hand).
