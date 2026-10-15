// framing.test.mjs — Property tests using seeded PRNG (no new dependency).
// Verifies: seeded arbitrary byte streams match an independent reference (exact frames
// or the same typed error); oversize, residual-oversize, truncated, and malformed
// input → typed errors; per-connection partial-frame buffer cap enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NdjsonFramer, encodeNdjson, NdjsonOversizeError, NdjsonFramingError, NdjsonUnterminatedAtEofError,
  MuxFramer, encodeMux, MuxOversizeError, MuxFramingError, MuxUnterminatedAtEofError,
} from './framing.mjs';
import { echoRoundTrip } from './cases/smoke.mjs';

// Seeded PRNG (LCG): hand-rolled, no new dependency (plan T5a step 1).
class SeededRandom {
  #state;
  constructor(seed = 0x5EED) {
    this.#state = seed >>> 0;
  }
  next() {
    this.#state = (this.#state * 1664525 + 1013904223) >>> 0;
    return this.#state / 0x100000000;
  }
  int(max) {
    return Math.floor(this.next() * max);
  }
  bytes(len) {
    return Buffer.from(Array.from({ length: len }, () => this.int(256)));
  }
}

// ============
// NDJSON tests
// ============

test('NDJSON: arbitrary messages round-trip', () => {
  const rng = new SeededRandom(42);
  const framer = new NdjsonFramer();
  const sent = [];
  for (let i = 0; i < 100; i++) {
    const obj = { id: i, data: rng.bytes(rng.int(200)).toString('hex') };
    sent.push(obj);
    framer.feed(encodeNdjson(obj));
  }
  const received = [];
  for (const frame of framer.frames()) {
    received.push(frame);
  }
  assert.deepEqual(received, sent);
});

test('NDJSON: incremental chunked feed', () => {
  const framer = new NdjsonFramer();
  const msg = { x: 123 };
  const wire = encodeNdjson(msg);
  for (let i = 0; i < wire.length; i++) {
    framer.feed(wire[i]);
  }
  const out = [];
  for (const frame of framer.frames()) {
    out.push(frame);
  }
  assert.deepEqual(out, [msg]);
});

const MAX_FRAME_SIZE = 1024 * 1024;

test('NDJSON: oversize frame rejected', () => {
  const huge = { data: 'x'.repeat(2e6) };
  assert.throws(() => encodeNdjson(huge), NdjsonOversizeError);
});

test('NDJSON: newline-terminated frame between 1MiB and 2MiB is rejected by the decoder', () => {
  const payload = 'x'.repeat(MAX_FRAME_SIZE + 10);
  const line = Buffer.from(`${JSON.stringify(payload)}\n`);
  assert.ok(line.length > MAX_FRAME_SIZE && line.length < 2 * MAX_FRAME_SIZE);
  const framer = new NdjsonFramer();
  framer.feed(line);
  assert.throws(() => [...framer.frames()], NdjsonOversizeError);
});

test('NDJSON: unterminated residual one byte past the frame cap is rejected in feed', () => {
  const framer = new NdjsonFramer();
  framer.feed(Buffer.alloc(MAX_FRAME_SIZE, 0x61));
  framer.feed(Buffer.from([0x61]));
  assert.equal(framer.pendingBytes(), MAX_FRAME_SIZE + 1);
  assert.throws(() => framer.feed(Buffer.from([0x61])), NdjsonOversizeError);
});

test('NDJSON: a complete frame followed by an oversize residual still yields', () => {
  const framer = new NdjsonFramer();
  const blob = Buffer.concat([
    Buffer.from('{"a":1}\n'),
    Buffer.alloc(MAX_FRAME_SIZE + 2, 0x61),
  ]);
  framer.feed(blob);
  const frames = framer.frames();
  assert.deepEqual(frames.next().value, { a: 1 });
  assert.throws(() => frames.next(), NdjsonOversizeError);
});

test('NDJSON: malformed JSON rejected', () => {
  const framer = new NdjsonFramer();
  framer.feed('{broken\n');
  assert.throws(() => {
    for (const _ of framer.frames()) {
      // consume
    }
  }, NdjsonFramingError);
});

