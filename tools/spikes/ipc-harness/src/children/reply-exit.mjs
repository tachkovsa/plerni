// reply-exit.mjs — write one result into the kernel queue, then exit.
// process.exit does not flush a userspace stdout buffer, so the reply is
// written with writeSync before the process ends.

import { writeSync } from 'node:fs';
import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind !== 'call') continue;
      writeSync(1, encodeNdjson({
        kind: 'result',
        correlationId: msg.correlationId,
        payload: { ok: true },
      }));
      process.exit(0);
    }
  } catch {
    process.exit(1);
  }
});
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
