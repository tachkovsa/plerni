// run-b3.mjs — B3 under the frozen measurement contract.
// No window, repetition, or preflight override. The suite command is `spike`.

import { b3 } from './cases/b3-backpressure.mjs';
import { CONTRACT } from './measure.mjs';

const result = await b3();
const mark = result.pass === true ? 'PASS' : result.pass === false ? 'FAIL' : 'INVALID';
console.log(`[run-b3] frozen warmupMs=${CONTRACT.warmupMs} windowMs=${CONTRACT.windowMs} reps=${CONTRACT.reps}`);
console.log(`[${mark}] b3-backpressure — ${JSON.stringify(result.detail ?? result)}`);
if (result.pass !== true) process.exit(1);
