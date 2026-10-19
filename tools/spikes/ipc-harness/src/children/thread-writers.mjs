// thread-writers.mjs — two threads write fd 1 without raising SO_SNDBUF.
// The native helper records the wall clock of the write that first exceeds
// the reserved K, into the mark file, before this process can be killed.

import { existsSync, writeFileSync } from 'node:fs';
import { burstWriters } from '../flow_socket.mjs';

const go = process.env.THREAD_GO;
const mark = process.env.THREAD_MARK;
const reserved = Number(process.env.RESERVED_K);
if (!go || !mark || !Number.isInteger(reserved) || reserved <= 0) process.exit(2);

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

const deadline = Date.now() + 5_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) process.exit(3);
}

const result = burstWriters(1, reserved, mark);
if (!result) process.exit(4);
if (!result.crossed) {
  writeFileSync(mark, `threads 0 ${result.written} ${result.fork}\n`);
}
process.exit(result.crossed ? 0 : 5);
