// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sql } from 'kysely';
import pg from 'pg';
import { verifyAuditChain, appendAuditCommitment } from '../src/audit/commitment.ts';
import { AuditChainError, AuditPayloadError } from '../src/audit/errors.ts';
import type { IdentityContext } from '../src/identity/context.ts';
import { disableUser, type DisableResult } from '../src/identity/disable.ts';
import { createIdentityLog } from '../src/identity/log.ts';
import { inspectTenantTable } from '../src/schema/tenant-table.ts';
import { blankEvidence, withTenant } from '../src/tenancy/hygiene.ts';
import { DIRECT, ROOT, appDb, ready, terminate } from './support.ts';

const T1 = 'a1111111-1111-4111-8111-111111111111';
const T2 = 'b2222222-2222-4222-8222-222222222222';
const ADMIN_1 = 'a1111111-1111-4111-8111-1111111111a1';
const MEMBER_1 = 'a1111111-1111-4111-8111-1111111111b1';
const MEMBER_2 = 'a1111111-1111-4111-8111-1111111111b2';
const ADMIN_2 = 'b2222222-2222-4222-8222-2222222222a1';
const MEMBER_3 = 'b2222222-2222-4222-8222-2222222222b1';
const TOKEN_1 = 'a'.repeat(64);
const TOKEN_2 = 'b'.repeat(64);
const PASSWORD_HASH = `$argon2id$${ 'x'.repeat(40) }`;
const GENESIS = '0'.repeat(64);
const ACTION = 'kernel.identity.disabled';

interface ChainRow {
  seq: string;
  action: string;
  payload_hash: string;
  previous_hash: string;
  entry_hash: string;
  body: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',');
    return `{${body}}`;
  }
  throw new Error('canonical value rejected');
}

function payloadHash(payload: unknown): string {
  return sha256(canonical(payload));
}

function entryHash(input: {
  tenantId: string;
  seq: number;
  action: string;
  payloadHash: string;
  previousHash: string;
}): string {
  return sha256(canonical({
    action: input.action,
    payloadHash: input.payloadHash,
    previousHash: input.previousHash,
    seq: input.seq,
    tenantId: input.tenantId,
  }));
}

function disabledPayload(actorUserId: string, targetUserId: string, result: DisableResult): Record<string, unknown> {
  return {
    actorUserId,
    epochAfter: result.epochAfter,
    epochBefore: result.epochBefore,
    revokedSessions: result.revokedSessions,
    targetUserId,
  };
}

function context(): IdentityContext {
  return {
    evidence: blankEvidence(),
    terminate,
    log: createIdentityLog(() => undefined),
  };
}

async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetAudit(): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.audit_commitment WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.audit_chain_head WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.session WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.auth_audit WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.audit_record WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.user_auth_state WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.user_account WHERE tenant_id = ANY($1::uuid[])', [[T1, T2]]);
    await client.query('DELETE FROM kernel.tenants WHERE id = ANY($1::uuid[])', [[T1, T2]]);
  });
}

async function seedAccount(
  client: pg.Client,
  tenantId: string,
  userId: string,
  email: string,
  kind: 'admin' | 'member',
  token: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO kernel.user_account (tenant_id, id, email, password_hash, kind)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    [tenantId, userId, email, PASSWORD_HASH, kind],
  );
  await client.query(
    `INSERT INTO kernel.user_auth_state (tenant_id, id, revocation_epoch)
     VALUES ($1::uuid, $2::uuid, 0)`,
    [tenantId, userId],
  );
  if (!token) return;
  await client.query(
    `INSERT INTO kernel.session (
       tenant_id, id, user_id, token_hash, session_kind,
       idle_expires_at, absolute_expires_at, fresh_until, issued_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'admin',
       clock_timestamp() + interval '1 day',
       clock_timestamp() + interval '1 day',
       clock_timestamp() + interval '1 day',
       0
     )`,
    [tenantId, token === TOKEN_1 ? 'a1111111-1111-4111-8111-1111111111c1' : 'b2222222-2222-4222-8222-2222222222c1', userId, sha256(token)],
  );
}

