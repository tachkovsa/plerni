// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMux, encodeNdjson } from './framing.mjs';
import { FLOW_READ_BYTES, writerCeiling } from './flow_budget.mjs';
import {
  USABLE_RESPONSE,
  admissionCost,
  admissionSlot,
  advertisedDeficit,
  capKeep,
  createCreditBook,
  keepBytes,
  replenishCredit,
} from './credit.mjs';

// Reply stamp the supervisor withholds before it advertises credit: the mux
// frame grows by version, grants, and wide timestamps. The value is fixed
// for this credential shape.
function replyStamp() {
  const mux = encodeMux({
    kind: 'result',
    for: 'call',
    pluginId: 'credit',
    correlationId: 0,
    payload: '',
    sendTs: 1e15,
    ingressTs: 1e15,
    egressTs: 1e15,
    version: '0.0.0',
    generation: 1,
    grants: ['*'],
  });
  const line = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 0,
    payload: '',
  }));
  return Math.max(0, mux.length - line);
}

// Issue #52 repro ceilings. total 26000 and totalGlobal 100000 are the
// configured caps. The book sees userspace after one writer ceiling on each
// end and one read of C. sndbuf 4608 is a legal positive per-skb term.
function tightBook() {
  const k = writerCeiling(4608);
  const childCeiling = 26_000 - k - k - FLOW_READ_BYTES;
  const globalCap = 100_000 - 2 * (k + k + FLOW_READ_BYTES);
  const book = createCreditBook({ globalCap, pending: 32, stamp: replyStamp() });
  const added = book.addChild({ id: 'credit', ceiling: childCeiling, pending: 32 });
  return { book, k, childCeiling, globalCap, added };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cover(book, id, need) {
  book.replenish(id);
  if (book.window(id) < need) book.flush(id);
}

function assertAccount(book) {
  const account = book.account();
  assert.equal(account.sentOk, true);
  assert.equal(account.withinGlobal, true, JSON.stringify(account));
}

test('the half-room threshold coalesces grants and the quiet flush returns the deficit', () => {
  const room = 10000;
  const keep = 0;
  assert.equal(replenishCredit(room, keep, 0), 10000);
  assert.equal(replenishCredit(room, keep, 7000), 0);
  assert.equal(advertisedDeficit(room, keep, 7000), 3000);
  assert.equal(replenishCredit(room, keep, 4000), 6000);
  assert.equal(capKeep(room, 8000, 4000), 6000);
  assert.equal(capKeep(room, 1000, 4000), 1000);
});

test('cancel acknowledgements and grant lines do not spend send credit', () => {
  const book = createCreditBook({ globalCap: 80_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 80_000, pending: 1 }).ok, true);
  const need = book.promised('a');
  cover(book, 'a', need);
  const before = book.window('a');
  assert.ok(before >= need);
  assert.equal(book.noteControl('a', 36), before);
  assert.equal(book.spend('a', 0), 0);
  assert.equal(book.window('a'), before);
  assertAccount(book);
});

test('historical admission headroom cannot starve a usable reply', () => {
  const { book, k, childCeiling, globalCap, added } = tightBook();
  assert.equal(k, 6848);
  assert.equal(childCeiling, 8208);
  assert.ok(globalCap > childCeiling);
  assert.equal(added.ok, true);
  assert.equal(added.promised, USABLE_RESPONSE);
  const cost = admissionCost({
    pluginId: 'credit',
    correlationId: 7,
    payload: 'x'.repeat(5800),
  });
  assert.ok(cost.reservation > 5000);
  assert.ok(cost.reservation < childCeiling);
  const admitted = book.admit({
    childId: 'credit',
    correlationId: 7,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: USABLE_RESPONSE,
  });
  assert.equal(admitted.decision, 'admitted');
  const open = book.inspect('credit');
  assert.equal(open.noted, cost.reservation);
  // The uncapped grant is the review's starved window (about 2078 bytes).
  assert.ok(open.rawBudget < 2200, JSON.stringify(open));
  assert.ok(open.rawBudget < USABLE_RESPONSE, JSON.stringify(open));
  assert.ok(open.budget >= USABLE_RESPONSE, JSON.stringify(open));
  assert.ok(open.keep < open.rawKeep);
  cover(book, 'credit', USABLE_RESPONSE);
  assert.ok(book.window('credit') >= USABLE_RESPONSE);
  assert.equal(book.spend('credit', USABLE_RESPONSE), USABLE_RESPONSE);
  assert.equal(book.release('credit', USABLE_RESPONSE).released, USABLE_RESPONSE);
  const stillLive = book.inspect('credit');
  assert.equal(stillLive.noted, cost.reservation);
  assert.ok(stillLive.rawBudget < USABLE_RESPONSE);
  cover(book, 'credit', USABLE_RESPONSE);
  assert.ok(book.window('credit') >= USABLE_RESPONSE, JSON.stringify(book.inspect('credit')));
  assertAccount(book);
});

