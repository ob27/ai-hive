// Pairing a portrait with a name. Rebar's illustrated avatars are each marked male, female or creature (AVATAR_PLACEHOLDER_KINDS in
// rebar-ui). A male name only ever wears a male portrait and a female name a female one; an androgynous name may wear any portrait, and
// it is the only kind of name a creature is given. A name we do not know counts as androgynous (a bot called "Quill" can be a cat).
// The same name always gets the same portrait.

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

const MALE = set(`
  Alan Linus Dennis Ken Tim Guido Bjarne Brian Edsger Donald Niklaus Shafi Vint Fernando Seymour Rob Yukihiro Marvin Whitfield Butler
  Judea Leonard Maurice Ivan Peter Jon Bram Anders Larry Raj Cleve Erik Tony Lotfi Amir Barry Dev Finn Gus Ivo Milo Otto Rhys Alex
  Adam Andrew Anthony Arthur Ben Benjamin Bill Bob Bruce Carl Chris Christopher Colin Daniel David Dan Derek Dominic Dylan Edward Ed
  Elliot Eric Ethan Felix Francis Frank Fred Gabriel Gary George Graham Greg Harold Harry Henry Hugh Isaac Jack Jacob James Jason
  Jeff Jeremy Jim John Joe Joel Jonathan Joseph Josh Julian Justin Keith Kevin Kyle Lars Lee Liam Louis Luke Marc Mark Martin Matt
  Matthew Max Michael Mike Nathan Neil Nick Noah Oliver Oscar Owen Patrick Paul Phil Philip Ralph Ray Richard Rick Robert Roger Ron
  Ryan Samuel Scott Sean Simon Stephen Steve Steven Thomas Tom Tommy Victor Vincent Walter Will William Zach
`);

const FEMALE = set(`
  Ada Grace Margaret Barbara Hedy Radia Frances Katherine Sophie Anita Carol Joan Evelyn Mary Lynn Ruth Cynthia Manuela Susan Kristen
  Sandra Ellen Gladys Wendy Nancy Alice Cora Esme Hana June Lena Nora Pia Sana Tess Uma Clio Abigail Amanda Amy Andrea Angela Anna
  Annie Beth Betty Brenda Carla Caroline Catherine Charlotte Chloe Christine Claire Clara Daisy Deborah Diana Donna Dorothy Eleanor
  Elizabeth Emily Emma Eva Fiona Gemma Hannah Heather Helen Holly Isabel Isla Jane Janet Jennifer Jenny Jessica Julia Julie Karen
  Kate Kelly Laura Lauren Lily Linda Lisa Louise Lucy Maria Martha Megan Melissa Michelle Molly Natalie Nicole Olivia Pamela Patricia
  Penny Rachel Rebecca Rose Sally Sarah Sharon Sheila Sophia Stephanie Tina Valerie Victoria Violet Zoe
`);

const ANDROGYNOUS = set(`
  Leslie Claude Jean Dana Kit Quin Quill Vic Sam Jordan Robin Quinn Casey Morgan Riley Avery Charlie Jamie Taylor Jesse Jess Pat
  Sasha Skyler Rowan Sage River Reese Parker Peyton Logan Hayden Harper Emerson Drew Devon Dakota Cameron Blake Ash Ariel Alexis
`);

const clean = (name) => String(name ?? '').trim().split(/[\s_.-]+/)[0].replace(/\d+$/, '').toLowerCase();
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** 'male' | 'female' | 'androgynous' for a name (first word, ignoring a trailing number like Ada42). Unknown names are androgynous. */
export function nameKind(name) {
  const first = cap(clean(name));
  if (ANDROGYNOUS.has(first)) return 'androgynous';
  if (MALE.has(first)) return 'male';
  if (FEMALE.has(first)) return 'female';
  return 'androgynous';
}

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The index of the portrait for `name`. `kinds` is rebar-ui's AVATAR_PLACEHOLDER_KINDS (one 'male' | 'female' | 'creature' per portrait).
 * Male name: a male portrait. Female name: a female one. Androgynous name: any portrait, including the creatures.
 */
export function pickAvatar(name, kinds) {
  const kind = nameKind(name);
  const pool = [];
  kinds.forEach((k, i) => { if (kind === 'androgynous' || k === kind) pool.push(i); });
  return pool.length ? pool[hash(String(name).trim().toLowerCase()) % pool.length] : hash(String(name)) % kinds.length;
}

/** Names with no gender, for the host to hand out when it needs a free one (see names.mjs): these are the names a creature portrait can have. */
export const ANDROGYNOUS_NAMES = ['Sam', 'Jordan', 'Robin', 'Quinn', 'Casey', 'Morgan', 'Riley', 'Avery', 'Charlie', 'Jamie', 'Taylor', 'Sasha', 'Rowan', 'Sage', 'River', 'Reese', 'Parker', 'Logan', 'Drew', 'Dakota', 'Blake'];
