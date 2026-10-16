// crash-mid-call.mjs — exit on the first call, before any result.

import { NdjsonFramer } from '../framing.mjs';

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind === 'call') process.exit(1);
    }
  } catch {
    process.exit(1);
  }
});
process.stdin.on('error', () => {});
