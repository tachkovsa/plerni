import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VACUOUS_COMMIT_SQL, VACUOUS_SWEEP_SQL } from './control.mjs';
import { raceSkip, runningInCi } from './support.mjs';

const PRODUCTION_COMMIT = "UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS locked_at";
const PRODUCTION_SWEEP = "UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING id";

test('vacuity statements drop the ACTIVE predicate and the harness sets no session GUC', () => {
  const control = readFileSync(new URL('./control.mjs', import.meta.url), 'utf8');
  const authority = readFileSync(new URL('../authority.mjs', import.meta.url), 'utf8');
  assert.equal(VACUOUS_COMMIT_SQL.includes("status = 'ACTIVE'"), false);
  assert.equal(VACUOUS_SWEEP_SQL.includes("status = 'ACTIVE'"), false);
  assert.equal(authority.includes(PRODUCTION_COMMIT), true);
  assert.equal(authority.includes(PRODUCTION_SWEEP), true);
  assert.match(authority, /const CADENCE_MS = 5000/);
  assert.match(authority, /const LEASE_MS = 20000/);
  assert.equal(control.includes('set_config'), false);
  assert.equal(control.includes('raceCommit'), false);
  assert.equal(control.includes('raceSweep'), false);
  for (const word of ['requireActive', 'renewBehindLock', 'afterLock', 'afterCommit', 'openHarnessClient', 'committedUpdateSql']) {
    assert.equal(authority.includes(word), false, word);
  }
});

test('a missing race service skips locally and fails closed in CI', () => {
  assert.equal(raceSkip([null], false), false);
  assert.equal(raceSkip(['no root connection configured'], false), 'no root connection configured');
  assert.equal(
    raceSkip(['no root connection configured', 'no PgBouncer admin connection configured'], false),
    'no root connection configured; no PgBouncer admin connection configured',
  );
  assert.equal(raceSkip(['no root connection configured'], true), false);
});

test('any CI marker except empty, 0, or false fails closed', () => {
  assert.equal(runningInCi({ CI: '1' }), true);
  assert.equal(runningInCi({ CI: 'true' }), true);
  assert.equal(runningInCi({ CI: '' }), false);
  assert.equal(runningInCi({}), false);
  assert.equal(runningInCi({ CI: '0' }), false);
  assert.equal(runningInCi({ CI: 'false' }), false);
  assert.equal(runningInCi({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(runningInCi({ GITHUB_ACTIONS: '1' }), true);
  assert.equal(runningInCi({ GITHUB_ACTIONS: '' }), false);
  assert.equal(runningInCi({ CI: 'false', GITHUB_ACTIONS: 'true' }), true);
});
