import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANDROGYNOUS_NAMES, nameKind, pickAvatar } from '../src/avatars.mjs';
import { defaultName, NAMES as NAMES_POOL } from '../src/names.mjs';

// Rebar's table, read from its source so this checks the real thing when the sibling checkout is there (else a stand-in of the same shape).
const KINDS = (() => {
  try {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'rebarui', 'packages', 'core', 'src', 'assets', 'avatarPlaceholderKinds.ts'), 'utf8');
    const map = { M: 'male', F: 'female', C: 'creature' };
    return [...src.slice(src.indexOf('= [')).matchAll(/\b([MFC])\b/g)].map((m) => map[m[1]]);
  } catch {
    return Array.from({ length: 96 }, (_, i) => (i % 9 === 0 ? 'creature' : i % 3 === 0 ? 'female' : 'male'));
  }
})();

const NAMES = {
  male: ['Tom', 'Barry', 'Donald', 'Linus', 'Rhys', 'Alan', 'Bram', 'Ivan'],
  female: ['Alice', 'Grace', 'Ada', 'Clio', 'Tess', 'Hedy', 'Ruth', 'Wendy'],
  androgynous: ['Quill', 'Leslie', 'Jean', 'Dana', 'Claude', 'Sam', 'Zzyzx'],
};

test('a male name only gets a male portrait, a female name only a female one', () => {
  for (const n of NAMES.male) assert.equal(KINDS[pickAvatar(n, KINDS)], 'male', n);
  for (const n of NAMES.female) assert.equal(KINDS[pickAvatar(n, KINDS)], 'female', n);
});

test('names are told apart as the pairing needs, and an unknown name counts as androgynous', () => {
  for (const [kind, names] of Object.entries(NAMES)) for (const n of names) assert.equal(nameKind(n), kind, n);
  assert.equal(nameKind('Ada42'), 'female', 'a trailing number (a name that was already taken) is ignored');
  assert.equal(nameKind('grace hopper'), 'female');
});

test('creatures are only ever given to androgynous names, and an androgynous name can be any portrait', () => {
  const everyone = [...NAMES.male, ...NAMES.female, ...NAMES.androgynous, ...ANDROGYNOUS_NAMES];
  for (const n of everyone) if (KINDS[pickAvatar(n, KINDS)] === 'creature') assert.equal(nameKind(n), 'androgynous', n);
  const seen = new Set(ANDROGYNOUS_NAMES.concat(NAMES.androgynous).map((n) => KINDS[pickAvatar(n, KINDS)]));
  assert.ok(seen.has('male') && seen.has('female'), 'an androgynous name may wear a male or a female portrait');
  const lots = Array.from({ length: 300 }, (_, i) => KINDS[pickAvatar(`Unknown${i}x`, KINDS)]);
  assert.ok(lots.includes('creature') && lots.includes('male') && lots.includes('female'));
});

test('the same name always gets the same portrait', () => {
  for (const n of ['Tom', 'Alice', 'Quill']) assert.equal(pickAvatar(n, KINDS), pickAvatar(n, KINDS));
  assert.equal(pickAvatar(' tom ', KINDS), pickAvatar('Tom', KINDS), 'case and spaces do not matter');
});

test('when every classic name is taken the host hands out an androgynous one, so creatures have names to wear', () => {
  const got = defaultName('/some/folder', new Set(NAMES_POOL));
  assert.ok(ANDROGYNOUS_NAMES.includes(got), got);
  assert.ok(ANDROGYNOUS_NAMES.every((n) => nameKind(n) === 'androgynous'));
});
