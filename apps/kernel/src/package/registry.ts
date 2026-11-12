// SPDX-License-Identifier: Apache-2.0
// Package registry and per-tenant enablement (plan §3.2, §4.4, ADR-0008).
// Install records the registry row and the installation cursor. It does not
// write kernel.plugin_grant. Enablement cannot add a grant. requires edges
// block enablement. optionalRequires do not. Export records the procedure.
// Force-advance without that record writes nothing.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { FORCE_ADVANCE } from '../bus/constants.ts';
import { assertFilter, type TypeFilter } from '../bus/validate.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { PlatformScopeError } from '../tenant/errors.ts';
import {
  CursorNotParkedError,
  DependencyNotEnabledError,
  EnablementNotFoundError,
  ExportRequiredError,
  PackageConflictError,
  PackageHoldError,
  PackageInputError,
  PackageNotFoundError,
  SubscriptionNotFoundError,
  TenantNotFoundError,
} from './errors.ts';

const PLUGIN_ID = /^[a-z][a-z0-9_]{0,40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT = /^[a-z][a-z0-9_.]{0,80}$/;
const RANGE = /^(?:\*|(\^|~|>=|<=|>|<)?\d+\.\d+\.\d+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PackageEdge {
  plugin: string;
  contract: string;
  range: string;
}

export interface InstallPackageInput {
  id: string;
  version: string;
  digest: string;
  filter: readonly TypeFilter[];
  requires: readonly PackageEdge[];
  optionalRequires: readonly PackageEdge[];
}

export interface PackageRecord {
  id: string;
  version: string;
  digest: string;
  subscriptionId: string;
}

export interface EnablementRecord {
  packageId: string;
  tenantId: string;
  enabled: boolean;
  watermarkSeq: string;
}

export interface ExportRecord {
  packageId: string;
  exportedAt: Date;
}

export interface SessionTenant {
  tenantId: string;
}

interface PackageRow {
  id: string;
  version: string;
  digest: string;
  subscription_id: string;
  requires: unknown;
  exported_at: Date | null;
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

function assertEdges(edges: readonly PackageEdge[], self: string): void {
  if (edges.length > 32) throw new PackageInputError();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!PLUGIN_ID.test(edge.plugin) || edge.plugin === self) throw new PackageInputError();
    if (!CONTRACT.test(edge.contract) || !RANGE.test(edge.range)) throw new PackageInputError();
    if (seen.has(edge.plugin)) throw new PackageInputError();
    seen.add(edge.plugin);
  }
}

function assertInstall(input: InstallPackageInput): void {
  if (!PLUGIN_ID.test(input.id) || !VERSION.test(input.version) || !DIGEST.test(input.digest)) {
    throw new PackageInputError();
  }
  try {
    assertFilter(input.filter);
  } catch {
    throw new PackageInputError();
  }
  assertEdges(input.requires, input.id);
  assertEdges(input.optionalRequires, input.id);
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new PackageInputError();
}

async function readTenantKind(trx: Transaction<Database>, id: string): Promise<string | null> {
  const result = await sql<{ kind: string }>`
    SELECT kind FROM kernel.tenants WHERE id = ${id}::uuid`.execute(trx);
  return result.rows[0]?.kind ?? null;
}

async function requireOperator(trx: Transaction<Database>, session: SessionTenant): Promise<void> {
  assertUuid(session.tenantId);
  const kind = await readTenantKind(trx, session.tenantId);
  if (kind !== 'operator') throw new PlatformScopeError();
}

async function readPackage(trx: Transaction<Database>, id: string): Promise<PackageRow | null> {
  const result = await sql<PackageRow>`
    SELECT id,
           version,
           digest,
           subscription_id::text AS subscription_id,
           requires,
           exported_at
    FROM kernel.package
    WHERE id = ${id}`.execute(trx);
  return result.rows[0] ?? null;
}

function toPackage(row: PackageRow): PackageRecord {
  return {
    id: row.id,
    version: row.version,
    digest: row.digest,
    subscriptionId: row.subscription_id,
  };
}

export async function installPackage(
  db: Kysely<Database>,
  session: SessionTenant,
  input: InstallPackageInput,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<PackageRecord> {
  assertInstall(input);
  try {
    return await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      await requireOperator(trx, session);
      const subscriptionId = randomUUID();
      const high = await sql<{ seq: string }>`
        SELECT COALESCE(max(seq), 0)::text AS seq FROM kernel.outbox`.execute(trx);
      const head = high.rows[0]?.seq;
      if (head === undefined) throw new Error('high-water seq missing');
      await sql`
        INSERT INTO kernel.subscription (id, last_seq, status, park_reason, fence, filter)
        VALUES (
          ${subscriptionId}::uuid,
          ${head}::bigint,
          'live',
          NULL,
          1,
          ${JSON.stringify(input.filter)}::jsonb
        )`.execute(trx);
      await sql`
        INSERT INTO kernel.package (
          id, version, digest, status, subscription_id, requires, optional_requires
        ) VALUES (
          ${input.id},
          ${input.version},
          ${input.digest},
          'active',
          ${subscriptionId}::uuid,
          ${JSON.stringify(input.requires)}::jsonb,
          ${JSON.stringify(input.optionalRequires)}::jsonb
        )`.execute(trx);
      return {
        id: input.id,
        version: input.version,
        digest: input.digest,
        subscriptionId,
      };
    });
  } catch (error) {
    if (postgresCode(error) !== '23505') throw error;
    const existing = await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      await requireOperator(trx, session);
      return readPackage(trx, input.id);
    });
    if (existing && existing.digest === input.digest && existing.version === input.version) {
      return toPackage(existing);
    }
    throw new PackageConflictError();
  }
}

