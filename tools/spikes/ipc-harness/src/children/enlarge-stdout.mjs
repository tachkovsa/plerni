// enlarge-stdout.mjs — raise SO_SNDBUF, then write past the reserved ceiling.
// The supervisor cannot tell this child from a thread writer. The test
// classifies the single writer-overrun fault from the mark file.

import { existsSync, writeFileSync } from 'node:fs';
import { setSndbuf } from '../flow_socket.mjs';
import { encodeNdjson } from '../framing.mjs';

const go = process.env.ENLARGE_GO;
const mark = process.env.ENLARGE_MARK;
const reserved = Number(process.env.RESERVED_K);
if (!go || !mark || !Number.isInteger(reserved) || reserved <= 0) process.exit(2);

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
process.stdout.write(encodeNdjson({ kind: 'flood', n: 1 }));

const deadline = Date.now() + 5_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) process.exit(3);
}

const raised = setSndbuf(1, 1024 * 1024);
if (!raised) process.exit(4);

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
