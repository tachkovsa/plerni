import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CADENCE_MS, VACUOUS_COMMIT_SQL, VACUOUS_SWEEP_SQL, abortInFlight, setKillerOpener } from './control.mjs';
import { recoveryRaceHeld } from './recovery-vs-live-commit.mjs';
import { commitReportHeld, directProbeReason, probeConnection, raceSkip, runningInCi } from './support.mjs';

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

test('abort destroys tracked sockets before a stalled killer and still returns', async () => {
  const order = [];
  const victim = new pg.Client({
    host: 'localhost',
    port: 1,
    database: 'plerni',
    user: 'x',
    password: 'x',
    connectionTimeoutMillis: 200,
  });
  victim.connection = {
    stream: { destroy() { order.push('victim'); } },
  };
  let releaseConnect;
  const killer = {
    connection: {
      stream: {
        destroy() {
          order.push('killer');
          releaseConnect?.();
        },
      },
    },
    connect() {
      order.push('connect');
      return new Promise((resolve) => {
        releaseConnect = resolve;
      });
    },
    async query() {
      throw new Error('killer query is not required');
    },
    async end() {
      order.push('end');
    },
  };
  setKillerOpener(() => killer);
  const started = Date.now();
  try {
    await abortInFlight();
  } finally {
    setKillerOpener(null);
    await victim.end().catch(() => {});
  }
  assert.ok(order.indexOf('victim') >= 0);
  assert.ok(order.indexOf('victim') < order.indexOf('connect'));
  assert.ok(order.includes('killer'));
  assert.ok(Date.now() - started < 5000);
  const source = readFileSync(new URL('./control.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('export async function abortInFlight'),
    source.indexOf('export async function settleWithin'),
  );
  assert.ok(body.indexOf('destroy(client)') < body.indexOf('await cancelBackends()'));
  assert.match(source, /connectionTimeoutMillis: KILL_MS/);
  assert.match(source, /statement_timeout: KILL_MS/);
});

test('the recovery oracle accepts one winner and rejects a rewritten terminal row', () => {
  const executor = { committed: true, fenced: false, swept: false, status: 'COMMITTED', effects: 1 };
  const sweeper = { committed: false, fenced: true, swept: true, status: 'ABANDONED', effects: 0 };
  assert.equal(recoveryRaceHeld(executor, sweeper), true);
  assert.equal(recoveryRaceHeld({ ...executor, swept: true, status: 'ABANDONED' }, sweeper), false);
  assert.equal(recoveryRaceHeld(executor, {
    committed: true,
    fenced: false,
    swept: true,
    status: 'COMMITTED',
    effects: 1,
  }), false);
});

test('an unreachable app database skips locally and stays runnable in CI', async () => {
  const saved = {
    HARNESS_DIRECT_DSN: process.env.HARNESS_DIRECT_DSN,
    PLERNI_APP_PASSWORD: process.env.PLERNI_APP_PASSWORD,
  };
  process.env.HARNESS_DIRECT_DSN = 'postgresql://plerni_app:invalid@localhost:1/plerni';
  delete process.env.PLERNI_APP_PASSWORD;
  try {
    const reason = await directProbeReason();
    assert.equal(reason, 'direct harness database connection failed');
    assert.equal(raceSkip([reason], false), 'direct harness database connection failed');
    assert.equal(raceSkip([reason], true), false);
  } finally {
    if (saved.HARNESS_DIRECT_DSN === undefined) delete process.env.HARNESS_DIRECT_DSN;
    else process.env.HARNESS_DIRECT_DSN = saved.HARNESS_DIRECT_DSN;
    if (saved.PLERNI_APP_PASSWORD === undefined) delete process.env.PLERNI_APP_PASSWORD;
    else process.env.PLERNI_APP_PASSWORD = saved.PLERNI_APP_PASSWORD;
  }
});

test('a probe query that stalls is bounded and destroys the client', async () => {
  let destroyed = false;
  const client = {
    connection: { stream: { destroy() { destroyed = true; } } },
    async connect() {},
    query() {
      return new Promise(() => {});
    },
    async end() {},
  };
  const started = Date.now();
  const reason = await probeConnection(() => client, 'SELECT 1', 40);
  assert.equal(reason, 'connection failed');
  assert.equal(destroyed, true);
  assert.ok(Date.now() - started < 500);
  assert.equal(raceSkip([`pooled harness database ${reason}`], false), 'pooled harness database connection failed');
  assert.equal(raceSkip([`pooled harness database ${reason}`], true), false);
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

test('the renewal-to-lock oracle rejects an interval past the cadence', () => {
  const held = {
    committed: true,
    renewals: 4,
    lastRenewalToLockMs: 1000,
    boundViolation: false,
    bound: CADENCE_MS,
    lockWaitMs: 1,
  };
  assert.equal(commitReportHeld(held), true);
  assert.equal(commitReportHeld({ ...held, lastRenewalToLockMs: CADENCE_MS + 1, boundViolation: true }), false);
  assert.equal(commitReportHeld({ ...held, renewals: 1, lastRenewalToLockMs: null }), false);
  assert.equal(commitReportHeld({ ...held, renewals: 0, lastRenewalToLockMs: null }), true);
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