async function requireDependency(
  trx: Transaction<Database>,
  edges: readonly PackageEdge[],
  tenantId: string,
): Promise<void> {
  for (const edge of edges) {
    const enabled = await sql<{ enabled: boolean }>`
      SELECT enabled
      FROM kernel.package_enablement
      WHERE package_id = ${edge.plugin}
        AND tenant_id = ${tenantId}::uuid
        AND enabled = true`.execute(trx);
    if (!enabled.rows[0]) throw new DependencyNotEnabledError();
  }
}

export async function setPackageEnabled(
  db: Kysely<Database>,
  session: SessionTenant,
  packageId: string,
  enabled: boolean,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<EnablementRecord> {
  if (!PLUGIN_ID.test(packageId) || typeof enabled !== 'boolean') throw new PackageInputError();
  assertUuid(session.tenantId);
  return withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const kind = await readTenantKind(trx, session.tenantId);
    if (!kind) throw new TenantNotFoundError();
    const locked = await sql<PackageRow>`
      SELECT id,
             version,
             digest,
             subscription_id::text AS subscription_id,
             requires,
             exported_at
      FROM kernel.package
      WHERE id = ${packageId}
      FOR UPDATE`.execute(trx);
    const pkg = locked.rows[0];
    if (!pkg) throw new PackageNotFoundError();
    const cursor = await sql<{ last_seq: string }>`
      SELECT last_seq::text AS last_seq
      FROM kernel.subscription
      WHERE id = ${pkg.subscription_id}::uuid`.execute(trx);
    const head = cursor.rows[0]?.last_seq;
    if (head === undefined) throw new Error('installation cursor missing');
    if (enabled) await requireDependency(trx, parseEdges(pkg.requires), session.tenantId);
    await sql`
      INSERT INTO kernel.package_enablement (
        package_id, tenant_id, enabled, watermark_seq, held_since
      ) VALUES (
        ${packageId},
        ${session.tenantId}::uuid,
        ${enabled},
        ${head}::bigint,
        clock_timestamp()
      )
      ON CONFLICT (package_id, tenant_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          held_since = CASE
            WHEN EXCLUDED.enabled THEN kernel.package_enablement.held_since
            ELSE clock_timestamp()
          END,
          released_at = NULL`.execute(trx);
    const stored = await sql<{ enabled: boolean; watermark_seq: string }>`
      SELECT enabled, watermark_seq::text AS watermark_seq
      FROM kernel.package_enablement
      WHERE package_id = ${packageId}
        AND tenant_id = ${session.tenantId}::uuid`.execute(trx);
    const row = stored.rows[0];
    if (!row) throw new Error('enablement missing after write');
    return {
      packageId,
      tenantId: session.tenantId,
      enabled: row.enabled,
      watermarkSeq: row.watermark_seq,
    };
  });
}

function parseEdges(value: unknown): PackageEdge[] {
  if (!Array.isArray(value)) throw new PackageInputError();
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new PackageInputError();
    const plugin = 'plugin' in item && typeof item.plugin === 'string' ? item.plugin : '';
    const contract = 'contract' in item && typeof item.contract === 'string' ? item.contract : '';
    const range = 'range' in item && typeof item.range === 'string' ? item.range : '';
    if (!PLUGIN_ID.test(plugin) || !CONTRACT.test(contract) || !RANGE.test(range)) {
      throw new PackageInputError();
    }
    return { plugin, contract, range };
  });
}

export async function exportPackage(
  db: Kysely<Database>,
  session: SessionTenant,
  packageId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<ExportRecord> {
  if (!PLUGIN_ID.test(packageId)) throw new PackageInputError();
  return withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    await requireOperator(trx, session);
    const updated = await sql<{ exported_at: Date }>`
      UPDATE kernel.package
      SET exported_at = COALESCE(exported_at, clock_timestamp())
      WHERE id = ${packageId}
      RETURNING exported_at`.execute(trx);
    const row = updated.rows[0];
    if (!row) throw new PackageNotFoundError();
    return { packageId, exportedAt: row.exported_at };
  });
}

