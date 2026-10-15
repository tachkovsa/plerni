// echo.mjs — Echo child: reads NDJSON from stdin, echoes back over stdout.
// Demonstrates the stdio framing path.
// Decodes raw stdin bytes, rejects unterminated frames at EOF, drains stdout.
// The first framing error stops further reads and lets the process exit.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();
let framingError = false;

function onData(chunk) {
  if (framingError) return;
  try {
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      process.stdout.write(encodeNdjson({ ...msg, echoed: true }));
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
