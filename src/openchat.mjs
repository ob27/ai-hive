// `hive join --claude --open`: after the hooks are installed, open THIS folder in VS Code and start a clean Claude conversation in it,
// so the session that loads the new hooks is the one in the right folder (no "which folder was I in?", no stale chat).
// It uses the Claude Code extension's own `vscode://anthropic.claude-code/open` link (no `session` parameter = a new conversation).
import { spawn } from 'node:child_process';

export const CLAUDE_OPEN_URI = 'vscode://anthropic.claude-code/open';

/** The commands that do it on this platform: [command, args] pairs, run in order with `settleMs` between them. */
export function openChatPlan(folder, platform = process.platform) {
  const opener = platform === 'darwin' ? ['open', [CLAUDE_OPEN_URI]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', CLAUDE_OPEN_URI]]
      : ['xdg-open', [CLAUDE_OPEN_URI]];
  // `code <folder>` focuses the window that already has the folder open (or opens one), so the link below lands in that window.
  return { steps: [[platform === 'win32' ? 'code.cmd' : 'code', [folder]], opener], settleMs: 2500 };
}

const run = ([cmd, args]) => new Promise((done) => {
  const child = spawn(cmd, args, { stdio: 'ignore' }); // stays referenced until it exits, or the CLI would quit while still waiting on it
  child.on('error', () => done(false));
  child.on('exit', (code) => done(code === 0));
});

/** -> { ok, reason? }. Never throws: opening the chat is a convenience, the seat and hooks are already in place. */
export async function openClaudeChat(folder, { platform, runStep = run, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { steps, settleMs } = openChatPlan(folder, platform);
  if (!(await runStep(steps[0]))) return { ok: false, reason: 'could not run the `code` command (in VS Code: Command Palette, "Shell Command: Install \'code\' command in PATH")' };
  await wait(settleMs);
  if (!(await runStep(steps[1]))) return { ok: false, reason: 'could not open the vscode:// link' };
  return { ok: true };
}
