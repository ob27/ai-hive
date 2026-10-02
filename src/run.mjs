import { spawn } from 'node:child_process';
import { chirp, idle } from './chirp.mjs';
import { send } from './transport.mjs';
import { sessionEnd } from './protocol.mjs';

const THROTTLE_MS = 4000;
const IDLE_AFTER_MS = 8000;

// Wrapper mode: zero cooperation from the agent. Output on stdout/stderr == working, silence == idle.
// Trade-off: piping stdio loses the child's TTY, so this suits headless/line-oriented agents better
// than full-screen TUIs (use chirp or hooks for those).
export function runWrapped(seat, [cmd, ...args]) {
  const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, OFFICE_SEAT: seat.name } });
  let last = 0;
  let idleTimer;

  const onData = (stream) => (buf) => {
    stream.write(buf);
    const now = Date.now();
    if (now - last > THROTTLE_MS) {
      last = now;
      const line = buf.toString().trim().split('\n').pop().slice(0, 60);
      chirp(seat, line || 'working', { tool: 'Bash' });
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { last = 0; idle(seat); }, IDLE_AFTER_MS);
  };
  child.stdout.on('data', onData(process.stdout));
  child.stderr.on('data', onData(process.stderr));

  return new Promise((resolve) => child.on('exit', async (code) => {
    clearTimeout(idleTimer);
    await send(seat, sessionEnd(seat));
    resolve(code ?? 0);
  }));
}
