import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { basename } from 'node:path';

const NAMES = ['Ada','Alan','Grace','Linus','Margaret','Dennis','Barbara','Ken','Hedy','Tim','Radia','Guido','Frances','Bjarne','Katherine','Brian','Edsger','Donald','Sophie','Niklaus','Anita','Leslie','Shafi','Vint','Carol','Fernando','Joan','Claude','Jean','Evelyn','Mary','Seymour','Lynn','Rob','Yukihiro','Ruth','Marvin','Dana','Whitfield','Cynthia','Butler','Judea','Manuela','Leonard','Maurice','Ivan','Susan','Peter','Kristen','Jon','Sandra','Bram','Anders','Larry','Ellen','Raj','Cleve','Gladys','Wendy','Erik','Nancy','Tony','Lotfi','Amir'];

/** Same user + machine + project folder → same name every time, so an agent is recognisable on the
 *  big screen across sessions. Pass an explicit name to override. */
export function defaultName(cwd = process.cwd()) {
  const id = `${userInfo().username}@${hostname()}:${basename(cwd)}`;
  const n = createHash('sha256').update(id).digest().readUInt32BE(0);
  return NAMES[n % NAMES.length];
}
