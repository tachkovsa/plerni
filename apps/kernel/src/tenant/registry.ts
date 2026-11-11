// SPDX-License-Identifier: Apache-2.0
// Tenant registry and the create-tenant API (plan §5.1, §5.4, ADR-0010).
// Bootstrap inserts the one operator tenant. createTenant is operator-only:
// id, registry row, audit record, and kernel.tenant.created commit together
// on the K1 hygiene path. Reference data is not seeded.
//
// The log row's seq comes from nextval inside that transaction. Per-aggregate
// order is aggregate_version, incremented under FOR UPDATE on the tenant row
// (plan §4.2, ADR-0009). No advisory lock is taken. The relay is not started.
import { randomUUID } from 'node:crypto';
import { isIdempotencyKey } from '@plerni/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  IdempotencyConflict,
  InvalidIdempotencyKeyError,
  InvalidTenantIdError,
  PlatformScopeError,
} from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TENANT_CREATED_EVENT = 'kernel.tenant.created';

export interface TenantRecord {
  id: string;
  kind: 'operator' | 'customer';
  createdAt: Date;
}

export interface TenantSession {
  tenantId: string;
}

export interface CreateTenantInput {
  idempotencyKey: string;
}

interface TenantRow {
  id: string;
  kind: string;
  created_at: Date;
}

type Executor = Kysely<Database> | Transaction<Database>;

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidTenantIdError();
}

function asKind(value: string): TenantRecord['kind'] {
  if (value === 'operator' || value === 'customer') return value;
  throw new Error(`unexpected tenant kind '${value}'`);
}

function toRecord(row: TenantRow): TenantRecord {
  return { id: row.id, kind: asKind(row.kind), createdAt: row.created_at };
}

function postgresCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function readTenant(db: Executor, id: string): Promise<TenantRecord | null> {
  const result = await sql<TenantRow>`
    SELECT id::text AS id, kind, created_at
    FROM kernel.tenants
    WHERE id = ${id}::uuid`.execute(db);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

async function readOperator(db: Executor): Promise<TenantRecord | null> {
  const result = await sql<TenantRow>`
    SELECT id::text AS id, kind, created_at
    FROM kernel.tenants
    WHERE kind = 'operator'`.execute(db);
  if (result.rows.length > 1) throw new Error('operator tenant is not unique');
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

async function readIdempotentTenant(db: Executor, key: string): Promise<TenantRecord | null> {
  const result = await sql<{ id: string }>`
    SELECT tenant_id::text AS id
    FROM kernel.tenant_idempotency
    WHERE idempotency_key = ${key}`.execute(db);
  const id = result.rows[0]?.id;
  if (!id) return null;
  return readTenant(db, id);
}

async function insertTenant(trx: Transaction<Database>, id: string, kind: TenantRecord['kind']): Promise<void> {
  await sql`
    INSERT INTO kernel.tenants (id, kind, aggregate_version)
    VALUES (${id}::uuid, ${kind}, 0)`.execute(trx);
}

/**
 * Lock the aggregate, assign the next version, then allocate seq and append.
 * The row lock is held until the transaction ends. nextval is not an advisory lock.
 */
async function appendTenantCreated(
  trx: Transaction<Database>,
  actorTenantId: string,
  tenantId: string,
  kind: TenantRecord['kind'],
): Promise<void> {
  const locked = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM kernel.tenants
    WHERE id = ${tenantId}::uuid
    FOR UPDATE`.execute(trx);
  if (!locked.rows[0]) throw new Error('tenant row missing under lock');
  const bumped = await sql<{ aggregate_version: string }>`
    UPDATE kernel.tenants
    SET aggregate_version = aggregate_version + 1
    WHERE id = ${tenantId}::uuid
    RETURNING aggregate_version::text AS aggregate_version`.execute(trx);
  const version = bumped.rows[0]?.aggregate_version;
  if (!version || version === '0') throw new Error('aggregate version was not assigned');
  const allocated = await sql<{ seq: string }>`
    SELECT nextval('kernel.outbox_seq')::text AS seq`.execute(trx);
  const sequence = allocated.rows[0]?.seq;
  if (!sequence) throw new Error('outbox sequence returned no value');
  const payload = JSON.stringify({ id: tenantId, kind });
  await sql`
    INSERT INTO kernel.outbox (
      seq, tenant_id, aggregate_type, aggregate_id, aggregate_version, type, version, payload
    ) VALUES (
      ${sequence}::bigint,
      ${tenantId}::uuid,
      'kernel.tenant',
      ${tenantId}::uuid,
      ${version}::bigint,
      ${TENANT_CREATED_EVENT},
      1,
      ${payload}::jsonb
    )`.execute(trx);
  await sql`
    INSERT INTO kernel.audit_record (tenant_id, id, action, target_tenant_id)
    VALUES (
      ${actorTenantId}::uuid,
      ${randomUUID()}::uuid,
      ${TENANT_CREATED_EVENT},
      ${tenantId}::uuid
    )`.execute(trx);
}

export async function bootstrapOperatorTenant(
  db: Kysely<Database>,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<TenantRecord> {
  // The proposed id is only the hygiene GUC until an insert commits. The
  // lookup stays inside the transaction so a leaked role, tenant GUC, or
  // search_path is recovered before the read. A repeat call writes nothing.
  const id = randomUUID();
  return withTenant(db, id, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const existing = await readOperator(trx);
    if (existing) return existing;
    const inserted = await sql<{ id: string }>`
      INSERT INTO kernel.tenants (id, kind, aggregate_version)
      VALUES (${id}::uuid, 'operator', 0)
      ON CONFLICT (kind) WHERE kind = 'operator' DO NOTHING
      RETURNING id::text AS id`.execute(trx);
    if (!inserted.rows[0]) {
      const winner = await readOperator(trx);
      if (!winner) throw new Error('operator tenant missing after conflict');
      return winner;
    }
    await appendTenantCreated(trx, id, id, 'operator');
    const created = await readTenant(trx, id);
    if (!created) throw new Error('operator tenant missing after insert');
    return created;
  });
}

export async function createTenant(
  db: Kysely<Database>,
  session: TenantSession,
  input: CreateTenantInput,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  afterKeyMiss?: (trx: Transaction<Database>) => Promise<void>,
): Promise<TenantRecord> {
  assertUuid(session.tenantId);
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || !isIdempotencyKey(key)) throw new InvalidIdempotencyKeyError();
  try {
    return await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      const actor = await readTenant(trx, session.tenantId);
      if (actor?.kind !== 'operator') throw new PlatformScopeError();
      const replay = await readIdempotentTenant(trx, key);
      if (replay) return replay;
      // Still inside this transaction, before the insert. A race test waits here
      // until the other request has also missed the key.
      if (afterKeyMiss) await afterKeyMiss(trx);
      const id = randomUUID();
      await insertTenant(trx, id, 'customer');
      await appendTenantCreated(trx, session.tenantId, id, 'customer');
      const stored = await sql<{ id: string }>`
        INSERT INTO kernel.tenant_idempotency (idempotency_key, tenant_id)
        VALUES (${key}, ${id}::uuid)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING tenant_id::text AS id`.execute(trx);
      if (!stored.rows[0]) throw new IdempotencyConflict();
      const created = await readTenant(trx, id);
      if (!created || created.kind !== 'customer') throw new Error('created tenant is not readable');
      return created;
    });
  } catch (error) {
    if (error instanceof IdempotencyConflict || postgresCode(error) === '23505') {
      // The losing transaction has rolled back. This checkout may be a different
      // pooled backend, so the winner is read only after a fresh hygiene pass.
      const saved = await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
        await assertTenantContext(trx);
        const actor = await readTenant(trx, session.tenantId);
        if (actor?.kind !== 'operator') throw new PlatformScopeError();
        return readIdempotentTenant(trx, key);
      });
      if (saved) return saved;
    }
    throw error;
  }
}