test('a timed-out call releases its reservation and the next reply is granted', () => {
  const { book, added } = tightBook();
  assert.equal(added.ok, true);
  const cost = admissionCost({
    pluginId: 'credit',
    correlationId: 7,
    payload: 'x'.repeat(5800),
  });
  assert.equal(book.admit({
    childId: 'credit',
    correlationId: 7,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: USABLE_RESPONSE,
  }).decision, 'admitted');
  const before = book.inspect('credit');
  const settled = book.settle('credit', 7, 'timeout');
  assert.equal(settled.released, true);
  const after = book.inspect('credit');
  assert.equal(after.noted, 0);
  assert.equal(after.historical, 0);
  assert.ok(after.room >= before.room);
  assert.ok(after.rawBudget > before.rawBudget);
  assert.ok(after.budget >= USABLE_RESPONSE);
  const small = admissionCost({
    pluginId: 'credit',
    correlationId: 8,
    payload: 'ok',
  });
  assert.equal(book.admit({
    childId: 'credit',
    correlationId: 8,
    held: small.held,
    reservation: small.reservation,
    replyBytes: USABLE_RESPONSE,
  }).decision, 'admitted');
  cover(book, 'credit', USABLE_RESPONSE);
  assert.ok(book.window('credit') >= USABLE_RESPONSE);
  assert.equal(book.headroom('credit'), small.reservation);
  book.settle('credit', 8, 'timeout');
  assert.equal(book.headroom('credit'), 0);
  assertAccount(book);
});

test('a completed call may keep a floor and the floor still leaves a usable grant', () => {
  const { book } = tightBook();
  const cost = admissionCost({ pluginId: 'credit', correlationId: 3, payload: 'x'.repeat(5800) });
  assert.equal(book.admit({
    childId: 'credit',
    correlationId: 3,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: USABLE_RESPONSE,
  }).decision, 'admitted');
  book.settle('credit', 3, 'complete');
  const view = book.inspect('credit');
  assert.equal(view.historical, cost.reservation);
  assert.equal(view.noted, cost.reservation);
  assert.ok(view.rawBudget < USABLE_RESPONSE, JSON.stringify(view));
  assert.ok(view.budget >= USABLE_RESPONSE, JSON.stringify(view));
  cover(book, 'credit', USABLE_RESPONSE);
  assert.ok(book.window('credit') >= USABLE_RESPONSE);
  assertAccount(book);
});

test('a quiet child is flushed up to the withheld window', () => {
  const book = createCreditBook({ globalCap: 80_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 80_000, pending: 1 }).ok, true);
  book.replenish('a');
  const full = book.window('a');
  const spent = Math.floor(full / 4);
  assert.equal(book.spend('a', spent), spent);
  assert.equal(book.release('a', spent).released, spent);
  assert.equal(book.replenish('a').credit, 0);
  assert.equal(book.flush('a').credit, spent);
  assert.equal(book.window('a'), full);
  assertAccount(book);
});

test('a total pause is not resumed by the global read rule', () => {
  const book = createCreditBook({ globalCap: 20_000, pending: 1 });
  book.addChild({ id: 'a', ceiling: 20_000, pending: 1 });
  assert.equal(book.pause('a', 'total'), true);
  assert.deepEqual(book.considerResume(), { resumed: [], faulted: [] });
  assert.equal(book.paused('a'), true);
});