async function seed(): Promise<void> {
  await withRoot(async (client) => {
    for (const id of [T1, T2]) {
      await client.query(
        `INSERT INTO kernel.tenants (id, kind, aggregate_version) VALUES ($1::uuid, 'customer', 0)`,
        [id],
      );
    }
    await seedAccount(client, T1, ADMIN_1, 'admin.one@example.com', 'admin', TOKEN_1);
    await seedAccount(client, T1, MEMBER_1, 'member.one@example.com', 'member', null);
    await seedAccount(client, T1, MEMBER_2, 'member.two@example.com', 'member', null);
    await seedAccount(client, T2, ADMIN_2, 'admin.two@example.com', 'admin', TOKEN_2);
    await seedAccount(client, T2, MEMBER_3, 'member.three@example.com', 'member', null);
  });
}

async function chainRows(tenantId: string): Promise<ChainRow[]> {
  return withRoot(async (client) => {
    const result = await client.query<ChainRow>(
      `SELECT seq::text AS seq, action, payload_hash, previous_hash, entry_hash,
              concat_ws(' ', seq::text, action, payload_hash, previous_hash, entry_hash, id::text) AS body
       FROM kernel.audit_commitment
       WHERE tenant_id = $1::uuid
       ORDER BY kernel.audit_commitment.seq`,
      [tenantId],
    );
    return result.rows;
  });
}

async function disabled(userId: string): Promise<boolean> {
  return withRoot(async (client) => {
    const result = await client.query<{ disabled: boolean }>(
      `SELECT (disabled_at IS NOT NULL) AS disabled
       FROM kernel.user_auth_state WHERE id = $1::uuid`,
      [userId],
    );
    return result.rows[0]?.disabled === true;
  });
}

