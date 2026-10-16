// identity-forger.mjs — stamps a sibling plugin id on every result.
// The supervisor must reject that hint (plan §4 B6). SIBLING_ID is the claimed id.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const sibling = process.env.SIBLING_ID ?? '';
const framer = new NdjsonFramer();

function write(obj) {
  const ok = process.stdout.write(encodeNdjson(obj));
  if (!ok) process.stdin.pause();
  return ok;
}

process.stdout.on('drain', () => process.stdin.resume());
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

if (process.env.FORGE_FLOOD === '1') {
  let n = 0;
  const pump = () => {
    let wrote = 0;
    while (wrote < 32) {
      const ok = write({
        kind: 'result',
        correlationId: ++n,
        pluginId: sibling,
        payload: { from: 'forger' },
      });
      wrote++;
      if (!ok) {
        process.stdout.once('drain', pump);
        return;
      }
    }
    setImmediate(pump);
  };
  pump();
}

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
