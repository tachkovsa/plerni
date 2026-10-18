// flood.mjs — sustained open-loop output.
// FLOOD_MODE=partial: unterminated bytes (partial-frame cap).
// FLOOD_MODE=silent: do not read stdin and do not write (pending-call cap).
// default: complete flood frames on the mux.

import { encodeNdjson } from '../framing.mjs';

const mode = process.env.FLOOD_MODE === 'partial' || process.env.FLOOD_MODE === 'silent'
  ? process.env.FLOOD_MODE
  : 'frames';

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

if (mode === 'silent') {
  setInterval(() => {}, 60_000);
} else if (mode === 'partial') {
  const requested = Number(process.env.FLOOD_CHUNK);
  const chunkSize = Number.isInteger(requested) && requested >= 1 && requested <= 1024 * 1024
    ? requested
    : 4096;
  const chunk = Buffer.alloc(chunkSize, 0x61);
  const pump = () => {
    if (process.stdout.write(chunk)) setImmediate(pump);
    else process.stdout.once('drain', pump);
  };
  pump();
} else {
  const line = encodeNdjson({ kind: 'flood', n: 1 });
  const pump = () => {
    let wrote = 0;
    while (wrote < 32 && process.stdout.write(line)) wrote++;
    if (wrote === 32) setImmediate(pump);
    else process.stdout.once('drain', pump);
  };
  pump();
}
