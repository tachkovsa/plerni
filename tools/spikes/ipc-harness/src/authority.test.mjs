// authority.test.mjs — token predicate and error-path renewal drain.
// Skips unless a harness database is configured, so a checkout without Postgres stays green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  committedUpdateSql,
  renewUpdateSql,
  sweepUpdateSql,
  createExecution,
  dispatch,
  commitExecution,
  getStatus,
  renewExecution,
} from './authority.mjs';

test('production authority SQL keeps the ACTIVE predicate', () => {
  assert.equal(
    committedUpdateSql(),
    "UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS locked_at",
  );
  assert.equal(
    renewUpdateSql(),
    "UPDATE fencing_authority SET heartbeat_at = clock_timestamp() WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS renewed_at",
  );
  assert.equal(
    sweepUpdateSql(),
    "UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING id",
  );
  assert.equal(
    sweepUpdateSql({ clocked: true, scoped: true }),
    "UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < $2::timestamptz - make_interval(secs => $1) AND id = $3 RETURNING id",
  );
  assert.equal(committedUpdateSql({ requireActive: false }).includes("status = 'ACTIVE'"), false);
  assert.equal(sweepUpdateSql({ requireActive: false }).includes("status = 'ACTIVE'"), false);
  assert.throws(() => committedUpdateSql({ tag: '1; drop' }), /sql tag/);
});

const hasDb = Boolean(process.env.HARNESS_DIRECT_DSN || process.env.PLERNI_APP_PASSWORD);
const db = { skip: hasDb ? false : 'no harness database in the environment' };

test('renewal updates only the matching fencing token', db, async () => {
  const token = 'token-match';
  const id = await createExecution('renew-test', token, true);
  await dispatch(id, true);
  const before = await getStatus(id, true);

  const wrong = await renewExecution(id, 'other-token');
  assert.equal(wrong, null);
  const afterWrong = await getStatus(id, true);
  assert.equal(
    new Date(afterWrong.heartbeat_at).getTime(),
    new Date(before.heartbeat_at).getTime(),
  );

  const renewed = await renewExecution(id, token);
  assert.ok(renewed instanceof Date);
  const after = await getStatus(id, true);
  assert.ok(new Date(after.heartbeat_at).getTime() > new Date(before.heartbeat_at).getTime());
});

test('effects failure stops and drains an in-flight renewal', { ...db, timeout: 20_000 }, async () => {
  const token = 'token-drain';
  const id = await createExecution('drain-test', token, true);
  await dispatch(id, true);
  let started = false;
  const renew = async (rowId, rowToken, reserved, ctl) => {
    started = true;
    await reserved.query('BEGIN');
    try {
      const locked = await reserved.query(
        `SELECT id FROM fencing_authority WHERE id = $1 AND token = $2 AND status = 'ACTIVE' FOR UPDATE`,
        [rowId, rowToken],
      );
      if (locked.rowCount !== 1) {
        await reserved.query('ROLLBACK');
        return null;
      }
      const deadline = Date.now() + 30_000;
      while (!ctl.stop && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await reserved.query('ROLLBACK');
      return null;
    } catch (e) {
      await reserved.query('ROLLBACK').catch(() => {});
      throw e;
    }
  };

  const startedAt = Date.now();
  await assert.rejects(
    () => commitExecution(id, token, async () => {
      const deadline = Date.now() + 12_000;
      while (!started && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('effects failed');
    }, true, { renew }),
    /effects failed/,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(started, 'in-flight renewal was not started');
  assert.ok(elapsed < 15_000, `error path took ${elapsed}ms`);
  const status = await getStatus(id, true);
  assert.equal(status.status, 'ACTIVE');
});
