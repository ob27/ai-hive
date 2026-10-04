// What a finished turn is worth, in hexagons of Hive production. Not every turn is equal: a one-line chat answer is a sliver of a cell, a
// turn that edited code or did real research is a whole cell, and a long one (we assume a long turn was a big piece of work) is worth several.
// A bigger model doing the same work is credited more than a small one.
//
//   worth = what the turn did  x  how long it ran  x  how big the model is
//
//   what it did   chat only, no tools .................................... 0.15
//                 a little looking around (a few reads or commands) ....... 0.35 to 0.6
//                 edited or wrote files, searched the web, or got through
//                 four or more reads/commands ........................... 1.0
//   how long      up to 2 min: x1; then it grows to x5 at 30 min (capped)
//   model size    small (Haiku, Flash, mini, 7-14B) x0.6; standard x1; large (Opus, Fable, Ultra, GPT-5, Pro, 70B+) x1.5
//
// So a quick Haiku edit is 0.6, the same turn on Opus is 1.5, and a half-hour Fable turn that wrote code is 7.5. The numbers are in one place
// so they are easy to tune.

export const SCORE = {
  chatOnly: 0.15,
  light: 0.35, lightMax: 0.6,
  full: 1.0,
  fullReads: 4,                 // reads + commands that make a turn "real work" without an edit or a search
  freeMinutes: 2, longMinutes: 30, longPerMinutes: 7, // x1 up to freeMinutes, then +1 per 7 minutes, until longMinutes
  small: 0.6, standard: 1, large: 1.5,
  floor: 0.05,
};

const CODE = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'write_file', 'replace', 'apply_patch', 'str_replace_editor', 'str_replace_based_edit_tool', 'create_file']);
const RESEARCH = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'google_web_search']);
const READ = new Set(['read', 'grep', 'glob', 'ls', 'read_file', 'read_many_files', 'list_directory', 'grep_search', 'search_file_content']);
const RUN = new Set(['bash', 'run_shell_command', 'shell', 'task', 'agent', 'skill']);
const HIVE_CMD = /^\s*(?:hive|office|node\s+\S*office\.mjs|responding to\b)/i; // the agent talking to the Hive, not working

/** 'code' | 'research' | 'read' | 'run' | 'chat' | 'other' for one tool call. The Hive's own commands (hive buzz, say, ...) are chat, not work. */
export function toolClass(tool, input) {
  const t = String(tool ?? '').toLowerCase();
  const cmd = typeof input?.command === 'string' ? input.command : '';
  if (RUN.has(t) && cmd && HIVE_CMD.test(cmd)) return 'chat';
  if (CODE.has(t)) return 'code';
  if (RESEARCH.has(t)) return 'research';
  if (READ.has(t)) return 'read';
  if (RUN.has(t)) return 'run';
  return 'other';
}

/** 'small' | 'standard' | 'large' from a model name. Unknown names are standard. */
export function modelTier(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return 'standard';
  const params = n.match(/(\d+(?:\.\d+)?)\s*b\b/); // 7b, 30b, 235b ...
  if (/haiku|flash|(^|[-_\s.])mini|nano|lite|small|instant|turbo/.test(n)) return 'small'; // (not "gemini")
  if (/opus|fable|ultra|gpt-?5|\bo[134]\b|[-_\s.]pro\b|large|\bmax\b/.test(n)) return 'large';
  if (params) { const b = Number(params[1]); return b <= 14 ? 'small' : b >= 70 ? 'large' : 'standard'; }
  return 'standard';
}

/**
 * What a turn is worth. `calls` is the list of toolClass() values, `startAt`/`endAt` in ms (a turn we saw no start for has no length),
 * `model` the model name if known. Rounded to hundredths.
 */
export function turnWeight({ calls = [], startAt, endAt, model } = {}, cfg = SCORE) {
  const work = calls.filter((c) => c !== 'chat');
  const n = (k) => work.filter((c) => c === k).length;
  let base;
  if (n('code') >= 1 || n('research') >= 1 || n('read') + n('run') >= cfg.fullReads) base = cfg.full;
  else if (work.length) base = Math.min(cfg.lightMax, cfg.light + 0.05 * (work.length - 1));
  else base = cfg.chatOnly;
  const minutes = startAt === undefined || endAt === undefined ? 0 : Math.min(cfg.longMinutes, Math.max(0, (endAt - startAt) / 60_000));
  const length = minutes <= cfg.freeMinutes ? 1 : 1 + (minutes - cfg.freeMinutes) / cfg.longPerMinutes;
  const size = cfg[modelTier(model)];
  return Math.max(cfg.floor, Math.round(base * length * size * 100) / 100);
}
