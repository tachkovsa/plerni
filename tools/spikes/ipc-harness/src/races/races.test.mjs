// T5c race battery. Skips without a harness database so a checkout stays green.
// Cases share the fencing table, so they run one at a time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dbConfigured } from '../supervisor.mjs';
import { assertBounds, COMPLETION_BOUND_MS } from './clock.mjs';
import { deathBeforeCommit } from './death-before-commit.mjs';
import { lostReply } from './lost-reply.mjs';
import { recoveryVsLiveCommit } from './recovery-vs-live-commit.mjs';
import { healthyLong } from './healthy-long.mjs';
import { heartbeatBehindCommit } from './heartbeat-behind-commit.mjs';
import { saturatedPool } from './saturated-pool.mjs';
import { queuedPastLease } from './queued-past-lease.mjs';
import { secondExecutorTakeover } from './second-executor-takeover.mjs';
import { vacuityAuthority } from './vacuity-authority.mjs';

const skip = dbConfigured() ? false : 'no harness database in the environment';

function check(result) {
  assert.equal(result.pass, true, JSON.stringify(result.detail));
  assertBounds(result.detail.bounds);
}

describe('T5c race battery', { concurrency: 1, skip }, () => {
  test('death-before-commit', async () => {
    check(await deathBeforeCommit());
  });
  test('lost-reply', async () => {
    check(await lostReply());
  });
  test('recovery-vs-live-commit', async () => {
    check(await recoveryVsLiveCommit());
  });
  test('healthy-long', async () => {
    check(await healthyLong());
  });
  test('heartbeat-behind-commit', async () => {
    const result = await heartbeatBehindCommit();
    check(result);
    assert.equal(result.detail.boundMs, COMPLETION_BOUND_MS);
    assert.ok(result.detail.elapsedMs <= result.detail.boundMs);
  });
  test('saturated-pool', async () => {
    check(await saturatedPool());
  });
  test('queued-past-lease', async () => {
    check(await queuedPastLease());
  });
  test('second-executor-takeover', async () => {
    check(await secondExecutorTakeover());
  });
  test('vacuity-authority fails when the ACTIVE predicate is removed', async () => {
    const result = await vacuityAuthority();
    assert.equal(result.pass, false);
    assert.equal(result.exploit, true, JSON.stringify(result.detail));
    assert.equal(result.realHeld, true, JSON.stringify(result.detail));
    assertBounds(result.detail.bounds);
  });
});
