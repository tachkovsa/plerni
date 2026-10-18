import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBounds, bounded, deferred, manualClock, setStepCanceller, steps } from './clock.mjs';

test('a 25s advance fires every 5s cadence tick in order', async () => {
  const start = Date.UTC(2026, 0, 1);
  const clock = manualClock(start);
  const seen = [];
  clock.setInterval(async () => {
    seen.push(clock.millis());
  }, 5000);
  await clock.advance(25_000);
  assert.deepEqual(seen, [
    start + 5000,
    start + 10_000,
    start + 15_000,
    start + 20_000,
    start + 25_000,
  ]);
  assert.equal(clock.millis(), start + 25_000);
});

test('a cleared timer does not fire and the clock does not move backwards', async () => {
  const clock = manualClock(0);
  const timer = clock.setInterval(() => {
    throw new Error('cleared timer fired');
  }, 1000);
  clock.clearInterval(timer);
  await clock.advance(5000);
  assert.equal(clock.millis(), 5000);
  await assert.rejects(() => clock.advance(-1), /backwards/);
});

test('bounded records a finished wait and rejects a hung one', async () => {
  const done = await bounded(() => Promise.resolve('ok'), 1000, 'fast');
  assert.equal(done.value, 'ok');
  assert.ok(done.elapsedMs <= done.boundMs);
  await assert.rejects(
    () => bounded(() => new Promise(() => {}), 30, 'hung'),
    /deadline exceeded: hung/,
  );
});

test('a step deadline cancels in-flight work and awaits cleanup before rejecting', async () => {
  const order = [];
  const gate = deferred();
  setStepCanceller(async () => {
    order.push('cancel');
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push('cleaned');
    gate.resolve('done');
  });
  try {
    const timing = steps(30);
    await assert.rejects(
      () => timing.run(() => gate.promise.then((value) => {
        order.push(`work:${value}`);
        return value;
      }), 'blocked'),
      /deadline exceeded: blocked \(bound 30ms\)/,
    );
    assert.deepEqual(order, ['cancel', 'cleaned', 'work:done']);
  } finally {
    setStepCanceller(null);
  }
});

test('steps.run awaits the default canceller before rejecting', () => {
  const source = readFileSync(new URL('./clock.mjs', import.meta.url), 'utf8');
  const cancel = source.slice(source.indexOf('async function cancelStep'), source.indexOf('export const COMPLETION_BOUND_MS'));
  assert.match(cancel, /await abortInFlight\(\)/);
  const run = source.slice(source.indexOf('async run('), source.indexOf('export function assertBounds'));
  assert.match(run, /await cancelStep\(\);\s*await task;/);
  assert.equal(run.includes('onTimeout'), false);
});

test('steps keeps a fenced outcome inside the bound and assertBounds checks it', async () => {
  const timing = steps(1000);
  await assert.rejects(
    () => timing.run(() => Promise.reject(Object.assign(new Error('fenced'), { fenced: true })), 'commit'),
    /fenced/,
  );
  assert.equal(timing.bounds.length, 1);
  assert.equal(timing.bounds[0].label, 'commit');
  assert.ok(timing.bounds[0].elapsedMs <= timing.bounds[0].boundMs);
  assertBounds(timing.bounds);
  timing.bounds.push({ label: 'late', elapsedMs: 5, boundMs: 1 });
  assert.throws(() => assertBounds(timing.bounds), /late/);
});
