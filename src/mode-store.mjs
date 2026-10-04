import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Demo/Work is chosen on the Config page, but it only lived in memory, so every host restart snapped back to the
// start-up default (demo, for the demo script). Remember the last choice on disk; an explicit flag still wins.
export function loadMode(file) {
  try {
    const mode = JSON.parse(readFileSync(file, 'utf8')).mode;
    return mode === 'demo' || mode === 'work' ? mode : null;
  } catch { return null; }
}

export function saveMode(file, mode) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mode }));
  } catch { /* remembering is a convenience, never a reason to fail */ }
}
