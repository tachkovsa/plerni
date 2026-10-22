// credit-wait.mjs — answer a call only after a window-update grant.
// Cancel is control: it does not consume the request credit and is acknowledged
// even when the credit is zero. A call stays queued until a grant covers it.

import { NdjsonFramer, encodeNdjson, stdoutLineSpends } from '../framing.mjs';

const framer = new NdjsonFramer();
let credit = 0;
const waiting = [];

function writeLine(obj) {
  const line = encodeNdjson(obj);
  if (stdoutLineSpends(line)) {
    const n = Buffer.byteLength(line);
    if (n > credit) return;
    credit -= n;
  }
  process.stdout.write(line);
}

function resultPayload(msg) {
  const requested = Number(msg?.payload?.pad);
  if (Number.isInteger(requested) && requested > 0 && requested <= 80 * 1024) {
    return 'p'.repeat(requested);
  }
  return { granted: true };
}

function flush() {
  while (waiting.length > 0) {
    const msg = waiting[0];
    const line = encodeNdjson({
      kind: 'result',
      correlationId: msg.correlationId,
      payload: resultPayload(msg),
    });
    const n = Buffer.byteLength(line);
    const spends = stdoutLineSpends(line);
    if (spends && n > credit) return;
    waiting.shift();
    if (spends) credit -= n;
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
