// SPDX-License-Identifier: Apache-2.0
// Per-tenant commitment chain (spec §11, plan K8). The stored payload is
// sha256 of canonical JSON. The entry hash covers the tenant, the sequence,
// the action, that payload hash, and the previous entry hash. The first
// previous hash is 64 zero digits. The head row is locked for this tenant
// only, so another tenant's append does not wait on it.
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { AuditChainError, AuditPayloadError } from './errors.ts';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);
const ACTION = /^[a-z][a-z0-9_.]{1,80}$/;
const MAX_PAYLOAD = 4096;

export interface AuditLink {
  seq: number;
  payloadHash: string;
  previousHash: string;
  entryHash: string;
}

export interface AuditChainStatus {
  count: number;
  headHash: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sorted(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuditPayloadError();
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sorted(item));
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new AuditPayloadError();
    const record = value as Record<string, unknown>;
    if (Object.getOwnPropertySymbols(record).length > 0) throw new AuditPayloadError();
    // A normal object drops an own "__proto__" key when it is written with `=`.
    // The accumulator has no prototype, and each key is an own data property.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new AuditPayloadError();
      if (descriptor.value === undefined) throw new AuditPayloadError();
      Object.defineProperty(out, key, {
        value: sorted(descriptor.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new AuditPayloadError();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function asSeq(value: string): number {
  if (!/^\d+$/.test(value)) throw new AuditChainError();
  const seq = Number(value);
  if (!Number.isSafeInteger(seq)) throw new AuditChainError();
  return seq;
}

function payloadHashOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AuditPayloadError();
  const canonical = canonicalJson(payload);
  if (canonical.length > MAX_PAYLOAD) throw new AuditPayloadError();
  return sha256(canonical);
}

function entryHashOf(input: {
  tenantId: string;
  seq: number;
  action: string;
  payloadHash: string;
  previousHash: string;
}): string {
  return sha256(canonicalJson({
    action: input.action,
    payloadHash: input.payloadHash,
    previousHash: input.previousHash,
    seq: input.seq,
    tenantId: input.tenantId,
  }));
}

async function assertSameTenant(trx: Transaction<Database>, tenantId: string): Promise<void> {
  await assertTenantContext(trx);
  const installed = await sql<{ tenant_id: string | null }>`
    SELECT current_setting('plerni.tenant_id', true) AS tenant_id`.execute(trx);
  if (installed.rows[0]?.tenant_id !== tenantId) throw new AuditChainError();
}

export async function appendAuditCommitment(
  trx: Transaction<Database>,
  input: { tenantId: string; action: string; payload: unknown },
): Promise<AuditLink> {
  if (typeof input.action !== 'string' || !ACTION.test(input.action)) throw new AuditPayloadError();
  const payloadHash = payloadHashOf(input.payload);
  await assertSameTenant(trx, input.tenantId);
  await sql`
    INSERT INTO kernel.audit_chain_head (tenant_id, id, seq, head_hash)
    VALUES (${input.tenantId}::uuid, ${randomUUID()}::uuid, 0, ${AUDIT_GENESIS_HASH})
    ON CONFLICT (tenant_id) DO NOTHING`.execute(trx);
  const locked = await sql<{ seq: string; head_hash: string }>`
    SELECT seq::text AS seq, head_hash
    FROM kernel.audit_chain_head
    WHERE tenant_id = ${input.tenantId}::uuid
    FOR UPDATE`.execute(trx);
  const head = locked.rows[0];
  if (!head) throw new AuditChainError();
  const previousSeq = asSeq(head.seq);
  if (previousSeq >= Number.MAX_SAFE_INTEGER) throw new AuditChainError();
  const seq = previousSeq + 1;
  const previousHash = head.head_hash;
  const entryHash = entryHashOf({
    tenantId: input.tenantId,
    seq,
    action: input.action,
    payloadHash,
    previousHash,
  });
  await sql`
    INSERT INTO kernel.audit_commitment (
      tenant_id, id, seq, action, payload_hash, previous_hash, entry_hash
    ) VALUES (
      ${input.tenantId}::uuid,
      ${randomUUID()}::uuid,
      ${String(seq)}::bigint,
      ${input.action},
      ${payloadHash},
      ${previousHash},
      ${entryHash}
    )`.execute(trx);
  const advanced = await sql<{ seq: string }>`
    UPDATE kernel.audit_chain_head
    SET seq = ${String(seq)}::bigint, head_hash = ${entryHash}
    WHERE tenant_id = ${input.tenantId}::uuid
    RETURNING seq::text AS seq`.execute(trx);
  if (advanced.rows[0]?.seq !== String(seq)) throw new AuditChainError();
  return { seq, payloadHash, previousHash, entryHash };
}

export async function verifyAuditChain(
  trx: Transaction<Database>,
  tenantId: string,
): Promise<AuditChainStatus> {
  await assertSameTenant(trx, tenantId);
  // One statement, so the head and the entries share a snapshot. Ordering uses
  // the bigint column. The text alias would sort "10" before "2".
  const rows = await sql<{
    seq: string | null;
    action: string | null;
    payload_hash: string | null;
    previous_hash: string | null;
    entry_hash: string | null;
    head_seq: string | null;
    head_hash: string | null;
  }>`
    SELECT c.seq::text AS seq,
           c.action,
           c.payload_hash,
           c.previous_hash,
           c.entry_hash,
           h.seq::text AS head_seq,
           h.head_hash
    FROM kernel.audit_chain_head h
    FULL OUTER JOIN kernel.audit_commitment c ON c.tenant_id = h.tenant_id
    WHERE COALESCE(h.tenant_id, c.tenant_id) = ${tenantId}::uuid
    ORDER BY c.seq`.execute(trx);
  if (rows.rows.length === 0) return { count: 0, headHash: null };
  const headSeq = rows.rows[0]?.head_seq;
  const headHash = rows.rows[0]?.head_hash;
  if (!headSeq || !headHash) throw new AuditChainError();
  let previous = AUDIT_GENESIS_HASH;
  for (let index = 0; index < rows.rows.length; index += 1) {
    const row = rows.rows[index];
    if (!row || row.head_seq !== headSeq || row.head_hash !== headHash) throw new AuditChainError();
    if (!row.seq || !row.action || !row.payload_hash || !row.previous_hash || !row.entry_hash) {
      throw new AuditChainError();
    }
    const seq = asSeq(row.seq);
    if (seq !== index + 1 || row.previous_hash !== previous) throw new AuditChainError();
    const expected = entryHashOf({
      tenantId,
      seq,
      action: row.action,
      payloadHash: row.payload_hash,
      previousHash: row.previous_hash,
    });
    if (expected !== row.entry_hash) throw new AuditChainError();
    previous = row.entry_hash;
  }
  const last = rows.rows[rows.rows.length - 1];
  if (!last || headSeq !== last.seq || headHash !== last.entry_hash) throw new AuditChainError();
  return { count: rows.rows.length, headHash };
}
