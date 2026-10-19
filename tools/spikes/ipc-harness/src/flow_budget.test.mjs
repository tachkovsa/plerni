import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_READ_BYTES,
  assessFlow,
  classifyWriterOverrun,
  partialCapHolds,
  totalCapHolds,
  writerCeiling,
  writerOverrun,
} from './flow_budget.mjs';
import { MAX_RESIDUAL } from './framing.mjs';
import { NdjsonFramer, NdjsonOversizeError } from './framing.mjs';

test('writer ceiling uses the measured sndbuf and rejects a non-positive extra skb', () => {
  assert.equal(writerCeiling(4608), 4608 + 2304 - 64);
  assert.equal(writerCeiling(2048), 3008);
  assert.equal(writerCeiling(100), null);
  assert.equal(writerCeiling(0), null);
});

test('budgets are unsatisfiable when the reservation does not fit', () => {
  const tiny = assessFlow({
    partialCap: 1024,
    totalCap: 48 * 1024,
    totalGlobal: 1024 * 1024,
    sndbufIn: 4608,
    sndbufOut: 4608,
    readBytes: FLOW_READ_BYTES,
    childCount: 1,
  });
  assert.equal(tiny.outcome, 'unsatisfiable');
  assert.equal(tiny.reason, 'reservation does not fit the configured caps');
  const trip = assessFlow({
    partialCap: 32 * 1024,
    totalCap: 48 * 1024,
    totalGlobal: 1024 * 1024,
    sndbufIn: 4608,
    sndbufOut: 4608,
    readBytes: FLOW_READ_BYTES,
    childCount: 1,
  });
  assert.equal(trip.outcome, 'ok');
  assert.ok(trip.bP >= 0);
  assert.ok(trip.bT >= 0);
  assert.ok(trip.bG >= 0);
});

test('a cleaned-up count and the recorded partial snapshot do not hold', () => {
  const cap = 32 * 1024;
  assert.equal(partialCapHolds(36864 + 32768, cap), false);
  assert.equal(partialCapHolds(cap + 4096, cap), false);
  assert.equal(partialCapHolds(0, cap, { afterCleanup: true }), false);
  assert.equal(totalCapHolds(106496, 48 * 1024), false);
  assert.equal(totalCapHolds(0, 48 * 1024, { afterCleanup: true }), false);
  assert.equal(totalCapHolds(48 * 1024, 48 * 1024, { stdoutUnread: 100, kIn: 50 }), false);
});

test('the overrun fault is one code and the test classifies the child', () => {
  assert.equal(writerOverrun(100, 99), true);
  assert.equal(writerOverrun(99, 99), false);
  assert.equal(classifyWriterOverrun('raised-sndbuf'), 'enlarger');
  assert.equal(classifyWriterOverrun('threads'), 'thread-writer');
  assert.equal(classifyWriterOverrun('flood'), null);
});

test('buffering exactly MAX_RESIDUAL does not throw', () => {
  const framer = new NdjsonFramer();
  framer.feed(Buffer.alloc(MAX_RESIDUAL, 0x61));
  assert.equal(framer.pendingBytes(), MAX_RESIDUAL);
  assert.equal(framer.hasPendingNewline(), false);
  assert.throws(() => framer.feed(Buffer.from([0x61])), NdjsonOversizeError);
});
