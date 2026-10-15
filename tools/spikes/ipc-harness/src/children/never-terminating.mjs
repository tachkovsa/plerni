// never-terminating.mjs — byte-at-a-time output with no newline, so the frame never closes.

const one = Buffer.from([0x61]);

function pump() {
  let wrote = 0;
  while (wrote < 4096) {
    const ok = process.stdout.write(one);
    wrote++;
    if (!ok) {
      process.stdout.once('drain', pump);
      return;
    }
  }
  setImmediate(pump);
}

pump();
process.stdout.on('error', () => {});