test('NDJSON: empty lines ignored', () => {
  const framer = new NdjsonFramer();
  framer.feed('{"a":1}\n\n\n{"b":2}\n');
  const out = [];
  for (const frame of framer.frames()) {
    out.push(frame);
  }
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

// =========
// Mux tests
// =========

test('Mux: arbitrary messages round-trip', () => {
  const rng = new SeededRandom(99);
  const framer = new MuxFramer();
  const sent = [];
  for (let i = 0; i < 100; i++) {
    const obj = { id: i, data: rng.bytes(rng.int(300)).toString('hex') };
    sent.push(obj);
    framer.feed(encodeMux(obj));
  }
  const received = [];
  for (const frame of framer.frames()) {
    received.push(frame);
  }
  assert.deepEqual(received, sent);
});

test('Mux: incremental byte-by-byte feed', () => {
  const framer = new MuxFramer();
  const msg = { y: 456 };
  const wire = encodeMux(msg);
  for (let i = 0; i < wire.length; i++) {
    framer.feed(wire.slice(i, i + 1));
  }
  const out = [];
  for (const frame of framer.frames()) {
    out.push(frame);
  }
  assert.deepEqual(out, [msg]);
});

test('Mux: oversize frame rejected', () => {
  const huge = { data: 'y'.repeat(2e6) };
  assert.throws(() => encodeMux(huge), MuxOversizeError);
});

test('Mux: oversize length is rejected as soon as the prefix is fed', () => {
  const framer = new MuxFramer();
  const badPrefix = Buffer.alloc(4);
  badPrefix.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);
  assert.throws(() => framer.feed(badPrefix), MuxOversizeError);
});

test('Mux: truncated frame at EOF is a typed error', () => {
  const framer = new MuxFramer();
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(100, 0);
  framer.feed(Buffer.concat([prefix, Buffer.alloc(6, 0x61)]));
  assert.equal(framer.pendingBytes(), 10);
  assert.equal([...framer.frames()].length, 0);
  assert.throws(() => framer.eof(), MuxUnterminatedAtEofError);
});

test('Mux: an earlier complete frame is yielded before an oversize prefix', () => {
  const framer = new MuxFramer();
  const badPrefix = Buffer.alloc(4);
  badPrefix.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);
  framer.feed(Buffer.concat([encodeMux({ a: 1 }), badPrefix]));
  const frames = framer.frames();
  assert.deepEqual(frames.next().value, { a: 1 });
  assert.throws(() => frames.next(), MuxOversizeError);
});

test('Mux: malformed JSON rejected', () => {
  const framer = new MuxFramer();
  const bad = Buffer.from('{bad');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bad.length, 0);
  framer.feed(Buffer.concat([len, bad]));
  assert.throws(() => {
    for (const _ of framer.frames()) {
      // consume
    }
  }, MuxFramingError);
});

test('Mux: partial frame waits for completion', () => {
  const framer = new MuxFramer();
  const msg = { z: 789 };
  const wire = encodeMux(msg);
  framer.feed(wire.slice(0, 6)); // partial
  let count = 0;
  for (const _ of framer.frames()) {
    count++;
  }
  assert.equal(count, 0);
  framer.feed(wire.slice(6)); // complete
  const out = [];
  for (const frame of framer.frames()) {
    out.push(frame);
  }
  assert.deepEqual(out, [msg]);
});

test('NDJSON: unterminated frame at EOF rejected', () => {
  const framer = new NdjsonFramer();
  framer.feed(Buffer.from('{"incomplete":true'));
  assert.strictEqual([...framer.frames()].length, 0);
  assert.throws(() => framer.eof(), NdjsonFramingError);
});

test('NDJSON: short truncation at EOF rejected', () => {
  const framer = new NdjsonFramer();
  framer.feed(Buffer.from('{"a":1}\n{"b":2}')); // second frame incomplete
  assert.strictEqual([...framer.frames()].length, 1);
  assert.throws(() => framer.eof(), NdjsonFramingError);
});

