// supervisor.test.mjs — deterministic B4/B5/B6 checks. Performance windows stay in the spike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b4 } from './cases/b4-bounds.mjs';
import { b5 } from './cases/b5-crash.mjs';
import { b2 } from './cases/b2-fencing.mjs';
import { tripCaps } from './cases/b3-backpressure.mjs';
import { hostileBattery } from './cases/b6-mux-identity.mjs';
import { preflight } from './measure.mjs';
import { dbConfigured } from './supervisor.mjs';

test('preflight records a validity bit', () => {
  const env = preflight();
  assert.equal(typeof env.valid, 'boolean');
  assert.equal(typeof env.throttled, 'boolean');
});

test('B4 bounds', { timeout: 20_000 }, async () => {
  const result = await b4();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B5 crash typed error', { timeout: 20_000 }, async () => {
  const result = await b5({ requireDb: dbConfigured() });
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B3 caps trip', { timeout: 20_000 }, async () => {
  const result = await tripCaps();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B6 hostile battery rejects forged identity', { timeout: 20_000 }, async () => {
  const result = await hostileBattery({ stampIdentity: true });
  assert.equal(result.pass, true, JSON.stringify(result.checks));
});

test('B6 vacuity without identity stamping fails', { timeout: 20_000 }, async () => {
  const result = await hostileBattery({ stampIdentity: false });
  assert.equal(result.pass, false);
  assert.equal(result.checks.forged, false);
  assert.equal(result.checks.collision, false);
});

test('B2 fencing labels', { timeout: 20_000, skip: dbConfigured() ? false : 'no harness database' }, async () => {
  const result = await b2();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});
