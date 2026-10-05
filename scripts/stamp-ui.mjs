// The built screen (hive-ui/dist) is committed, so a machine that only runs the host needs no Node toolchain for the UI. The risk of committing a build is
// forgetting to rebuild it after changing the source. So every build records a fingerprint of what it was built from (hive-ui/dist/.src-hash), and a test
// (test/ui-built.test.mjs) fails when the fingerprint no longer matches the source.
//
//   node scripts/stamp-ui.mjs        writes hive-ui/dist/.src-hash   (run by `pnpm build` in hive-ui)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'hive-ui');
const TEXT = /\.(tsx?|css|html|json|svg|mjs|js)$/;

function files(dir, out = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out); else out.push(p);
  }
  return out;
}

/** A fingerprint of everything the screen is built from: its source, page, public files, build config and the host-side modules it imports. */
export function uiSourceHash() {
  const h = createHash('sha1');
  const inputs = [join(ui, 'index.html'), join(ui, 'vite.config.ts'), join(ui, 'tsconfig.json'), join(ui, 'package.json'), ...files(join(ui, 'src')), ...files(join(ui, 'public')),
    join(root, 'src', 'hooking-in.mjs')]; // JoinPage imports the tool matrix from here
  for (const f of inputs) {
    let data = readFileSync(f);
    if (TEXT.test(f)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n')); // a Windows checkout may have CRLF: same source, same hash
    h.update(relative(root, f).split('\\').join('/')).update('\0').update(data).update('\0');
  }
  return h.digest('hex');
}

export const stampFile = () => join(ui, 'dist', '.src-hash');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(stampFile(), `${uiSourceHash()}\n`);
  console.log(`stamped hive-ui/dist with ${uiSourceHash().slice(0, 12)}`);
}
