# agent.md — how to behave in the workspace office

You are sharing a live "office" with people and other agents. A big screen shows a pixel character for
each seated agent, with a one-line status. The `office` CLI is how you keep that status truthful. This
file is for you, the agent. Follow it whenever `office` is available (`OFFICE_SEAT` is set, or you were
told you have a seat).

## The loop

1. **Start of every turn** — say who you're answering:
   `office respond <person>` → the screen shows "Running: responding to <person>".
   Use the name the person gave you; if you don't know it, use `office respond`.
2. **Before each step** — one short chirp saying what you're about to do:
   `office say "reading the config"`, `office say "running the tests"`, `office say "editing auth.ts"`.
3. **End of every turn** — `office idle`, so your character sits back down instead of looking busy forever.

## Rules for chirps

- **Present tense, lowercase, 2–5 words.** The screen cuts text at ~30 characters.
- **Start with a verb the screen understands** and it animates accordingly:
  read/open/check → reading · search/grep/find → searching · edit/write/fix/implement → typing ·
  run/build/test/install → running. Anything else shows as "Running: <your text>".
- **Say what, not why.** "reading auth.ts" — not "trying to understand why login fails".
- **No secrets, paths with usernames, tokens, or private content.** Everyone in the building can read it.
- **One chirp per real step**, not per thought. Don't spam; a chirp replaces the previous one.
- **Never block on it.** `office` fails silently if the server is down. If a chirp errors, carry on with
  the real work — the office is a courtesy, not a dependency.

## When you're waiting

If you need the person to answer or approve something, `office say "waiting for tom"` before you ask.

## If you were seated by hooks or a proxy

If the person ran `office join … --claude`, hooks already report your tool use — **don't** chirp each tool
call (it doubles up). You only need `office respond` at the start of a turn and `office idle` at the end
if you want those moments visible. If you're behind `office proxy`, tool calls are reported for you too.
Chirps are for agents with neither.

## Commands

```
office respond [who]      "responding to <who>" — start of turn
office say "<text>"       what you're doing now      (--tool Read|Edit|Bash|Grep|WebFetch to force an animation)
office idle               turn finished
office leave              stand up (end of session)
```

## One line for your system prompt

> You have a seat in the workspace office. At the start of each turn run `office respond <user's name>`;
> before each step run `office say "<what you're doing, 2–5 words>"`; at the end of the turn run
> `office idle`. If `office` errors, ignore it and keep working. See agent.md.
