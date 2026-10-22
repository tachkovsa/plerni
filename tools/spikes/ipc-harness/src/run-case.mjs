// run-case.mjs — one spike suite under the frozen measurement contract.
// B1 and B6 use that contract inside the case. B4, B2, and B5 do not take
// a window override from here. No preflight or repetition override.

import { b1 } from './cases/b1-throughput.mjs';
import { b2 } from './cases/b2-fencing.mjs';
import { b4 } from './cases/b4-bounds.mjs';
import { b5 } from './cases/b5-crash.mjs';
import { b6 } from './cases/b6-mux-identity.mjs';
import { CONTRACT } from './measure.mjs';

const suites = {
  b1: ['b1-throughput', b1],
  b2: ['b2-fencing', b2],
  b4: ['b4-bounds', b4],
  b5: ['b5-crash', b5],
  b6: ['b6-mux-identity', () => b6()],
};

const key = process.argv[2];
const suite = suites[key];
if (!suite) {
  console.error(`[run-case] expected one of ${Object.keys(suites).join(', ')}`);
  process.exit(2);
}

const [name, fn] = suite;
if (key === 'b1' || key === 'b6') {
  console.log(`[run-${key}] frozen warmupMs=${CONTRACT.warmupMs} windowMs=${CONTRACT.windowMs} reps=${CONTRACT.reps}`);
}
const result = await fn();
const mark = result.pass === true ? 'PASS' : result.pass === false ? 'FAIL' : 'INVALID';
console.log(`[${mark}] ${name} — ${JSON.stringify(result.detail ?? result)}`);
if (result.pass !== true) process.exit(1);
