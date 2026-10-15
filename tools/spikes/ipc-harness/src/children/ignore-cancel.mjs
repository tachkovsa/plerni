// ignore-cancel.mjs — answers calls and drops cancel frames.
// A silent child is not an authority cancellation (plan §4 B2).

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind === 'cancel') continue;
      if (msg.kind !== 'call') continue;
      const reply = { kind: 'result', correlationId: msg.correlationId, payload: msg.payload };
      setTimeout(() => process.stdout.write(encodeNdjson(reply)), 80);
    }
  } catch {
    process.exitCode = 1;
    process.stdin.pause();
  }
});
process.stdin.on('error', () => {});