test('a rejected call does not become headroom', () => {
  const book = createCreditBook({ globalCap: 80_000, pending: 1 });
  book.addChild({ id: 'a', ceiling: 20_000, pending: 1 });
  const rejected = book.admit({
    childId: 'a',
    correlationId: 1,
    held: 4,
    reservation: 20_001,
    replyBytes: 1,
  });
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.reason, 'total-cap');
  assert.equal(book.headroom('a'), 0);
  assert.equal(book.inspect('a').held, 0);
  assertAccount(book);
});

test('a second child is refused when it cannot be promised usable credit', () => {
  const slot = admissionSlot();
  const usable = USABLE_RESPONSE;
  const globalCap = slot + usable + 100;
  const book = createCreditBook({ globalCap, pending: 1, admitSlot: slot });
  const first = book.addChild({ id: 'a', ceiling: globalCap, pending: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.promised, usable);
  const second = book.addChild({ id: 'b', ceiling: globalCap, pending: 1 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'spawn-rejected');
  cover(book, 'a', usable);
  assert.ok(book.window('a') >= usable);
  assertAccount(book);
});

test('children added together can each obtain usable credit', () => {
  const book = createCreditBook({ globalCap: 200_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 80_000, pending: 1 }).ok, true);
  assert.equal(book.addChild({ id: 'b', ceiling: 80_000, pending: 1 }).ok, true);
  cover(book, 'a', book.promised('a'));
  cover(book, 'b', book.promised('b'));
  assert.ok(book.window('a') >= book.promised('a'));
  assert.ok(book.window('b') >= book.promised('b'));
  assertAccount(book);
});

test('a globally paused child resumes when a bounded read fits above the low water', () => {
  // Review evidence: buffered 47350 against a 51616 ceiling, empty framer,
  // 1708 acknowledgement bytes queued. A full read of 4096 fits.
  // 47350 is above half of 51616, so a low-water gate would leave the child paused.
  const cap = 51_616;
  const buffered = 47_350;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  assert.equal(book.addChild({ id: 'credit', ceiling: 1024 * 1024, pending: 1 }).ok, true);
  assert.equal(book.setShared(buffered), true);
  assert.equal(book.pause('credit', 'global'), true);
  assert.equal(book.setKernelUnread('credit', 1708), true);
  assert.ok(buffered > cap / 2);
  assert.ok(buffered + book.readBytes <= cap);
  const resumed = book.considerResume();
  assert.deepEqual(resumed.faulted, []);
  assert.deepEqual(resumed.resumed, ['credit']);
  assert.equal(book.paused('credit'), false);
  assert.deepEqual(book.considerResume().resumed, []);
});

test('a paused child is not resumed on a short kernel tail that is smaller than C', () => {
  const cap = 51_616;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  book.addChild({ id: 'credit', ceiling: 1024 * 1024, pending: 1 });
  const buffered = 49_000;
  book.setShared(buffered);
  book.pause('credit', 'global');
  book.setKernelUnread('credit', 1708);
  assert.ok(buffered + 1708 <= cap);
  assert.ok(buffered + book.readBytes > cap);
  assert.deepEqual(book.considerResume().resumed, []);
  assert.equal(book.paused('credit'), true);
});

test('releasing room resumes a globally paused child once the bounded read fits', () => {
  const cap = 51_616;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  book.addChild({ id: 'credit', ceiling: 1024 * 1024, pending: 1 });
  book.setShared(50_000);
  book.pause('credit', 'global');
  assert.deepEqual(book.considerResume().resumed, []);
  const released = book.releaseShared(50_000 - 47_350);
  assert.equal(released.released, 50_000 - 47_350);
  assert.deepEqual(released.resumed, ['credit']);
  assert.equal(book.paused('credit'), false);
});

test('an undrainable open line is faulted and a sibling with room resumes', () => {
  const cap = 10_000;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  assert.equal(book.addChild({ id: 'partial', ceiling: 1024 * 1024, pending: 1 }).ok, true);
  assert.equal(book.addChild({ id: 'credit', ceiling: 1024 * 1024, pending: 1 }).ok, true);
  assert.equal(book.retain('partial', 7000), true);
  assert.equal(book.setOpenPartial('partial', 7000), true);
  book.pause('partial', 'global');
  book.pause('credit', 'global');
  const result = book.considerResume();
  assert.deepEqual(result.faulted, ['partial']);
  assert.deepEqual(result.resumed, ['credit']);
  assert.equal(book.paused('credit'), false);
  assertAccount(book);
});

test('drainable bytes are not a fault; the next release can open the read', () => {
  const cap = 10_000;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  book.addChild({ id: 'partial', ceiling: 1024 * 1024, pending: 1 });
  book.retain('partial', 100);
  book.setOpenPartial('partial', 100);
  book.setShared(9000);
  book.pause('partial', 'global');
  const held = book.considerResume();
  assert.deepEqual(held.faulted, []);
  assert.deepEqual(held.resumed, []);
  const opened = book.releaseShared(9000 - (cap - book.readBytes - 100));
  assert.deepEqual(opened.faulted, []);
  assert.deepEqual(opened.resumed, ['partial']);
});

test('a missing kernel probe does not resume or fault', () => {
  const book = createCreditBook({ globalCap: 20_000, pending: 1 });
  book.addChild({ id: 'a', ceiling: 20_000, pending: 1 });
  book.pause('a', 'global');
  book.setKernelUnread('a', null);
  assert.deepEqual(book.considerResume(), { resumed: [], faulted: [] });
  assert.equal(book.paused('a'), true);
});

test('a deferred reply resumes a global pause without waiting for a new read', () => {
  const cap = 8000;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  book.addChild({ id: 'a', ceiling: 1024 * 1024, pending: 1 });
  book.setShared(7000);
  book.pause('a', 'global');
  assert.ok(7000 + book.readBytes > cap);
  assert.deepEqual(book.considerResume().resumed, []);
  book.setDeferred('a', 20);
  assert.deepEqual(book.considerResume().resumed, ['a']);
});

test('a call that arrives after a grant is checked against the full reservation', () => {
  const { book, childCeiling } = tightBook();
  const granted = book.replenish('credit');
  assert.equal(granted.credit, 6832);
  assert.equal(book.window('credit'), 6832);
  const cost = admissionCost({
    pluginId: 'credit',
    correlationId: 7,
    payload: 'x'.repeat(5800),
  });
  assert.equal(cost.lineBytes, 5874);
  assert.equal(cost.held, 9);
  assert.equal(cost.reservation, 5965);
  assert.ok(book.window('credit') + cost.lineBytes + cost.held > childCeiling);
  const decision = book.admit({
    childId: 'credit',
    correlationId: 7,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: USABLE_RESPONSE,
  });
  assert.equal(decision.decision, 'rejected');
  assert.equal(decision.reason, 'total-cap');
  assert.equal(book.inspect('credit').held, 0);
  assert.equal(book.headroom('credit'), 0);
  assert.equal(book.window('credit'), 6832);
  const small = admissionCost({
    pluginId: 'credit',
    correlationId: 8,
    payload: 'x',
  });
  assert.ok(book.window('credit') + small.reservation <= childCeiling);
  const later = book.admit({
    childId: 'credit',
    correlationId: 8,
    held: small.held,
    reservation: small.reservation,
    replyBytes: USABLE_RESPONSE,
  });
  assert.equal(later.decision, 'admitted');
  assert.equal(book.inspect('credit').held, small.held);
  assertAccount(book);
});

test('deferred growth past the child ceiling does not resume a global pause', () => {
  const book = createCreditBook({ globalCap: 100_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 5000, pending: 1 }).ok, true);
  assert.equal(book.retain('a', 4000), true);
  assert.equal(book.setShared(93_000), true);
  assert.equal(book.pause('a', 'global'), true);
  assert.equal(book.setDeferred('a', 6000), true);
  const over = book.considerResume();
  assert.deepEqual(over.faulted, []);
  assert.deepEqual(over.resumed, []);
  assert.equal(book.paused('a'), true);
  assert.equal(book.setDeferred('a', 4500), true);
  const fit = book.considerResume();
  assert.deepEqual(fit.faulted, []);
  assert.deepEqual(fit.resumed, ['a']);
  assert.equal(book.paused('a'), false);
});

