import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualClock } from './clock.mjs';

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
