// Builds Claude-hook-shaped payloads, the wire format the host's ingest takes (POST /api/hooks/claude).
// Everything in this CLI — chirps, the wrapper, the proxy, real agent hooks — reduces to these events.

// Free-text chirps get mapped to a familiar tool name, so the wall can show what kind of step it is.
const VERBS = [
  [/\b(read|open|view|look|inspect|check)/i, 'Read'],
  [/\b(search|grep|find|scan|list)/i, 'Grep'],
  [/\b(edit|write|patch|fix|refactor|implement|update|create)/i, 'Edit'],
  [/\b(run|exec|build|test|install|compile|deploy)/i, 'Bash'],
  [/\b(browse|fetch|web|download|http)/i, 'WebFetch'],
];

export function toolForText(text) {
  for (const [re, tool] of VERBS) if (re.test(text)) return tool;
  // Bash is the neutral default: its activity line is just the text the agent gave.
  return 'Bash';
}

const base = (seat, event) => ({ session_id: seat.sessionId, hook_event_name: event, cwd: seat.cwd });

export const sessionStart = (seat) => ({ ...base(seat, 'SessionStart'), source: 'startup' });
export const sessionEnd = (seat) => ({ ...base(seat, 'SessionEnd'), reason: 'other' });
export const stop = (seat) => base(seat, 'Stop');
export const postToolUse = (seat) => ({ ...base(seat, 'PostToolUse'), tool_name: 'x' });

export function preToolUse(seat, { tool, text, input }) {
  const toolName = tool ?? toolForText(text ?? '');
  const tool_input = input ?? (toolName === 'Bash' ? { command: text ?? '' } : { file_path: text ?? '' });
  return { ...base(seat, 'PreToolUse'), tool_name: toolName, tool_input };
}
