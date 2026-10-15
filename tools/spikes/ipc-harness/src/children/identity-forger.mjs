// identity-forger.mjs — stamps a sibling plugin id on every result.
// The supervisor must reject that hint (plan §4 B6). SIBLING_ID is the claimed id.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const sibling = process.env.SIBLING_ID ?? '';
const framer = new NdjsonFramer();

function write(obj) {
  const ok = process.stdout.write(encodeNdjson(obj));
  if (!ok) process.stdin.pause();
}

process.stdout.on('drain', () => process.stdin.resume());
process.stdin.on('error', () => {});

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind === 'cancel') {
        write({ kind: 'cancelled', correlationId: msg.correlationId });
        continue;
      }
      if (msg.kind !== 'call') continue;
      write({
        kind: 'result',
        correlationId: msg.correlationId,
        pluginId: sibling,
        payload: { from: 'forger' },
      });
    }
  } catch {
    process.exitCode = 1;
    process.stdin.pause();
  }
});
