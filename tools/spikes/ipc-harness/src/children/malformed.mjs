// malformed.mjs — one malformed NDJSON line, then stay up until the supervisor kills us.

process.stdout.write('{bad\n');
setInterval(() => {}, 60_000);