test('NDJSON: byte-length limits (not UTF-16)', () => {
  // 4-byte UTF-8 emoji: U+1F600
  const emoji = '😀';
  const payload = { text: emoji.repeat(300000) }; // ~1.2MB in bytes
  assert.throws(() => encodeNdjson(payload), NdjsonOversizeError);
});

test('Mux: byte-by-byte feed (no quadratic concatenation)', () => {
  const framer = new MuxFramer();
  const msg = { text: 'a'.repeat(10000) };
  const encoded = encodeMux(msg);
  // Feed one byte at a time
  for (let i = 0; i < encoded.length; i++) {
    framer.feed(encoded.slice(i, i + 1));
  }
  const frames = [...framer.frames()];
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].text, msg.text);
});

test('Mux: byte-length limits (not UTF-16)', () => {
  const emoji = '😀';
  const payload = { text: emoji.repeat(300000) };
  assert.throws(() => encodeMux(payload), MuxOversizeError);
});

test('NDJSON: frames() after every byte does not recopy the prefix', () => {
  const framer = new NdjsonFramer();
  const msg = { text: 'a'.repeat(20000) };
  const wire = Buffer.from(encodeNdjson(msg));
  const out = [];
  const started = performance.now();
  for (let i = 0; i < wire.length; i++) {
    framer.feed(wire.subarray(i, i + 1));
    for (const frame of framer.frames()) out.push(frame);
  }
  const elapsed = performance.now() - started;
  framer.eof();
  assert.deepEqual(out, [msg]);
  // A full prefix copy on every byte is quadratic (~2e8 byte-copies here) and
  // takes seconds. Linear scanning finishes well under this bound.
  assert.ok(elapsed < 1500, `byte-at-a-time parse took ${elapsed.toFixed(0)}ms`);
});

test('NDJSON: invalid UTF-8 inside a finished line is rejected', () => {
  const framer = new NdjsonFramer();
  // '1', dangling 0xC3, newline, then a valid second line. stream:true would
  // accept JSON value 1 and leave the dangling byte for the next frame.
  framer.feed(Buffer.from([0x31, 0xc3, 0x0a, 0x32, 0x0a]));
  const frames = framer.frames();
  assert.throws(() => frames.next(), NdjsonFramingError);
});

test('NDJSON: multibyte character split across chunks round-trips', () => {
  const framer = new NdjsonFramer();
  const line = Buffer.from('{"t":"é"}\n');
  const split = line.indexOf(0xc3);
  framer.feed(line.subarray(0, split + 1));
  assert.equal([...framer.frames()].length, 0);
  framer.feed(line.subarray(split + 1));
  assert.deepEqual([...framer.frames()], [{ t: 'é' }]);
});

test('NDJSON: complete frames may exceed the partial-buffer cap in one feed', () => {
  const framer = new NdjsonFramer();
  const line = JSON.stringify({ n: 'x'.repeat(100_000) }) + '\n';
  const blob = line.repeat(22);
  assert.ok(Buffer.byteLength(blob) > 2 * 1024 * 1024);
  framer.feed(blob);
  assert.equal([...framer.frames()].length, 22);
  framer.eof();
});

test('Mux: frames() after every byte does not recopy the prefix', () => {
  const framer = new MuxFramer();
  const msg = { text: 'b'.repeat(20000) };
  const wire = encodeMux(msg);
  const out = [];
  const started = performance.now();
  for (let i = 0; i < wire.length; i++) {
    framer.feed(wire.subarray(i, i + 1));
    for (const frame of framer.frames()) out.push(frame);
  }
  const elapsed = performance.now() - started;
  assert.deepEqual(out, [msg]);
  assert.ok(elapsed < 1500, `byte-at-a-time parse took ${elapsed.toFixed(0)}ms`);
});

