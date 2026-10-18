// T5c race battery. A case skips when its database, root, or PgBouncer admin
// connection is missing, so a direct-only checkout stays green. In CI the
// same gap fails the case. Cases share the fencing table, so they run one
// at a time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBounds } from './clock.mjs';
import { CADENCE_MS } from './control.mjs';
import { adminProbeReason, appProbeReason, raceSkip, rootProbeReason, runningInCi } from './support.mjs';
import { deathBeforeCommit } from './death-before-commit.mjs';
import { lostReply } from './lost-reply.mjs';
import { recoveryVsLiveCommit } from './recovery-vs-live-commit.mjs';
import { healthyLong } from './healthy-long.mjs';
import { stalledShutdown } from './stalled-shutdown.mjs';
import { HEARTBEAT_BOUND_MS, heartbeatBehindCommit } from './heartbeat-behind-commit.mjs';
import { saturatedPool } from './saturated-pool.mjs';
import { queuedPastLease } from './queued-past-lease.mjs';
import { secondExecutorTakeover } from './second-executor-takeover.mjs';
import { vacuityAuthority } from './vacuity-authority.mjs';

const ci = runningInCi();
const databaseReason = await appProbeReason();
const rootReason = await rootProbeReason();
const adminReason = await adminProbeReason();

function check(result) {
  assert.equal(result.pass, true, JSON.stringify(result.detail));
  assertBounds(result.detail.bounds);
}

function ready(reasons) {
  const missing = reasons.filter(Boolean);
  if (missing.length && ci) assert.fail(`CI harness incomplete: ${missing.join('; ')}`);
}

describe('T5c race battery', { concurrency: 1, timeout: 180_000 }, () => {
  test('death-before-commit', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    check(await deathBeforeCommit());
  });
  test('lost-reply', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    check(await lostReply());
  });
  test('recovery-vs-live-commit', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    check(await recoveryVsLiveCommit());
  });
  test('healthy-long', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    check(await healthyLong());
  });
  test('stalled shutdown fails the renewal-to-lock oracle', { skip: raceSkip([databaseReason], ci) }, async () => {
    ready([databaseReason]);
    const result = await stalledShutdown();
    assert.equal(result.pass, false, JSON.stringify(result.detail));
    assert.equal(result.detail.boundViolation, true);
    assert.ok(result.detail.renewals >= 1);
    assert.equal(result.detail.bound, CADENCE_MS);
    assert.ok(result.detail.lastRenewalToLockMs > CADENCE_MS);
  });
  test('heartbeat-behind-commit', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    const result = await heartbeatBehindCommit();
    check(result);
    assert.equal(result.detail.boundMs, HEARTBEAT_BOUND_MS);
    assert.ok(result.detail.elapsedMs <= result.detail.boundMs);
  });
  test('saturated-pool', { skip: raceSkip([databaseReason, rootReason, adminReason], ci) }, async () => {
    ready([databaseReason, rootReason, adminReason]);
    check(await saturatedPool());
  });
  test('queued-past-lease', { skip: raceSkip([databaseReason], ci) }, async () => {
    ready([databaseReason]);
    check(await queuedPastLease());
  });
  test('second-executor-takeover', { skip: raceSkip([databaseReason, rootReason], ci) }, async () => {
    ready([databaseReason, rootReason]);
    check(await secondExecutorTakeover());
  });
  test('vacuity-authority fails when the ACTIVE predicate is removed', {
    skip: raceSkip([databaseReason, rootReason], ci),
  }, async () => {
    ready([databaseReason, rootReason]);
    const result = await vacuityAuthority();
    assert.equal(result.real.pass, true, JSON.stringify(result.real.detail));
    assert.equal(result.open.pass, false, JSON.stringify(result.open.detail));
    assert.equal(result.open.detail.executor.status, 'ABANDONED');
    assert.equal(result.open.detail.executor.effects, 1);
    assert.equal(result.open.detail.sweeper.status, 'COMMITTED');
    assert.equal(result.open.detail.sweeper.effects, 1);
    assertBounds(result.real.detail.bounds);
    assertBounds(result.open.detail.bounds);
  });
});
