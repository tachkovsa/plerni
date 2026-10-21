// thread-writers.mjs — threads write fd 1 without raising SO_SNDBUF.
// Two skbs fill the send buffer and stay under K. Each attempt starts four
// threads together so a fourth skb can land. The parent drains a miss and
// writes the next attempt number. The native helper records the wall clock
// of the write that first exceeds the reserved K, into the mark file, before
// this process can be killed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { burstWriters } from '../flow_socket.mjs';

const go = process.env.THREAD_GO;
const markDir = process.env.THREAD_MARK;
const reserved = Number(process.env.RESERVED_K);
const threads = Number(process.env.THREAD_COUNT || 4);
const maxAttempts = Number(process.env.THREAD_ATTEMPTS || 40);
if (!go || !markDir || !Number.isInteger(reserved) || reserved <= 0) process.exit(2);
if (!Number.isInteger(threads) || threads < 2) process.exit(2);
if (!Number.isInteger(maxAttempts) || maxAttempts < 1) process.exit(2);

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
mkdirSync(markDir, { recursive: true });

let last = 0;
const deadline = Date.now() + 20_000;
while (last < maxAttempts && Date.now() < deadline) {
  let n = 0;
  try {
    n = Number(readFileSync(go, 'utf8'));
  } catch {
    n = 0;
  }
  if (!Number.isInteger(n) || n <= last) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    continue;
  }
  last = n;
  const mark = join(markDir, String(n));
  const result = burstWriters(1, reserved, mark, threads);
  if (!result) process.exit(4);
  if (result.crossed) process.exit(0);
  writeFileSync(mark, `threads 0 ${result.written} ${result.fork}\n`);
}
process.exit(5);