test('Mux: invalid UTF-8 is a typed framing error', () => {
  const framer = new MuxFramer();
  const payload = Buffer.from([0xc3, 0x28]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  framer.feed(Buffer.concat([len, payload]));
  const frames = framer.frames();
  assert.throws(() => frames.next(), MuxFramingError);
});

test('Mux: complete frames may exceed the partial-buffer cap in one feed', () => {
  const framer = new MuxFramer();
  const frame = encodeMux({ n: 'y'.repeat(100_000) });
  const blob = Buffer.concat(Array.from({ length: 22 }, () => frame));
  assert.ok(blob.length > 2 * 1024 * 1024);
  framer.feed(blob);
  assert.equal([...framer.frames()].length, 22);
});

function randomText(rng, maxChars) {
  const n = 1 + rng.int(maxChars);
  let s = '';
  for (let i = 0; i < n; i++) {
    const roll = rng.int(10);
    if (roll === 0) s += '😀';
    else if (roll === 1) s += '你';
    else if (roll === 2) s += 'é';
    else {
      const cp = rng.int(0x80);
      s += cp === 0x0a || cp === 0x0d ? ' ' : String.fromCodePoint(cp);
    }
  }
  return s;
}

function splitSeeded(buf, rng) {
  const cuts = [0, buf.length];
  const n = buf.length === 0 ? 0 : 1 + rng.int(Math.min(24, buf.length));
  for (let i = 0; i < n; i++) cuts.push(rng.int(buf.length + 1));
  cuts.sort((a, b) => a - b);
  const pieces = [];
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] > cuts[i - 1]) pieces.push(buf.subarray(cuts[i - 1], cuts[i]));
  }
  return pieces;
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// Independent of the framers. Frames pushed before the first typed error are
// kept. A partial tail at or under the residual cap is not an error.
function referenceNdjson(buf) {
  const frames = [];
  try {
    let i = 0;
    while (i < buf.length) {
      const nl = buf.indexOf(0x0a, i);
      if (nl < 0) {
        if (buf.length - i > MAX_FRAME_SIZE + 1) throw new NdjsonOversizeError('residual');
        return { frames, error: null };
      }
      const line = buf.subarray(i, nl);
      i = nl + 1;
      if (line.length > MAX_FRAME_SIZE) throw new NdjsonOversizeError('line');
      let text;
      try {
        text = decodeUtf8(line).trim();
      } catch (e) {
        throw new NdjsonFramingError(`invalid utf-8: ${e.message}`);
      }
      if (!text) continue;
      try {
        frames.push(JSON.parse(text));
      } catch (e) {
        throw new NdjsonFramingError(`malformed JSON: ${e.message}`);
      }
    }
    return { frames, error: null };
  } catch (e) {
    if (e instanceof SyntaxError) return { frames, error: new NdjsonFramingError(e.message) };
    return { frames, error: e };
  }
}

function referenceMux(buf) {
  const frames = [];
  try {
    let i = 0;
    while (buf.length - i >= 4) {
      const len = buf.readUInt32BE(i);
      if (len > MAX_FRAME_SIZE) throw new MuxOversizeError('length');
      if (buf.length - i < 4 + len) return { frames, error: null };
      const payload = buf.subarray(i + 4, i + 4 + len);
      i += 4 + len;
      let text;
      try {
        text = decodeUtf8(payload);
      } catch (e) {
        throw new MuxFramingError(`invalid utf-8: ${e.message}`);
      }
      try {
        frames.push(JSON.parse(text));
      } catch (e) {
        throw new MuxFramingError(`malformed JSON: ${e.message}`);
      }
    }
    return { frames, error: null };
  } catch (e) {
    return { frames, error: e };
  }
}

function assertAgrees(Framer, buf, reference, rng) {
  const framer = new Framer();
  const got = [];
  let framerError = null;
  try {
    for (const piece of splitSeeded(buf, rng)) {
      framer.feed(piece);
      for (const frame of framer.frames()) got.push(frame);
    }
  } catch (e) {
    framerError = e;
  }
  const { frames, error } = reference(buf);
  assert.deepEqual(got, frames);
  if (error) assert.equal(framerError?.constructor, error.constructor);
  else assert.equal(framerError, null);
}

