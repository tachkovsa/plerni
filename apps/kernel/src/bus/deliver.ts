// SPDX-License-Identifier: Apache-2.0
// One relay delivery (plan §4.2, ADR-0009 decision 2).
// safe_point is the max committed seq whose created_at is at least 10 seconds
// old. The claim is FOR UPDATE SKIP LOCKED on the subscription. One event is
// one transaction: dedup marker, handler effect, cursor advance, fencing check.
// A filtered type advances. An unlisted payload version parks the subscription
// and leaves the cursor and the row. A rolled-back nextval is a missing seq
// and is skipped. A handler failure dead-letters that event and leaves the
// cursor. The failure gate then keeps that subscription from filling later
// passes until other subscriptions are idle. No advisory lock.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { blankEvidence, withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { DRAIN_LIMIT, HANDLER_FAILED, NO_LISTENER_ALERT, PARK_UNKNOWN_VERSION } from './constants.ts';
import { countRelayListeners } from './listen.ts';
import { decide, parseFilter } from './validate.ts';

export interface DeliveredEvent {
  subscriptionId: string;
  seq: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: string;
  type: string;
  version: number;
  payload: unknown;
  idempotencyKey: string;
}

export type DeliveryHandler = (
  trx: Transaction<Database>,
  event: DeliveredEvent,
) => Promise<void>;

export interface Claim {
  subscriptionId: string;
  fence: string;
  lastSeq: string;
  safePoint: string;
  event: { seq: string; tenantId: string };
}

export type DeliverOutcome =
  | { kind: 'idle' }
  | { kind: 'stale'; subscriptionId: string }
  | { kind: 'retry'; subscriptionId: string }
  | { kind: 'skipped'; subscriptionId: string; seq: string }
  | { kind: 'parked'; subscriptionId: string; seq: string }
  | { kind: 'delivered'; subscriptionId: string; seq: string; idempotencyKey: string }
  | { kind: 'duplicate'; subscriptionId: string; seq: string; idempotencyKey: string }
  | { kind: 'failed'; subscriptionId: string; seq: string; alarm: string };

export interface DeliverReport {
  delivered: number;
  skipped: number;
  parked: number;
  duplicates: number;
  alerts: string[];
}

export interface DeliverStep {
  outcome: DeliverOutcome;
  alerts: readonly string[];
}

/**
 * Handler failures remembered across passes. The relay holds one gate.
 * A pass serves every other subscription before it spends leftover steps
 * retrying the deferred set, so a poison set cannot fill every budget.
 */
export interface FailureGate {
  readonly deferred: Set<string>;
}

export function createFailureGate(): FailureGate {
  return { deferred: new Set() };
}

/** A delivery pass failed after hygiene recorded alerts that must not be dropped. */
export class RelayDeliveryError extends Error {
  readonly alerts: readonly string[];

  constructor(cause: unknown, alerts: readonly string[]) {
    super('relay delivery failed', { cause });
    this.name = 'RelayDeliveryError';
    this.alerts = alerts;
  }
}

interface OutboxEvent {
  seq: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: string;
  type: string;
  version: number;
  payload: unknown;
}

interface SubscriptionRow {
  id: string;
  lastSeq: string;
  fence: string;
  status: string;
  filter: unknown;
}

class HandlerFailed extends Error {
  constructor(cause: unknown) {
    super('handler failed', { cause });
    this.name = 'HandlerFailed';
  }
}

function isHandlerFailed(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof HandlerFailed) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export function deliveryKey(subscriptionId: string, seq: string): string {
  return `${subscriptionId}:${seq}`;
}

async function readSafePoint(trx: Transaction<Database>): Promise<string | null> {
  // Literal horizon. A caller cannot pass a shorter cutoff.
  const result = await sql<{ safe_point: string | null }>`
    SELECT max(seq)::text AS safe_point
    FROM kernel.outbox
    WHERE created_at <= clock_timestamp() - interval '10 seconds'`.execute(trx);
  const safePoint = result.rows[0]?.safe_point;
  return safePoint ?? null;
}

async function nextOutboxEvent(
  trx: Transaction<Database>,
  lastSeq: string,
  safePoint: string,
): Promise<OutboxEvent | null> {
  const result = await sql<{
    seq: string;
    tenant_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    type: string;
    version: number;
    payload: unknown;
  }>`
    SELECT seq::text AS seq,
           tenant_id::text AS tenant_id,
           aggregate_type,
           aggregate_id::text AS aggregate_id,
           aggregate_version::text AS aggregate_version,
           type,
           version,
           payload
    FROM kernel.outbox
    WHERE seq > ${lastSeq}::bigint
      AND seq <= ${safePoint}::bigint
    ORDER BY seq
    LIMIT 1`.execute(trx);
  const row = result.rows[0];
  if (!row) return null;
  if (!Number.isInteger(row.version)) throw new Error('payload version unreadable');
  return {
    seq: row.seq,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    type: row.type,
    version: row.version,
    payload: row.payload,
  };
}

