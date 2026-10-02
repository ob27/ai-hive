import { postToolUse, preToolUse, stop } from './protocol.mjs';
import { send } from './transport.mjs';

// Each chirp closes the previous tool and opens a new one, so a bare `office say` per step is
// enough — the agent never has to remember to send an "end" event.
export async function chirp(seat, text, { tool, input } = {}) {
  await send(seat, postToolUse(seat));
  return send(seat, preToolUse(seat, { tool, text, input }), { quiet: false });
}

export async function idle(seat) {
  await send(seat, postToolUse(seat));
  return send(seat, stop(seat));
}