test('NDJSON: random UTF-8 frames survive seeded chunk splits', () => {
  const rng = new SeededRandom(7);
  const sent = [];
  const parts = [];
  for (let i = 0; i < 30; i++) {
    const obj = { i, t: randomText(rng, 40) };
    sent.push(obj);
    parts.push(Buffer.from(encodeNdjson(obj)));
  }
  const framer = new NdjsonFramer();
  for (const piece of splitSeeded(Buffer.concat(parts), rng)) framer.feed(piece);
  assert.deepEqual([...framer.frames()], sent);
  framer.eof();
});

test('Mux: random UTF-8 frames survive seeded chunk splits', () => {
  const rng = new SeededRandom(11);
  const sent = [];
  const parts = [];
  for (let i = 0; i < 30; i++) {
    const obj = { i, t: randomText(rng, 40) };
    sent.push(obj);
    parts.push(encodeMux(obj));
  }
  const framer = new MuxFramer();
  for (const piece of splitSeeded(Buffer.concat(parts), rng)) framer.feed(piece);
  assert.deepEqual([...framer.frames()], sent);
  framer.eof();
});

test('both codecs: seeded raw bytes match an independent reference', () => {
  const rng = new SeededRandom(1234);
  for (let trial = 0; trial < 25; trial++) {
    let raw = rng.bytes(rng.int(3000));
    if (rng.int(3) === 0) {
      const msg = { n: trial, t: randomText(rng, 12) };
      raw = Buffer.concat([Buffer.from(encodeNdjson(msg)), raw]);
    }
    assertAgrees(NdjsonFramer, raw, referenceNdjson, rng);
  }
  for (let trial = 0; trial < 25; trial++) {
    let raw = rng.bytes(rng.int(3000));
    if (rng.int(3) === 0) {
      const msg = { n: trial, t: randomText(rng, 12) };
      raw = Buffer.concat([encodeMux(msg), raw]);
    }
    assertAgrees(MuxFramer, raw, referenceMux, rng);
  }
});

test('echo: a large burst completes under stdout backpressure', async () => {
  const echoPath = join(dirname(fileURLToPath(import.meta.url)), 'children', 'echo.mjs');
  const child = spawn(process.execPath, [echoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const messages = Array.from({ length: 8 }, (_, i) => ({ i, t: 'z'.repeat(64 * 1024) }));
  for (const msg of messages) {
    const wire = encodeNdjson(msg);
    if (!child.stdin.write(wire)) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const framer = new NdjsonFramer();
  framer.feed(Buffer.concat(chunks));
  assert.deepEqual([...framer.frames()], messages.map((m) => ({ ...m, echoed: true })));
  framer.eof();
});

test('smoke framing records a non-zero child exit', async () => {
  const result = await echoRoundTrip([], {
    command: process.execPath,
    args: ['-e', 'process.stdout.write(\'{"id":1,"echoed":true}\\n\'); process.exit(1);'],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.feedError, null);
  assert.equal(result.eofError, null);
  assert.deepEqual(result.received, [{ id: 1, echoed: true }]);
});

test('smoke framing records an unterminated frame at EOF', async () => {
  const result = await echoRoundTrip([], {
    command: process.execPath,
    args: ['-e', 'process.stdout.write(\'{"id":1}\'); process.exit(0);'],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.feedError, null);
  assert.ok(result.eofError instanceof NdjsonUnterminatedAtEofError);
});

test('echo: exits after the first framing error and drops later frames', async () => {
  const echoPath = join(dirname(fileURLToPath(import.meta.url)), 'children', 'echo.mjs');
  const child = spawn(process.execPath, [echoPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  child.stdin.write('{bad\n');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !Buffer.concat(stderr).toString('utf8').includes('framing error')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(Buffer.concat(stderr).toString('utf8'), /framing error/);

  child.stdin.write('{"id":1}\n');
  const killTimer = setTimeout(() => child.kill(), 2000);
  const [code] = await once(child, 'close');
  clearTimeout(killTimer);
  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString('utf8').includes('"id":1'), false);
});