test('mixed ceilings reserve each peer its own promised floor', () => {
  const book = createCreditBook({ globalCap: 7000, pending: 1 });
  const first = book.addChild({ id: 'a', ceiling: 7000, pending: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.promised, USABLE_RESPONSE);
  const cost = admissionCost({
    pluginId: 'a',
    correlationId: 1,
    payload: 'x',
  });
  const admitted = book.admit({
    childId: 'a',
    correlationId: 1,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: USABLE_RESPONSE,
  });
  assert.equal(admitted.decision, 'admitted');
  const second = book.addChild({ id: 'b', ceiling: 2000, pending: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.promised, 791);
  for (let i = 0; i < 4; i++) {
    book.replenish('a');
    book.flush('a');
    book.replenish('b');
    book.flush('b');
  }
  assert.ok(book.window('a') >= USABLE_RESPONSE);
  assert.ok(book.window('b') >= 791);
  assertAccount(book);
});

test('a readable open line is not faulted because a sibling prefix blocks one read', () => {
  const cap = 10_000;
  const book = createCreditBook({ globalCap: cap, pending: 1 });
  assert.equal(book.addChild({ id: 'first', ceiling: cap, pending: 1 }).ok, true);
  assert.equal(book.addChild({ id: 'second', ceiling: cap, pending: 1 }).ok, true);
  book.replenish('first');
  book.flush('first');
  book.replenish('second');
  book.flush('second');
  assert.ok(book.window('first') >= 4000);
  assert.ok(book.window('second') >= 4000);
  assert.equal(book.spend('first', 4000), 4000);
  assert.equal(book.spend('second', 4000), 4000);
  assert.equal(book.setOpenPartial('first', 4000), true);
  assert.equal(book.setOpenPartial('second', 4000), true);
  assert.equal(book.pause('first', 'global'), true);
  assert.equal(book.setKernelUnread('second', 1), true);
  assert.equal(book.inspect('first').buffered, 8000);
  const result = book.considerResume();
  assert.deepEqual(result.faulted, []);
  assert.deepEqual(result.resumed, []);
  assert.equal(book.paused('first'), true);
  assert.ok(book.inspect('first'));
  assert.ok(book.inspect('second'));
  assert.equal(book.paused('second'), false);
});

test('a paused child resumes when the read spends credit the reply already holds', () => {
  const book = createCreditBook({ globalCap: 20_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 14_000, pending: 1 }).ok, true);
  const cost = admissionCost({ pluginId: 'a', correlationId: 1, payload: 'x' });
  assert.equal(book.admit({
    childId: 'a',
    correlationId: 1,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: 10_000,
  }).decision, 'admitted');
  const granted = book.replenish('a');
  assert.equal(granted.credit, 12_787);
  assert.equal(book.spend('a', 4000), 4000);
  assert.equal(book.setOpenPartial('a', 4000), true);
  assert.equal(book.inspect('a').held, 4004);
  assert.equal(book.window('a'), 8787);
  assert.equal(book.setShared(20_000), true);
  assert.equal(book.pause('a', 'global'), true);
  assert.deepEqual(book.considerResume().resumed, []);
  const released = book.releaseShared(20_000);
  assert.equal(released.released, 20_000);
  assert.deepEqual(released.faulted, []);
  assert.deepEqual(released.resumed, ['a']);
  assert.equal(book.paused('a'), false);
  assertAccount(book);
});

test('faulting the tight pending child does not strand a sibling reply', () => {
  const book = createCreditBook({ globalCap: 100_000 });
  assert.equal(book.addChild({ id: 'a', ceiling: 100_000 }).ok, true);
  assert.equal(book.addChild({ id: 'b', ceiling: 100_000, pending: 1 }).ok, true);
  const cost = admissionCost({ pluginId: 'a', correlationId: 1, payload: 'x' });
  assert.equal(book.admit({
    childId: 'a',
    correlationId: 1,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: 80_000,
  }).decision, 'admitted');
  assert.equal(book.retain('b', 96_000), true);
  assert.equal(book.setOpenPartial('b', 96_000), true);
  const faulted = book.considerResume();
  assert.deepEqual(faulted.faulted, ['b']);
  assert.equal(book.inspect('b'), null);
  for (let i = 0; i < 4; i++) {
    book.replenish('a');
    book.flush('a');
  }
  assert.ok(book.window('a') >= 80_000, JSON.stringify(book.inspect('a')));
  assertAccount(book);
});

test('a sibling spawn cannot take the credit an admitted reply still needs', () => {
  const book = createCreditBook({ globalCap: 14_000, pending: 1 });
  assert.equal(book.addChild({ id: 'a', ceiling: 14_000, pending: 1 }).ok, true);
  const cost = admissionCost({ pluginId: 'a', correlationId: 1, payload: 'x' });
  assert.equal(book.admit({
    childId: 'a',
    correlationId: 1,
    held: cost.held,
    reservation: cost.reservation,
    replyBytes: 10_000,
  }).decision, 'admitted');
  const sibling = book.addChild({ id: 'b', ceiling: 14_000, pending: 1 });
  assert.equal(sibling.ok, false);
  assert.equal(sibling.reason, 'spawn-rejected');
  for (let i = 0; i < 4; i++) {
    book.replenish('a');
    book.flush('a');
  }
  assert.ok(book.window('a') >= 10_000, JSON.stringify(book.inspect('a')));
  assert.equal(book.promised('b'), 0);
  assertAccount(book);
});

test('a later call cannot take the credit an earlier reply still needs', () => {
  const book = createCreditBook({ globalCap: 14_000 });
  assert.equal(book.addChild({ id: 'a', ceiling: 14_000 }).ok, true);
  const first = admissionCost({ pluginId: 'a', correlationId: 1, payload: 'x' });
  assert.equal(book.admit({
    childId: 'a',
    correlationId: 1,
    held: first.held,
    reservation: first.reservation,
    replyBytes: 10_000,
  }).decision, 'admitted');
  const second = admissionCost({
    pluginId: 'a',
    correlationId: 2,
    payload: 'x'.repeat(6000),
  });
  assert.equal(book.admit({
    childId: 'a',
    correlationId: 2,
    held: second.held,
    reservation: second.reservation,
    replyBytes: 100,
  }).decision, 'admitted');
  for (let i = 0; i < 4; i++) {
    book.replenish('a');
    book.flush('a');
  }
  assert.ok(book.window('a') >= 10_000 + 100, JSON.stringify(book.inspect('a')));
  assertAccount(book);
});

test('keepBytes withholds only the excess over the shared hole', () => {
  const slot = admissionSlot();
  const hole = slot;
  assert.equal(keepBytes(6990, hole, 32, 0, slot), 0);
  const raw = keepBytes(6990, hole, 32, 5965, slot);
  assert.equal(raw, 5965 - hole);
  assert.ok(capKeep(6990, raw, USABLE_RESPONSE) < raw);
  assert.ok(6990 - capKeep(6990, raw, USABLE_RESPONSE) >= USABLE_RESPONSE);
});

test('admitted replies stay sendable across spawns, admits, and releases', () => {
  const slot = admissionSlot();
  const usable = USABLE_RESPONSE;
  for (let seed = 1; seed <= 48; seed++) {
    const rng = mulberry32(seed);
    const globalCap = slot + usable * 4 + Math.floor(rng() * 80_000);
    const book = createCreditBook({ globalCap, pending: 1, admitSlot: slot });
    const children = [];
    let seq = 1;
    const needOf = (child) => child.replies.reduce((sum, row) => sum + row.reply, 0);
    const remainingOf = (child) => Math.max(0, needOf(child) - child.received);
    const dropFaulted = (ids) => {
      const doomed = new Set(ids);
      for (let i = children.length - 1; i >= 0; i--) {
        if (doomed.has(children[i].id)) children.splice(i, 1);
      }
    };
    const assertSendable = () => {
      for (const child of children) {
        const need = remainingOf(child);
        if (need > 0) cover(book, child.id, need);
      }
      for (const child of children) {
        const need = remainingOf(child);
        if (need <= 0) continue;
        assert.ok(book.window(child.id) >= need, JSON.stringify({
          seed,
          id: child.id,
          need,
          inspect: book.inspect(child.id),
        }));
      }
      assertAccount(book);
    };
    for (let step = 0; step < 16; step++) {
      const roll = rng();
      if (children.length === 0 || (children.length < 4 && roll < 0.28)) {
        const id = `c${seq++}`;
        const ceiling = slot + 1 + Math.floor(rng() * Math.max(usable, Math.floor(globalCap / 2)));
        const pending = rng() < 0.5 ? 1 : 32;
        const added = book.addChild({ id, ceiling, pending });
        if (added.ok) children.push({ id, ceiling, replies: [], received: 0 });
        else assert.ok(added.reason === 'spawn-rejected' || added.reason === 'unsatisfiable', `seed ${seed}`);
      } else if (roll < 0.56) {
        const child = children[Math.floor(rng() * children.length)];
        const payload = Math.floor(rng() * 4000);
        const correlation = seq++;
        const cost = admissionCost({
          pluginId: child.id,
          correlationId: correlation,
          payload: 'x'.repeat(payload),
        });
        const reply = 1 + Math.floor(rng() * usable);
        const view = book.inspect(child.id);
        const decision = book.admit({
          childId: child.id,
          correlationId: correlation,
          held: cost.held,
          reservation: cost.reservation,
          replyBytes: reply,
        });
        if (decision.decision === 'admitted') child.replies.push({ correlation, reply });
        else {
          assert.equal(decision.reason, 'total-cap', `seed ${seed}`);
          assert.equal(book.inspect(child.id).held, view.held, `seed ${seed}`);
          assert.equal(book.headroom(child.id), view.noted, `seed ${seed}`);
        }
      } else if (roll < 0.74) {
        const owners = children.filter((child) => child.replies.length > 0);
        if (owners.length > 0) {
          const child = owners[Math.floor(rng() * owners.length)];
          const index = Math.floor(rng() * child.replies.length);
          const row = child.replies.splice(index, 1)[0];
          const owed = Math.max(0, row.reply - child.received);
          cover(book, child.id, owed);
          assert.ok(book.window(child.id) >= owed, `seed ${seed}`);
          const roomBefore = book.inspect(child.id).room;
          assert.equal(book.spend(child.id, owed), owed);
          child.received = Math.max(0, child.received - row.reply);
          book.release(child.id, owed);
          assert.ok(book.inspect(child.id).room >= roomBefore, `seed ${seed} release`);
          const outcome = rng() < 0.5 ? 'timeout' : 'complete';
          assert.equal(book.settle(child.id, row.correlation, outcome).released, true);
        }
      } else if (roll < 0.88) {
        for (const child of children) book.pause(child.id, 'global');
        const partial = children.find((child) => child.replies.length > 0 && book.window(child.id) > 0);
        if (partial) {
          const room = Math.min(book.window(partial.id), remainingOf(partial));
          const part = Math.min(room, 1 + Math.floor(rng() * Math.max(1, room)));
          const spent = book.spend(partial.id, part);
          partial.received += spent;
          if (spent > 0) book.setOpenPartial(partial.id, Math.min(spent, book.inspect(partial.id).held));
        }
        book.setShared(globalCap);
        const blocked = book.considerResume();
        assert.deepEqual(blocked.resumed, []);
        book.setShared(0);
        book.considerResume();
        const buffered = children.reduce((sum, child) => sum + book.inspect(child.id).held, 0);
        if (buffered + book.readBytes <= globalCap) {
          for (const child of children) {
            const view = book.inspect(child.id);
            const owed = Math.max(book.promised(child.id), remainingOf(child));
            const uncovered = Math.max(0, owed - view.window);
            if (view.held + book.readBytes + uncovered <= child.ceiling) {
              assert.equal(book.paused(child.id), false, `seed ${seed} resume ${child.id}`);
            }
          }
        }
      } else if (children.length >= 2) {
        const victim = children[Math.floor(rng() * children.length)];
        assert.equal(book.retain(victim.id, globalCap), true);
        const held = book.inspect(victim.id).held;
        assert.equal(book.setOpenPartial(victim.id, held), true);
        const faulted = book.considerResume();
        assert.ok(faulted.faulted.includes(victim.id), `seed ${seed} fault`);
        dropFaulted(faulted.faulted);
      }
      assertSendable();
    }
  }
});
