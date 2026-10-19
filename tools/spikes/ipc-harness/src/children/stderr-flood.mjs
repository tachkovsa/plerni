// stderr-flood.mjs — fd 2 is /dev/null. A write there is not a kernel queue.

import { readlinkSync, writeSync } from 'node:fs';
import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const link = readlinkSync('/proc/self/fd/2');
writeSync(2, Buffer.alloc(256 * 1024, 0x61));

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      writeSync(1, encodeNdjson({
        kind: 'result',
        correlationId: msg.correlationId,
        payload: { stderr: link },
      }));
    }
  } catch {
    process.exit(1);
  }
});
process.stdin.on('error', () => {});
