// credit-wait.mjs — answer a call only after a window-update grant.
// Cancel is control: it does not consume the request credit and is acknowledged
// even when the credit is zero. A call stays queued until a grant covers it.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();
let credit = 0;
const waiting = [];

function writeLine(obj) {
  process.stdout.write(encodeNdjson(obj));
}

function flush() {
  while (waiting.length > 0) {
    const msg = waiting[0];
    const line = encodeNdjson({
      kind: 'result',
      correlationId: msg.correlationId,
      payload: { granted: true },
    });
    const n = Buffer.byteLength(line);
    if (n > credit) return;
    waiting.shift();
    credit -= n;
    writeLine({
      kind: 'result',
      correlationId: msg.correlationId,
      payload: { granted: true },
    });
  }
}

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind === 'grant') {
        credit += Number(msg.credit) || 0;
        flush();
        continue;
      }
      if (msg.kind === 'cancel') {
        writeLine({ kind: 'cancelled', correlationId: msg.correlationId });
        continue;
      }
      if (msg.kind !== 'call') continue;
      waiting.push(msg);
      flush();
    }
  } catch {
    process.exitCode = 1;
    process.stdin.pause();
  }
});
