import { postToolUse, preToolUse, sessionEnd, stop } from './protocol.mjs';
import { send } from './transport.mjs';

// Each chirp closes the previous tool and opens a new one, so a bare `office say` per step is
// enough — the agent never has to remember to send an "end" event.
export async function chirp(seat, text, { tool, input, joining } = {}) {
  await send(seat, postToolUse(seat), { joining });
  return send(seat, preToolUse(seat, { tool, text, input }), { quiet: false, joining });
}

export async function idle(seat, { joining } = {}) {
  await send(seat, postToolUse(seat), { joining });
  return send(seat, stop(seat), { joining }); // `joining`: sitting down is not a turn, so it does not count as production
}

/** Applies one normalized action (see normalize.mjs / copilot.mjs) to a seat. */
export async function applyAction(seat, action, user = 'you') {
  switch (action.type) {
    case 'pre': return chirp(seat, action.text, { tool: action.tool, input: action.input });
    case 'post': return send(seat, postToolUse(seat));
    case 'prompt': return chirp(seat, `responding to ${user}`, { tool: 'Bash' });
    case 'stop': return idle(seat);
    case 'end': return send(seat, sessionEnd(seat));
    default: return true; // 'start': joining already seated us; a character appears on the first tool event
  }
}