async function claimNext(db: Kysely<Database>, exclude: readonly string[]): Promise<Claim | null> {
  return db.transaction().execute(async (trx) => {
    const safePoint = await readSafePoint(trx);
    if (!safePoint) return null;
    const claimed = await sql<{ id: string; last_seq: string; fence: string }>`
      SELECT id::text AS id, last_seq::text AS last_seq, fence::text AS fence
      FROM kernel.subscription
      WHERE status = 'live'
        AND last_seq < ${safePoint}::bigint
        AND NOT (id::text = ANY(${exclude}::text[]))
      ORDER BY last_seq, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`.execute(trx);
    const subscription = claimed.rows[0];
    if (!subscription) return null;
    const event = await nextOutboxEvent(trx, subscription.last_seq, safePoint);
    if (!event) return null;
    return {
      subscriptionId: subscription.id,
      fence: subscription.fence,
      lastSeq: subscription.last_seq,
      safePoint,
      event: { seq: event.seq, tenantId: event.tenantId },
    };
  });
}

async function lockSubscription(
  trx: Transaction<Database>,
  id: string,
): Promise<SubscriptionRow | null> {
  const result = await sql<{
    id: string;
    last_seq: string;
    fence: string;
    status: string;
    filter: unknown;
  }>`
    SELECT id::text AS id,
           last_seq::text AS last_seq,
           fence::text AS fence,
           status,
           filter
    FROM kernel.subscription
    WHERE id = ${id}::uuid
    FOR UPDATE`.execute(trx);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    lastSeq: row.last_seq,
    fence: row.fence,
    status: row.status,
    filter: row.filter,
  };
}

async function advanceCursor(
  trx: Transaction<Database>,
  subscription: SubscriptionRow,
  seq: string,
): Promise<boolean> {
  const updated = await sql<{ id: string }>`
    UPDATE kernel.subscription
    SET last_seq = ${seq}::bigint
    WHERE id = ${subscription.id}::uuid
      AND status = 'live'
      AND fence = ${subscription.fence}::bigint
      AND last_seq = ${subscription.lastSeq}::bigint
    RETURNING id::text AS id`.execute(trx);
  return updated.rows.length === 1;
}

async function parkSubscription(
  trx: Transaction<Database>,
  subscription: SubscriptionRow,
): Promise<boolean> {
  const updated = await sql<{ id: string }>`
    UPDATE kernel.subscription
    SET status = 'parked', park_reason = ${PARK_UNKNOWN_VERSION}
    WHERE id = ${subscription.id}::uuid
      AND status = 'live'
      AND fence = ${subscription.fence}::bigint
      AND last_seq = ${subscription.lastSeq}::bigint
    RETURNING id::text AS id`.execute(trx);
  return updated.rows.length === 1;
}

async function insertMarker(
  trx: Transaction<Database>,
  subscriptionId: string,
  seq: string,
  key: string,
): Promise<boolean> {
  const inserted = await sql<{ seq: string }>`
    INSERT INTO kernel.delivery (subscription_id, seq, idempotency_key)
    VALUES (${subscriptionId}::uuid, ${seq}::bigint, ${key})
    ON CONFLICT (subscription_id, seq) DO NOTHING
    RETURNING seq::text AS seq`.execute(trx);
  return inserted.rows.length === 1;
}

async function recordDeadLetter(
  db: Kysely<Database>,
  subscriptionId: string,
  seq: string,
): Promise<void> {
  await sql`
    INSERT INTO kernel.dead_letter (subscription_id, seq, reason)
    VALUES (${subscriptionId}::uuid, ${seq}::bigint, ${HANDLER_FAILED})
    ON CONFLICT (subscription_id, seq) DO NOTHING`.execute(db);
}

async function applyClaim(
  db: Kysely<Database>,
  claim: Claim,
  handler: DeliveryHandler,
  terminateBackend: (pid: number) => Promise<void>,
  evidence: HygieneEvidence,
): Promise<DeliverOutcome> {
  return withTenant(db, claim.event.tenantId, evidence, terminateBackend, async (trx) => {
    const current = await lockSubscription(trx, claim.subscriptionId);
    if (!current || current.fence !== claim.fence || current.status !== 'live') {
      return { kind: 'stale', subscriptionId: claim.subscriptionId };
    }
    if (current.lastSeq !== claim.lastSeq) {
      return { kind: 'retry', subscriptionId: claim.subscriptionId };
    }
    const safePoint = await readSafePoint(trx);
    if (!safePoint) return { kind: 'idle' };
    const event = await nextOutboxEvent(trx, current.lastSeq, safePoint);
    if (!event || event.seq !== claim.event.seq || event.tenantId !== claim.event.tenantId) {
      return { kind: 'retry', subscriptionId: claim.subscriptionId };
    }
    const action = decide(parseFilter(current.filter), event.type, event.version);
    if (action === 'skip') {
      const advanced = await advanceCursor(trx, current, event.seq);
      if (!advanced) return { kind: 'stale', subscriptionId: claim.subscriptionId };
      return { kind: 'skipped', subscriptionId: claim.subscriptionId, seq: event.seq };
    }
    if (action === 'park') {
      const parked = await parkSubscription(trx, current);
      if (!parked) return { kind: 'stale', subscriptionId: claim.subscriptionId };
      return { kind: 'parked', subscriptionId: claim.subscriptionId, seq: event.seq };
    }
    const key = deliveryKey(current.id, event.seq);
    const inserted = await insertMarker(trx, current.id, event.seq, key);
    if (inserted) {
      try {
        await handler(trx, { ...event, subscriptionId: current.id, idempotencyKey: key });
      } catch (error) {
        throw new HandlerFailed(error);
      }
    }
    const advanced = await advanceCursor(trx, current, event.seq);
    if (!advanced) throw new Error('cursor advance lost the fencing check');
    return inserted
      ? { kind: 'delivered', subscriptionId: current.id, seq: event.seq, idempotencyKey: key }
      : { kind: 'duplicate', subscriptionId: current.id, seq: event.seq, idempotencyKey: key };
  });
}