test('disabling a user commits the per-tenant hash chain, and a rollback writes neither', async () => {
  await ready();
  await resetAudit();
  await seed();
  const db = appDb(DIRECT, 1);
  try {
    let sawChain = false;
    let sawDisabled = false;
    await assert.rejects(
      () => disableUser(db, { tenantId: T1, token: TOKEN_1 }, MEMBER_1, context(), {
        afterWrite: async (trx) => {
          const seen = await sql<{ chain: string; disabled: boolean }>`
            SELECT
              (SELECT count(*) FROM kernel.audit_commitment)::text AS chain,
              (SELECT (disabled_at IS NOT NULL) FROM kernel.user_auth_state WHERE id = ${MEMBER_1}::uuid) AS disabled
          `.execute(trx);
          sawChain = seen.rows[0]?.chain === '1';
          sawDisabled = seen.rows[0]?.disabled === true;
          throw new Error('rollback');
        },
      }),
      (error: unknown) => error instanceof Error && error.message === 'rollback',
    );
    assert.equal(sawChain, true);
    assert.equal(sawDisabled, true);
    assert.deepEqual(await chainRows(T1), []);
    assert.equal(await disabled(MEMBER_1), false);
    const heads = await withRoot(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM kernel.audit_chain_head WHERE tenant_id = $1::uuid',
        [T1],
      );
      return result.rows[0]?.count;
    });
    assert.equal(heads, '0');

    const first = await disableUser(db, { tenantId: T1, token: TOKEN_1 }, MEMBER_1, context());
    const firstHash = payloadHash(disabledPayload(ADMIN_1, MEMBER_1, first));
    const firstEntry = entryHash({
      tenantId: T1,
      seq: 1,
      action: ACTION,
      payloadHash: firstHash,
      previousHash: GENESIS,
    });
    const linked = await chainRows(T1);
    assert.equal(linked.length, 1);
    const row = linked[0];
    assert.ok(row);
    assert.equal(row.seq, '1');
    assert.equal(row.action, ACTION);
    assert.equal(row.payload_hash, firstHash);
    assert.equal(row.previous_hash, GENESIS);
    assert.equal(row.entry_hash, firstEntry);
    assert.equal(row.body.includes(MEMBER_1), false);
    assert.equal(row.body.includes(ADMIN_1), false);
    assert.equal(canonical(disabledPayload(ADMIN_1, MEMBER_1, first)).includes(MEMBER_1), true);
    assert.equal(await disabled(MEMBER_1), true);

    const second = await disableUser(db, { tenantId: T1, token: TOKEN_1 }, MEMBER_2, context());
    const secondHash = payloadHash(disabledPayload(ADMIN_1, MEMBER_2, second));
    const extended = await chainRows(T1);
    assert.equal(extended.length, 2);
    const follow = extended[1];
    assert.ok(follow);
    assert.equal(follow.seq, '2');
    assert.equal(follow.previous_hash, firstEntry);
    assert.equal(follow.payload_hash, secondHash);
    assert.equal(follow.entry_hash, entryHash({
      tenantId: T1,
      seq: 2,
      action: ACTION,
      payloadHash: secondHash,
      previousHash: firstEntry,
    }));
    assert.equal(follow.body.includes(MEMBER_2), false);

    const other = await disableUser(db, { tenantId: T2, token: TOKEN_2 }, MEMBER_3, context());
    const otherRows = await chainRows(T2);
    assert.equal(otherRows.length, 1);
    assert.equal(otherRows[0]?.seq, '1');
    assert.equal(otherRows[0]?.previous_hash, GENESIS);
    assert.notEqual(otherRows[0]?.entry_hash, firstEntry);
    assert.equal(otherRows[0]?.payload_hash, payloadHash(disabledPayload(ADMIN_2, MEMBER_3, other)));
    assert.equal(otherRows[0]?.body.includes(MEMBER_3), false);

    const visible = await withTenant(db, T1, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ tenant_id: string; seq: string }>`
        SELECT tenant_id::text AS tenant_id, seq::text AS seq
        FROM kernel.audit_commitment
        ORDER BY seq`.execute(trx);
      const verified = await verifyAuditChain(trx, T1);
      return { rows: result.rows, verified };
    });
    assert.deepEqual(visible.rows.map((item) => item.tenant_id), [T1, T1]);
    assert.equal(visible.verified.count, 2);
    assert.equal(visible.verified.headHash, follow.entry_hash);
    const hidden = await withTenant(db, T2, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM kernel.audit_commitment`.execute(trx);
      return result.rows[0]?.count;
    });
    assert.equal(hidden, '1');

    await withRoot(async (client) => {
      await client.query(
        `UPDATE kernel.audit_commitment SET payload_hash = $2 WHERE tenant_id = $1::uuid AND seq = 1`,
        [T1, sha256('tamper')],
      );
      assert.deepEqual(await inspectTenantTable(client, { schema: 'kernel', table: 'audit_commitment' }), []);
      assert.deepEqual(await inspectTenantTable(client, { schema: 'kernel', table: 'audit_chain_head' }), []);
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'kernel' AND table_name = 'audit_commitment'
         ORDER BY ordinal_position`,
      );
      assert.deepEqual(columns.rows.map((item) => item.column_name), [
        'tenant_id', 'id', 'seq', 'action', 'payload_hash', 'previous_hash', 'entry_hash', 'created_at',
      ]);
    });
    await assert.rejects(
      () => withTenant(db, T1, blankEvidence(), terminate, (trx) => verifyAuditChain(trx, T1)),
      (error: unknown) => error instanceof AuditChainError,
    );
    await withTenant(db, T2, blankEvidence(), terminate, async (trx) => {
      const verified = await verifyAuditChain(trx, T2);
      assert.equal(verified.count, 1);
    });

    const app = new pg.Client({ connectionString: DIRECT });
    await app.connect();
    try {
      const unseen = await app.query('SELECT id FROM kernel.audit_commitment');
      assert.equal(unseen.rows.length, 0);
      await app.query('BEGIN');
      await assert.rejects(
        () => app.query("UPDATE kernel.audit_commitment SET action = 'kernel.identity.disabled'"),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      );
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await app.query('SET LOCAL ROLE plerni_plugin_a');
      await assert.rejects(
        () => app.query('SELECT id FROM kernel.audit_commitment'),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }

    await assert.rejects(
      () => withTenant(db, T2, blankEvidence(), terminate, async (trx) => {
        await sql`INSERT INTO kernel.scoped_row (tenant_id, id, marker) VALUES (${T2}::uuid, ${MEMBER_3}::uuid, 'marker')`.execute(trx);
        await appendAuditCommitment(trx, { tenantId: T2, action: ACTION, payload: 'raw-payload' });
      }),
      (error: unknown) => error instanceof AuditPayloadError,
    );
    const marker = await withRoot(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kernel.scoped_row WHERE tenant_id = $1::uuid AND marker = 'marker'`,
        [T2],
      );
      return result.rows[0]?.count;
    });
    assert.equal(marker, '0');
    assert.equal((await chainRows(T2)).length, 1);
  } finally {
    await db.destroy();
    await resetAudit();
    await withRoot(async (client) => {
      await client.query("DELETE FROM kernel.scoped_row WHERE marker = 'marker'");
    });
  }
});

const T3 = 'c3333333-3333-4333-8333-333333333333';
const RECORDED = 'kernel.audit.recorded';

async function resetTenant(tenantId: string): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.audit_commitment WHERE tenant_id = $1::uuid', [tenantId]);
    await client.query('DELETE FROM kernel.audit_chain_head WHERE tenant_id = $1::uuid', [tenantId]);
    await client.query('DELETE FROM kernel.tenants WHERE id = $1::uuid', [tenantId]);
  });
}

test('an own __proto__ key changes the payload hash', async () => {
  await ready();
  await resetTenant(T3);
  await withRoot(async (client) => {
    await client.query(
      `INSERT INTO kernel.tenants (id, kind, aggregate_version) VALUES ($1::uuid, 'customer', 0)`,
      [T3],
    );
  });
  const db = appDb(DIRECT, 1);
  try {
    const hashes = await withTenant(db, T3, blankEvidence(), terminate, async (trx) => {
      const first = await appendAuditCommitment(trx, {
        tenantId: T3,
        action: RECORDED,
        payload: JSON.parse('{"__proto__":{"amount":1},"x":1}') as unknown,
      });
      const second = await appendAuditCommitment(trx, {
        tenantId: T3,
        action: RECORDED,
        payload: JSON.parse('{"__proto__":{"amount":2},"x":1}') as unknown,
      });
      const verified = await verifyAuditChain(trx, T3);
      return { first: first.payloadHash, second: second.payloadHash, count: verified.count };
    });
    assert.notEqual(hashes.first, hashes.second);
    assert.equal(hashes.count, 2);
  } finally {
    await db.destroy();
    await resetTenant(T3);
  }
});

test('verification follows the numeric sequence through twelve entries', async () => {
  await ready();
  await resetTenant(T3);
  await withRoot(async (client) => {
    await client.query(
      `INSERT INTO kernel.tenants (id, kind, aggregate_version) VALUES ($1::uuid, 'customer', 0)`,
      [T3],
    );
  });
  const db = appDb(DIRECT, 1);
  try {
    const verified = await withTenant(db, T3, blankEvidence(), terminate, async (trx) => {
      for (let n = 1; n <= 12; n += 1) {
        await appendAuditCommitment(trx, { tenantId: T3, action: RECORDED, payload: { n } });
      }
      return verifyAuditChain(trx, T3);
    });
    assert.equal(verified.count, 12);
    const rows = await chainRows(T3);
    assert.deepEqual(rows.map((row) => row.seq), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const tenth = rows[9];
    const ninth = rows[8];
    assert.ok(tenth && ninth);
    assert.equal(tenth.previous_hash, ninth.entry_hash);
    assert.equal(verified.headHash, rows[11]?.entry_hash);
  } finally {
    await db.destroy();
    await resetTenant(T3);
  }
});
