// framing.test.mjs — Property tests using seeded PRNG (no new dependency).
// Verifies: arbitrary byte streams never corrupt frames; oversize/incremental-oversize/
// never-terminated/malformed → typed errors; per-connection partial-frame buffer cap enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
