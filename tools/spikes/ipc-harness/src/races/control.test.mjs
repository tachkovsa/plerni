import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { committedSql, renewSql, sweepSql } from './control.mjs';

const PRODUCTION_COMMIT = "UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS locked_at";
const PRODUCTION_RENEW = "UPDATE fencing_authority SET heartbeat_at = clock_timestamp() WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS renewed_at";
const PRODUCTION_SWEEP = "UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING id";

test('harness SQL defaults to the production authority statements', () => {
  assert.equal(committedSql(), PRODUCTION_COMMIT);
  assert.equal(renewSql(), PRODUCTION_RENEW);
  assert.equal(sweepSql(), PRODUCTION_SWEEP);
  assert.equal(
    sweepSql({ clocked: true, scoped: true }),
    "UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < $2::timestamptz - make_interval(secs => $1) AND id = $3 RETURNING id",
  );
  assert.equal(committedSql({ tag: 'race-exec-live' }), `${PRODUCTION_COMMIT} /* race-exec-live */`);
  assert.equal(committedSql({ requireActive: false }).includes("status = 'ACTIVE'"), false);
  assert.equal(sweepSql({ requireActive: false }).includes("status = 'ACTIVE'"), false);
  assert.throws(() => committedSql({ tag: '1; drop' }), /sql tag/);
});

test('the production authority module has no race-harness parameters', () => {
  const source = readFileSync(new URL('../authority.mjs', import.meta.url), 'utf8');
  for (const word of ['requireActive', 'renewBehindLock', 'afterLock', 'afterCommit', 'openHarnessClient', 'committedUpdateSql']) {
    assert.equal(source.includes(word), false, word);
  }
});
