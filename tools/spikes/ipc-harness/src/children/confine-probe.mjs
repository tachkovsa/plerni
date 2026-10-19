// confine-probe.mjs — report the confinement filter, then exit on request.
// probeConfinement refuses to run unless the wrapper installed the filter.

import { writeSync } from 'node:fs';
import { NdjsonFramer, encodeNdjson } from '../framing.mjs';
import { probeConfinement } from '../flow_socket.mjs';

const report = probeConfinement();
const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      const line = encodeNdjson({
        kind: 'result',
        correlationId: msg.correlationId,
        payload: msg.payload?.exit === true ? { ok: true } : { confinement: report },
      });
      writeSync(1, line);
      if (msg.payload?.exit === true) process.exit(0);
    }
  } catch {
    process.exit(1);
  }
});
process.stdin.on('error', () => {});