export async function deliverOne(
  db: Kysely<Database>,
  handler: DeliveryHandler,
  terminateBackend: (pid: number) => Promise<void>,
  afterClaim?: (claim: Claim) => Promise<void>,
  exclude: readonly string[] = [],
): Promise<DeliverStep> {
  const claim = await claimNext(db, exclude);
  if (!claim) return { outcome: { kind: 'idle' }, alerts: [] };
  if (afterClaim) await afterClaim(claim);
  const evidence = blankEvidence();
  try {
    const outcome = await applyClaim(db, claim, handler, terminateBackend, evidence);
    return { outcome, alerts: evidence.alerts };
  } catch (error) {
    if (!isHandlerFailed(error)) throw new RelayDeliveryError(error, evidence.alerts);
    await recordDeadLetter(db, claim.subscriptionId, claim.event.seq);
    return {
      outcome: {
        kind: 'failed',
        subscriptionId: claim.subscriptionId,
        seq: claim.event.seq,
        alarm: 'handler failed',
      },
      alerts: ['handler failed', ...evidence.alerts],
    };
  }
}

function recordOutcome(report: DeliverReport, step: DeliverStep): boolean {
  report.alerts.push(...step.alerts);
  const outcome = step.outcome;
  if (outcome.kind === 'idle') return false;
  if (outcome.kind === 'delivered') report.delivered += 1;
  else if (outcome.kind === 'skipped') report.skipped += 1;
  else if (outcome.kind === 'parked') report.parked += 1;
  else if (outcome.kind === 'duplicate') report.duplicates += 1;
  return true;
}

function advanced(outcome: DeliverOutcome): outcome is Extract<
  DeliverOutcome,
  { kind: 'delivered' | 'skipped' | 'parked' | 'duplicate' }
> {
  return outcome.kind === 'delivered'
    || outcome.kind === 'skipped'
    || outcome.kind === 'parked'
    || outcome.kind === 'duplicate';
}

export async function deliverAvailable(
  db: Kysely<Database>,
  handler: DeliveryHandler,
  terminateBackend: (pid: number) => Promise<void>,
  gate: FailureGate = createFailureGate(),
): Promise<DeliverReport> {
  const report: DeliverReport = {
    delivered: 0,
    skipped: 0,
    parked: 0,
    duplicates: 0,
    alerts: [],
  };
  const failed = new Set<string>();
  try {
    let steps = 0;
    let freshIdle = false;
    while (steps < DRAIN_LIMIT) {
      const current = await deliverOne(
        db,
        handler,
        terminateBackend,
        undefined,
        [...gate.deferred, ...failed],
      );
      if (!recordOutcome(report, current)) {
        freshIdle = true;
        break;
      }
      steps += 1;
      if (current.outcome.kind === 'failed') failed.add(current.outcome.subscriptionId);
    }
    // Leftover budget retries known failures only after every other
    // subscription has gone idle, and never retries a failure from this pass.
    if (freshIdle) {
      const retried = new Set<string>();
      while (steps < DRAIN_LIMIT) {
        const current = await deliverOne(
          db,
          handler,
          terminateBackend,
          undefined,
          [...failed, ...retried],
        );
        if (!recordOutcome(report, current)) break;
        steps += 1;
        if (current.outcome.kind === 'failed') {
          retried.add(current.outcome.subscriptionId);
          gate.deferred.add(current.outcome.subscriptionId);
        } else if (advanced(current.outcome)) {
          gate.deferred.delete(current.outcome.subscriptionId);
        }
      }
    }
  } catch (error) {
    if (error instanceof RelayDeliveryError) report.alerts.push(...error.alerts);
    throw new RelayDeliveryError(error, report.alerts);
  } finally {
    for (const id of failed) gate.deferred.add(id);
  }
  const listeners = await countRelayListeners(db);
  if (listeners === 0) report.alerts.push(NO_LISTENER_ALERT);
  return report;
}
