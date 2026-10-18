// T5c race battery. Each case probes the datasource it actually uses, before
// the case runs. A missing connection skips that case locally and fails it
// in CI. Cases share the fencing table, so they run one at a time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBounds } from './clock.mjs';
import { CADENCE_MS, LEASE_MS, abortInFlight } from './control.mjs';
import { adminProbeReason, commitReportHeld, directProbeReason, pooledProbeReason, raceSkip, rootProbeReason, runningInCi } from './support.mjs';
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
import { commitVsRevoke, commitVsRevokeVacuity } from './commit-vs-revoke.mjs';

const ci = runningInCi();
const directReason = await directProbeReason();
const pooledReason = await pooledProbeReason();
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

async function runRace(work) {
  try {
    return await work();
  } finally {
    await abortInFlight();
  }
}

describe('T5c race battery', { concurrency: 1, timeout: 180_000 }, () => {
  test('death-before-commit', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    check(await runRace(() => deathBeforeCommit()));
  });
  test('lost-reply', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    check(await runRace(() => lostReply()));
  });
  test('recovery-vs-live-commit', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    check(await runRace(() => recoveryVsLiveCommit()));
  });
  test('healthy-long', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    const result = await runRace(() => healthyLong());
    check(result);
    assert.ok(result.detail.positive.wallMs >= 25_000);
    assert.ok(result.detail.positive.wallMs <= 30_000);
    assert.ok(result.detail.positive.wallMs > LEASE_MS);
    assert.ok(result.detail.suppressed.abandonedAtMs >= LEASE_MS);
  });
  test('stalled shutdown fails the renewal-to-lock oracle', { skip: raceSkip([directReason], ci) }, async () => {
    ready([directReason]);
    const result = await runRace(() => stalledShutdown());
    assert.equal(result.pass, false, JSON.stringify(result.detail));
    assert.equal(result.detail.committed, true);
    assert.equal(result.detail.boundViolation, true);
    assert.ok(result.detail.renewals >= 1);
    assert.equal(result.detail.bound, CADENCE_MS);
    assert.ok(Number.isFinite(result.detail.lastRenewalToLockMs));
    assert.ok(result.detail.lastRenewalToLockMs > CADENCE_MS);
    assert.ok(Number.isFinite(result.detail.lockWaitMs) && result.detail.lockWaitMs >= 0);
    assertBounds(result.detail.bounds);
  });
  test('heartbeat-behind-commit', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    const result = await runRace(() => heartbeatBehindCommit());
    check(result);
    assert.equal(result.detail.boundMs, HEARTBEAT_BOUND_MS);
    assert.ok(result.detail.elapsedMs <= result.detail.boundMs);
  });
  test('saturated-pool', { skip: raceSkip([directReason, pooledReason, rootReason, adminReason], ci) }, async () => {
    ready([directReason, pooledReason, rootReason, adminReason]);
    const result = await runRace(() => saturatedPool());
    check(result);
    assert.equal(result.detail.executors, 10);
    for (const report of result.detail.reports) {
      assert.ok(report.holdMs > LEASE_MS);
      assert.equal(report.boundViolation, false);
      assert.ok(report.lastRenewalToLockMs <= CADENCE_MS);
    }
  });
  test('queued-past-lease', { skip: raceSkip([directReason], ci) }, async () => {
    ready([directReason]);
    check(await runRace(() => queuedPastLease()));
  });
  test('second-executor-takeover', { skip: raceSkip([directReason, rootReason], ci) }, async () => {
    ready([directReason, rootReason]);
    check(await runRace(() => secondExecutorTakeover()));
  });
  test('commit-vs-revoke', { skip: raceSkip([directReason, pooledReason], ci) }, async () => {
    ready([directReason, pooledReason]);
    const result = await runRace(() => commitVsRevoke());
    check(result);
    assert.equal(result.detail.revokerWaitedOnLock, true);
    assert.equal(result.detail.waitEvent, 'transactionid');
    assert.equal(result.detail.winners, 1);
  });
  test('commit-vs-revoke overlap oracle fails when the revoker does not wait', {
    skip: raceSkip([directReason, pooledReason], ci),
  }, async () => {
    ready([directReason, pooledReason]);
    const result = await runRace(() => commitVsRevokeVacuity());
    assert.equal(result.pass, false, JSON.stringify(result.detail));
    assert.equal(result.detail.cancelWon, true);
    assert.equal(result.detail.fenced, true);
    assert.equal(result.detail.status, 'CANCELLED');
    assert.equal(result.detail.revokerWaitedOnLock, false);
    assertBounds(result.detail.bounds);
  });
  test('vacuity-authority fails when the ACTIVE predicate is removed', {
    skip: raceSkip([directReason, rootReason], ci),
  }, async () => {
    ready([directReason, rootReason]);
    const result = await runRace(() => vacuityAuthority());
    assert.equal(result.real.pass, true, JSON.stringify(result.real.detail));
    assert.equal(commitReportHeld(result.real.detail.executor), true, JSON.stringify(result.real.detail.executor));
    assert.equal(result.open.pass, false, JSON.stringify(result.open.detail));
    assert.equal(result.open.detail.executor.status, 'ABANDONED');
    assert.equal(result.open.detail.executor.effects, 1);
    assert.equal(result.open.detail.sweeper.status, 'COMMITTED');
    assert.equal(result.open.detail.sweeper.effects, 1);
    assertBounds(result.real.detail.bounds);
    assertBounds(result.open.detail.bounds);
  });
});
