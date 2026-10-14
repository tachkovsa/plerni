// echo.mjs — Echo child: reads NDJSON from stdin, echoes back over stdout.
// Demonstrates the stdio framing path.
// Decodes UTF-8 as a continuous stream, rejects unterminated frames at EOF, drains stdout.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    // Feed raw bytes (Buffer) to framer for proper UTF-8 handling
    framer.feed(chunk);
    for (const msg of framer.frames()) {
      // Echo back with "echoed" field set to true
      process.stdout.write(encodeNdjson({ ...msg, echoed: true }));
    }
  } catch (e) {
    console.error(`[echo] framing error: ${e.message}`);
    process.exitCode = 1;
  }
});

process.stdin.on('end', () => {
  try {
    framer.eof(); // reject unterminated frames at EOF
    // Use exitCode to allow stdout to drain
    process.exitCode = 0;
  } catch (e) {
    console.error(`[echo] EOF error: ${e.message}`);
    process.exitCode = 1;
  }
});
