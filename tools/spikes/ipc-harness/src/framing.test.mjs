// framing.test.mjs — Property tests using seeded PRNG (no new dependency).
// Verifies: arbitrary byte streams never corrupt frames; oversize/incremental-oversize/
// never-terminated/malformed → typed errors; per-connection partial-frame buffer cap enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NdjsonFramer, encodeNdjson, NdjsonOversizeError, NdjsonNeverTerminatedError, NdjsonFramingError,
  MuxFramer, encodeMux, MuxOversizeError, MuxNeverTerminatedError, MuxFramingError,
} from './framing.mjs';

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

test('NDJSON: oversize frame rejected', () => {
  const huge = { data: 'x'.repeat(2e6) };
  assert.throws(() => encodeNdjson(huge), NdjsonOversizeError);
});

test('NDJSON: incremental oversize rejected', () => {
  const framer = new NdjsonFramer();
  // Exceed MAX_PARTIAL_BUFFER (2 MiB) without a newline
  const chunk = 'x'.repeat(100000);
  let thrown = false;
  try {
    for (let i = 0; i < 22; i++) {
      framer.feed(chunk);
    }
  } catch (e) {
    thrown = true;
    assert.ok(e instanceof NdjsonNeverTerminatedError);
  }
  assert.ok(thrown, 'should have thrown NdjsonNeverTerminatedError');
});

test('NDJSON: never-terminated frame rejected', () => {
  const framer = new NdjsonFramer();
  const noNewline = JSON.stringify({ a: 1 });
  framer.feed(noNewline);
  // Feed enough to exceed MAX_PARTIAL_BUFFER (2 MiB) - the error will be thrown
  // when we try to feed more than MAX_PARTIAL_BUFFER bytes total
  const chunk = 'x'.repeat(100000);
  let thrown = false;
  try {
    for (let i = 0; i < 22; i++) {
      framer.feed(chunk);
    }
  } catch (e) {
    thrown = true;
    assert.ok(e instanceof NdjsonNeverTerminatedError);
  }
  assert.ok(thrown, 'should have thrown NdjsonNeverTerminatedError');
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

test('Mux: incremental oversize rejected', () => {
  const framer = new MuxFramer();
  // length prefix claiming 2 MiB
  const badPrefix = Buffer.alloc(4);
  badPrefix.writeUInt32BE(2e6, 0);
  framer.feed(badPrefix);
  assert.throws(() => {
    for (const _ of framer.frames()) {
      // consume
    }
  }, MuxOversizeError);
});

test('Mux: never-terminated frame rejected', () => {
  const framer = new MuxFramer();
  // Feed enough to exceed MAX_PARTIAL_BUFFER (2 MiB)
  const chunk = Buffer.alloc(100000, 0x01);
  let thrown = false;
  try {
    for (let i = 0; i < 22; i++) {
      framer.feed(chunk);
    }
  } catch (e) {
    thrown = true;
    assert.ok(e instanceof MuxNeverTerminatedError);
  }
  assert.ok(thrown, 'should have thrown MuxNeverTerminatedError');
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
