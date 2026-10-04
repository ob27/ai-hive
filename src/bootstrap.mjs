import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file a seat machine needs (the CLI has no dependencies), as {path: contents}. */
export function cliFiles() {
  const files = { 'bin/office.mjs': readFileSync(join(root, 'bin', 'office.mjs'), 'utf8') };
  for (const f of readdirSync(join(root, 'src'))) if (f.endsWith('.mjs')) files[`src/${f}`] = readFileSync(join(root, 'src', f), 'utf8');
  return files;
}

/** Served at /join and run as `curl -s <host>/join | node - join --key K`. Downloads the current CLI from
 *  the host (so seats are always the same version as the office), installs the `office` launcher, then
 *  runs the command, defaulting `join`'s address to this host. Plain CommonJS: `node -` reads stdin as CJS. */
export function bootstrapScript(base) {
  return `(async () => {
  const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
  const base = ${JSON.stringify(base)};
  const dir = path.join(os.homedir(), '.workspace-office', 'cli');
  let bundle;
  try {
    const res = await fetch(base + '/cli.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bundle = await res.json();
  } catch (e) { console.error('hive: could not download the CLI from ' + base + ' (' + e.message + ')'); process.exit(1); }
  for (const [file, text] of Object.entries(bundle)) {
    const p = path.join(dir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const entry = path.join(dir, 'bin', 'office.mjs');
  let args = process.argv.slice(2);
  // \`join\` normally needs an address; here it is this host unless the user typed one (host:port / dotted).
  if (args[0] === 'join' && !(args[1] && !args[1].startsWith('--') && /[.:]/.test(args[1]))) {
    args = ['join', base.replace(/^https?:\\/\\//, ''), ...args.slice(1)];
  }
  cp.spawnSync(process.execPath, [entry, 'install'], { stdio: 'inherit' });
  process.exit(cp.spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' }).status ?? 1);
})();
`;
}
