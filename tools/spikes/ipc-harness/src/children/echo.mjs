// echo.mjs — Echo child: reads NDJSON from stdin, echoes back over stdout.
// Demonstrates the stdio framing path.
// Decodes raw stdin bytes, rejects unterminated frames at EOF.
// Pauses stdin while stdout is backed up, and stops after the first framing error.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();
let framingError = false;
let stdinPaused = false;
const padRequest = Number(process.env.ECHO_PAD);
const echoPad = Number.isInteger(padRequest) && padRequest > 0 && padRequest <= 1024 * 1024
  ? padRequest
  : 0;

function writeEcho(line) {
  const ok = process.stdout.write(line);
  if (!ok && !stdinPaused) {
    stdinPaused = true;
    process.stdin.pause();
    process.stdout.once('drain', () => {
      stdinPaused = false;
      if (!framingError) process.stdin.resume();
    });
  }
}

function onData(chunk) {
  if (framingError) return;
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      if (echoPad > 0 && msg.kind === 'call') {
        writeEcho(encodeNdjson({
          kind: 'result',
          correlationId: msg.correlationId,
          payload: 'q'.repeat(echoPad),
        }));
        continue;
      }
      writeEcho(encodeNdjson({ ...msg, echoed: true }));
    }
  } catch (e) {
    fail(e.message);
  }
}

function fail(message) {
  if (framingError) return;
  framingError = true;
  process.exitCode = 1;
  process.stdin.pause();
  process.stdin.off('data', onData);
  process.stderr.write(`[echo] framing error: ${message}\n`, () => {
    process.stdin.destroy();
  });
}

process.stdin.on('data', onData);

process.stdin.on('end', () => {
  if (framingError) return;
  try {
    framer.eof();
    process.exitCode = 0;
  } catch (e) {
    console.error(`[echo] EOF error: ${e.message}`);
    process.exitCode = 1;
  }
});
