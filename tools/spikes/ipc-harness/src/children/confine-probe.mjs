// confine-probe.mjs — report the confinement filter, then exit on request.
// probeConfinement refuses to run unless the wrapper installed the filter.
// A write to fd 0 must fail: the wrapper half-closes that direction.

import { closeSync, openSync, writeSync } from 'node:fs';
import { NdjsonFramer, encodeNdjson } from '../framing.mjs';
import { probeConfinement } from '../flow_socket.mjs';

process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

let reverse = 'wrote';
try {
  writeSync(0, Buffer.from([0x58]));
} catch (err) {
  reverse = err?.code || 'error';
}

let mem = 'absent';
const target = process.env.MEM_PID;
if (typeof target === 'string' && /^[1-9][0-9]*$/.test(target)) {
  try {
    const fd = openSync(`/proc/${target}/mem`, 'r');
    mem = 'open';
    closeSync(fd);
  } catch (err) {
    mem = err?.code || 'error';
  }
}

const report = {
  ...(probeConfinement() ?? {}),
  reverse,
  mem,
  marker: process.env.PLUGIN_MARKER || '',
  ldAudit: process.env.LD_AUDIT ? 1 : 0,
  ldLibraryPath: process.env.LD_LIBRARY_PATH ? 1 : 0,
  ldPreload: process.env.LD_PRELOAD || '',
};
const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (msg.kind !== 'call') continue;
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