export async function forceAdvancePackage(
  db: Kysely<Database>,
  session: SessionTenant,
  packageId: string,
  tenantId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<EnablementRecord> {
  if (!PLUGIN_ID.test(packageId)) throw new PackageInputError();
  assertUuid(tenantId);
  return withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    await requireOperator(trx, session);
    const pkg = await sql<{ exported_at: Date | null; subscription_id: string }>`
      SELECT exported_at, subscription_id::text AS subscription_id
      FROM kernel.package
      WHERE id = ${packageId}
      FOR UPDATE`.execute(trx);
    const header = pkg.rows[0];
    if (!header) throw new PackageNotFoundError();
    if (!header.exported_at) throw new ExportRequiredError();
    const held = await sql<{ enabled: boolean; watermark_seq: string; released_at: Date | null }>`
      SELECT enabled, watermark_seq::text AS watermark_seq, released_at
      FROM kernel.package_enablement
      WHERE package_id = ${packageId}
        AND tenant_id = ${tenantId}::uuid
      FOR UPDATE`.execute(trx);
    const row = held.rows[0];
    if (!row) throw new EnablementNotFoundError();
    if (row.released_at) {
      return { packageId, tenantId, enabled: row.enabled, watermarkSeq: row.watermark_seq };
    }
    if (row.enabled) throw new PackageHoldError();
    const cursor = await sql<{ last_seq: string }>`
      SELECT last_seq::text AS last_seq
      FROM kernel.subscription
      WHERE id = ${header.subscription_id}::uuid`.execute(trx);
    const target = cursor.rows[0]?.last_seq;
    if (target === undefined) throw new Error('installation cursor missing');
    const advanced = await sql<{ enabled: boolean; watermark_seq: string }>`
      UPDATE kernel.package_enablement
      SET watermark_seq = GREATEST(watermark_seq, ${target}::bigint),
          released_at = clock_timestamp()
      WHERE package_id = ${packageId}
        AND tenant_id = ${tenantId}::uuid
        AND enabled = false
        AND released_at IS NULL
      RETURNING enabled, watermark_seq::text AS watermark_seq`.execute(trx);
    const next = advanced.rows[0];
    if (!next) throw new PackageHoldError();
    return { packageId, tenantId, enabled: next.enabled, watermarkSeq: next.watermark_seq };
  });
}

export async function exportSubscription(
  db: Kysely<Database>,
  session: SessionTenant,
  subscriptionId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  assertUuid(subscriptionId);
  await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    await requireOperator(trx, session);
    const updated = await sql<{ id: string }>`
      UPDATE kernel.subscription
      SET exported_at = COALESCE(exported_at, clock_timestamp())
      WHERE id = ${subscriptionId}::uuid
      RETURNING id::text AS id`.execute(trx);
    if (!updated.rows[0]) throw new SubscriptionNotFoundError();
  });
}

export async function forceAdvanceSubscription(
  db: Kysely<Database>,
  session: SessionTenant,
  subscriptionId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  assertUuid(subscriptionId);
  await withTenant(db, session.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    await requireOperator(trx, session);
    const locked = await sql<{
      last_seq: string;
      status: string;
      exported_at: Date | null;
      released_at: Date | null;
    }>`
      SELECT last_seq::text AS last_seq, status, exported_at, released_at
      FROM kernel.subscription
      WHERE id = ${subscriptionId}::uuid
      FOR UPDATE`.execute(trx);
    const row = locked.rows[0];
    if (!row) throw new SubscriptionNotFoundError();
    if (row.released_at) return;
    if (!row.exported_at) throw new ExportRequiredError();
    if (row.status !== 'parked') throw new CursorNotParkedError();
    const next = await sql<{ seq: string }>`
      SELECT seq::text AS seq
      FROM kernel.outbox
      WHERE seq > ${row.last_seq}::bigint
      ORDER BY seq
      LIMIT 1`.execute(trx);
    const seq = next.rows[0]?.seq;
    if (seq) {
      await sql`
        INSERT INTO kernel.dead_letter (subscription_id, seq, reason)
        VALUES (${subscriptionId}::uuid, ${seq}::bigint, ${FORCE_ADVANCE})
        ON CONFLICT (subscription_id, seq) DO NOTHING`.execute(trx);
    }
    const target = seq ?? row.last_seq;
    const updated = await sql<{ id: string }>`
      UPDATE kernel.subscription
      SET released_at = clock_timestamp(),
          last_seq = GREATEST(last_seq, ${target}::bigint)
      WHERE id = ${subscriptionId}::uuid
        AND status = 'parked'
        AND exported_at IS NOT NULL
        AND released_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!updated.rows[0]) throw new CursorNotParkedError();
  });
}
