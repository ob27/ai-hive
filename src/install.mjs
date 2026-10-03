import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = join(homedir(), '.workspace-office');
export const cliDir = join(home, 'cli');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const shimDir = isWin ? join(home, 'bin') : join(homedir(), '.local', 'bin');
export const shimPath = join(shimDir, isWin ? 'office.cmd' : 'office');

/** Copies this CLI under ~/.workspace-office/cli (unless it already runs from there) and writes an
 *  `office` launcher, so agents can type `office say "…"` instead of a long node command. */
export function installCli() {
  if (root !== cliDir) {
    mkdirSync(cliDir, { recursive: true });
    for (const d of ['bin', 'src']) cpSync(join(root, d), join(cliDir, d), { recursive: true });
  }
  const entry = join(cliDir, 'bin', 'office.mjs');
  mkdirSync(shimDir, { recursive: true });
  if (isWin) writeFileSync(shimPath, `@node "${entry}" %*\r\n`);
  else { writeFileSync(shimPath, `#!/bin/sh\nexec node "${entry}" "$@"\n`); chmodSync(shimPath, 0o755); }
  const onPath = (process.env.PATH ?? '').split(isWin ? ';' : ':').includes(shimDir);
  return { shim: shimPath, dir: shimDir, onPath };
}

/** How an agent should invoke the CLI: the shim by absolute path when installed (works even if its
 *  directory is not on PATH), otherwise node + this entry point. */
export function reportCommand(entryPath) {
  return existsSync(shimPath) ? `"${shimPath}"` : `node "${entryPath}"`;
}
