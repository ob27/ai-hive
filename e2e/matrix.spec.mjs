// The same journey for every way an agent can hook in: take a seat, work, finish, leave. One failure here names the integration that regressed.
import { test, expect } from './harness/fixtures.mjs';
import { ApiAgent, ChirpAgent, ClaudeAgent, CodexAgent, CopilotAgent, CursorAgent, GeminiAgent, QwenAgent } from './harness/agents.mjs';

const ADAPTERS = [ClaudeAgent, CodexAgent, QwenAgent, GeminiAgent, CursorAgent, ApiAgent, ChirpAgent, CopilotAgent];

for (const Adapter of ADAPTERS) {
  const label = Adapter.name.replace(/Agent$/, '');
  test(`${label}: takes a seat, shows its work, goes idle, and leaves`, async ({ hive, wall }) => {
    const name = `M${label}`;
    const agent = new Adapter(hive, name);
    await agent.join();
    await wall.expectStatus(name, 'Idle');
    await agent.prompt?.();
    await agent.work();
    await wall.expectStatus(name, 'Active Now');
    if (agent.activity) await wall.expectText(name, agent.activity);
    await agent.idle();
    await wall.expectStatus(name, 'Idle');
    const m = await hive.member(name);
    expect(m.kind).toBe('agent');
    await agent.leave();
    await wall.expectGone(name);
  });
}

test('every tool joins with its own hook file in its own project folder, and never in anyone else\'s', async ({ hive }) => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const [Adapter, file] of [[ClaudeAgent, ['.claude', 'settings.local.json']], [QwenAgent, ['.qwen', 'settings.json']], [GeminiAgent, ['.gemini', 'settings.json']], [CursorAgent, ['.cursor', 'hooks.json']]]) {
    const a = new Adapter(hive, `H${Adapter.name}`);
    await a.join();
    const f = join(a.dir, ...file);
    expect(existsSync(f), `${f} written`).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain(`--seat H${Adapter.name}`);
    await a.leave();
    expect(readFileSync(f, 'utf8')).not.toContain('office.mjs'); // leaving takes our entries away again
  }
});

test('two agents of different tools in one hive are two cards, each with its own state', async ({ hive, wall }) => {
  const claude = await new ClaudeAgent(hive, 'Duo1').join();
  const gemini = await new GeminiAgent(hive, 'Duo2').join();
  await claude.work();
  await wall.expectStatus('Duo1', 'Active Now');
  await wall.expectStatus('Duo2', 'Idle');
  await gemini.idle();
  await claude.leave(); await gemini.leave();
});
