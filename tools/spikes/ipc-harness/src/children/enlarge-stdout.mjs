// enlarge-stdout.mjs — raise SO_SNDBUF, then write past the reserved ceiling.
// The supervisor types buffer-enlarged from the raised SO_SNDBUF. The mark
// file is the test's clock for when the write crossed K.

import { existsSync, writeFileSync } from 'node:fs';
import { setSndbuf } from '../flow_socket.mjs';
import { encodeNdjson } from '../framing.mjs';

const go = process.env.ENLARGE_GO;
const ready = process.env.ENLARGE_READY;
const block = process.env.ENLARGE_BLOCK;
const mark = process.env.ENLARGE_MARK;
const reserved = Number(process.env.RESERVED_K);
if (!go || !ready || !block || !mark || !Number.isInteger(reserved) || reserved <= 0) process.exit(2);

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
process.stdout.write(encodeNdjson({ kind: 'flood', n: 1 }));

const deadline = Date.now() + 5_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) process.exit(3);
}

const raised = setSndbuf(1, 1024 * 1024);
if (!raised) process.exit(4);
writeFileSync(ready, '1');
const holdDeadline = Date.now() + 5_000;
while (!existsSync(block)) {
  if (Date.now() > holdDeadline) process.exit(5);
}
const spinUntil = Date.now() + 20;
while (Date.now() < spinUntil) { /* stay scheduled across the parent's block */ }

const chunk = Buffer.alloc(4096, 0x62);
let written = 0;
let crossed = false;
const pump = () => {
  while (written <= reserved + chunk.length) {
    const ok = process.stdout.write(chunk);
    written += chunk.length;
    if (!crossed && written > reserved) {
      crossed = true;
      writeFileSync(mark, `raised-sndbuf ${Date.now()}\n`);
    }
    if (!ok) {
      process.stdout.once('drain', pump);
      return;
    }
  }
};
pump();
