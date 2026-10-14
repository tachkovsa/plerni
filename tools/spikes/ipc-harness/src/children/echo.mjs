// echo.mjs — Echo child: reads NDJSON from stdin, echoes back over stdout.
// Demonstrates the stdio framing path.

import { NdjsonFramer, encodeNdjson } from '../framing.mjs';

const framer = new NdjsonFramer();

process.stdin.on('data', (chunk) => {
  try {
    framer.feed(chunk.toString('utf8'));
    for (const msg of framer.frames()) {
      // Echo back with "echoed" field set to true
      process.stdout.write(encodeNdjson({ ...msg, echoed: true }));
    }
  } catch (e) {
    console.error(`[echo] framing error: ${e.message}`);
    process.exit(1);
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
