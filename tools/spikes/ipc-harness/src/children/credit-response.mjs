// credit-response.mjs — small requests, large results.
// A result is written only when the send window covers that line. Further
// results wait for a window-update after the supervisor consumes stdout.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();
const padRequest = Number(process.env.RESPONSE_PAD);
const pad = Number.isInteger(padRequest) && padRequest > 0 && padRequest <= 64 * 1024
  ? padRequest
  : 1024;
let credit = 0;
const waiting = [];

function resultPad(msg) {
  const requested = Number(msg?.payload?.pad);
  if (Number.isInteger(requested) && requested > 0 && requested <= 64 * 1024) return requested;
  return pad;
}

function resultLine(msg) {
  return encodeNdjson({
    kind: 'result',
    correlationId: msg.correlationId,
    payload: 'p'.repeat(resultPad(msg)),
  });
}

function flush() {
  while (waiting.length > 0) {
    const msg = waiting[0];
    const line = resultLine(msg);
    const n = Buffer.byteLength(line);
    if (n > credit) return;
    waiting.shift();
    credit -= n;
    process.stdout.write(line);
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
      if (msg.kind !== 'call') continue;
      waiting.push(msg);
      flush();
    }
  } catch {
    process.exitCode = 1;
    process.stdin.pause();
  }
});
