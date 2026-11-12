// SPDX-License-Identifier: Apache-2.0
// Enablement suite (plan K18). One process. K15 repeats retention on two.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { errorStatus } from '@plerni/contracts';
import { appendEvent, type AppendedEvent } from '../src/bus/append.ts';
import { CATCHUP_BATCH } from '../src/bus/constants.ts';
import { deliverAvailable, type DeliveredEvent } from '../src/bus/deliver.ts';
import { retainLog } from '../src/bus/retain.ts';
import { registerSubscription } from '../src/bus/subscription.ts';
import type { Database } from '../src/db/database.ts';
import { catchUpTenant } from '../src/package/catchup.ts';
import {
  DependencyNotEnabledError,
  ExportRequiredError,
} from '../src/package/errors.ts';
import {
  exportPackage,
  exportSubscription,
  forceAdvancePackage,
  forceAdvanceSubscription,
  installPackage,
  setPackageEnabled,
  type InstallPackageInput,
  type PackageRecord,
} from '../src/package/registry.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { bootstrapOperatorTenant } from '../src/tenant/registry.ts';
import { handleKernelRequest, kernelRequestContext } from '../src/transport/kernel-request.ts';
import {
  FIXTURE_AGGREGATE,
  FIXTURE_TYPE,
  OTHER_TYPE,
  ageSeqs,
  insertCustomer,
  resetBus,
  waitFor,
  withRoot,
} from './bus-support.ts';
import { DIRECT, POOLED, TENANT_A, TENANT_B, appDb, terminate } from './support.ts';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function installInput(id: string, extra: Partial<InstallPackageInput> = {}): InstallPackageInput {
  return {
    id,
    version: '0.1.0',
    digest: digest(id),
    filter: [{ type: FIXTURE_TYPE, versions: [1] }],
    requires: [],
    optionalRequires: [],
    ...extra,
  };
}

async function publish(
  db: Kysely<Database>,
  tenantId: string,
  type: string,
  version: number,
): Promise<AppendedEvent> {
  return appendEvent(
    db,
    tenantId,
    {
      aggregateType: type === FIXTURE_TYPE ? FIXTURE_AGGREGATE : 'kernel.bus',
      type,
      version,
      payload: { marker: type },
    },
    blankEvidence(),
    terminate,
  );
}

async function outboxSeqs(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ seq: string }>`
    SELECT seq::text AS seq FROM kernel.outbox ORDER BY seq`.execute(db);
  return result.rows.map((row) => row.seq);
}

async function cursorOf(db: Kysely<Database>, id: string): Promise<{
  lastSeq: string;
  status: string;
  released: Date | null;
}> {
  const result = await sql<{ last_seq: string; status: string; released_at: Date | null }>`
    SELECT last_seq::text AS last_seq, status, released_at
    FROM kernel.subscription
    WHERE id = ${id}::uuid`.execute(db);
  const row = result.rows[0];
  if (!row) throw new Error('subscription missing');
  return { lastSeq: row.last_seq, status: row.status, released: row.released_at };
}

async function watermark(db: Kysely<Database>, packageId: string, tenantId: string): Promise<string> {
  const result = await sql<{ watermark_seq: string }>`
    SELECT watermark_seq::text AS watermark_seq
    FROM kernel.package_enablement
    WHERE package_id = ${packageId} AND tenant_id = ${tenantId}::uuid`.execute(db);
  const seq = result.rows[0]?.watermark_seq;
  if (seq === undefined) throw new Error('watermark missing');
  return seq;
}

async function grants(pluginId: string): Promise<string[]> {
  return withRoot(async (client) => {
    const result = await client.query<{ grant_name: string }>(
      'SELECT grant_name FROM kernel.plugin_grant WHERE plugin_id = $1 ORDER BY grant_name',
      [pluginId],
    );
    return result.rows.map((row) => row.grant_name);
  });
}

function request(path: string, body: unknown): Request {
  return new Request(`http://kernel.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('one process: A receives the fixture event, B holds past the quota, and only export releases it', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  await insertCustomer(TENANT_B);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const operatorSession = { tenantId: operator.id };
    const installed = await installPackage(
      db,
      operatorSession,
      installInput('fixture_bus'),
      blankEvidence(),
      terminate,
    );
    const parkId = randomUUID();
    await registerSubscription(db, {
      id: parkId,
      filter: [{ type: OTHER_TYPE, versions: [1] }],
      start: 'head',
    });
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, false, blankEvidence(), terminate);
    const held = await watermark(db, installed.id, TENANT_B);
    assert.equal((await cursorOf(db, installed.subscriptionId)).status, 'live');
    assert.deepEqual(await grants(installed.id), []);

    const backlog = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    const parked = await publish(db, TENANT_A, OTHER_TYPE, 1);
    const blocking = await publish(db, TENANT_A, OTHER_TYPE, 2);
    const accepted = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
    await ageSeqs([backlog.seq, parked.seq, blocking.seq, accepted.seq]);
    const seen: { tenantId: string; type: string; version: number }[] = [];
    await deliverAvailable(db, async (_trx, event) => {
      seen.push({ tenantId: event.tenantId, type: event.type, version: event.version });
    }, terminate);

    const fixtureSeen = seen.filter((event) => event.type === FIXTURE_TYPE);
    assert.deepEqual(fixtureSeen, [{ tenantId: TENANT_A, type: FIXTURE_TYPE, version: 1 }]);
    assert.equal(await watermark(db, installed.id, TENANT_A), accepted.seq);
    assert.equal(await watermark(db, installed.id, TENANT_B), held);
    assert.ok(BigInt(held) < BigInt(backlog.seq));
    const installation = await cursorOf(db, installed.subscriptionId);
    assert.equal(installation.status, 'live');
    assert.ok(BigInt(installation.lastSeq) >= BigInt(accepted.seq));
    const parkedCursor = await cursorOf(db, parkId);
    assert.equal(parkedCursor.status, 'parked');
    assert.equal(parkedCursor.lastSeq, parked.seq);
    assert.equal(parkedCursor.released, null);

    const slowestSubscription = await sql<{ seq: string }>`
      SELECT min(last_seq)::text AS seq
      FROM kernel.subscription
      WHERE released_at IS NULL`.execute(db);
    const floor = slowestSubscription.rows[0]?.seq;
    if (!floor) throw new Error('subscription floor missing');
    assert.ok(BigInt(floor) > BigInt(backlog.seq));

    assert.equal(await retainLog(db), 0);
    assert.equal((await outboxSeqs(db)).includes(backlog.seq), true);
    assert.equal((await outboxSeqs(db)).includes(parked.seq), true);
    const quiet = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM kernel.quota_warning
      WHERE package_id = ${installed.id} AND tenant_id = ${TENANT_B}::uuid`.execute(db);
    assert.equal(quiet.rows[0]?.count, '0');

    await withRoot(async (client) => {
      const updated = await client.query(
        `UPDATE kernel.package_enablement
         SET held_since = clock_timestamp() - interval '31 days'
         WHERE package_id = $1 AND tenant_id = $2::uuid`,
        [installed.id, TENANT_B],
      );
      assert.equal(updated.rowCount, 1);
    });
    assert.equal(await retainLog(db), 0);
    assert.equal((await outboxSeqs(db)).includes(backlog.seq), true);
    assert.equal((await outboxSeqs(db)).includes(parked.seq), true);
    const warned = await sql<{ reason: string }>`
      SELECT reason FROM kernel.quota_warning
      WHERE package_id = ${installed.id} AND tenant_id = ${TENANT_B}::uuid`.execute(db);
    assert.equal(warned.rows[0]?.reason, 'age');

    await assert.rejects(
      () => forceAdvancePackage(db, operatorSession, installed.id, TENANT_B, blankEvidence(), terminate),
      ExportRequiredError,
    );
    assert.equal(await retainLog(db), 0);
    assert.equal((await outboxSeqs(db)).includes(backlog.seq), true);
    assert.equal(await watermark(db, installed.id, TENANT_B), held);

    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, true, blankEvidence(), terminate);
    const caught: DeliveredEvent[] = [];
    const delivered = await catchUpTenant(
      db,
      installed.id,
      TENANT_B,
      async (_trx, event) => {
        caught.push(event);
      },
      blankEvidence(),
      terminate,
    );
    assert.equal(delivered, 1);
    assert.equal(caught.length, 1);
    assert.equal(caught[0]?.seq, backlog.seq);
    assert.equal(caught[0]?.tenantId, TENANT_B);
    assert.equal(await watermark(db, installed.id, TENANT_B), backlog.seq);
    assert.deepEqual(await grants(installed.id), []);

    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, false, blankEvidence(), terminate);
    assert.equal((await cursorOf(db, installed.subscriptionId)).status, 'live');
    await exportPackage(db, operatorSession, installed.id, TENANT_B, blankEvidence(), terminate);
    const advanced = await forceAdvancePackage(
      db,
      operatorSession,
      installed.id,
      TENANT_B,
      blankEvidence(),
      terminate,
    );
    assert.ok(BigInt(advanced.watermarkSeq) >= BigInt(accepted.seq));
    const dropped = await retainLog(db);
    assert.ok(dropped >= 1);
    const remaining = await outboxSeqs(db);
    assert.equal(remaining.includes(backlog.seq), false);
    assert.equal(remaining.includes(parked.seq), true);

    await assert.rejects(
      () => forceAdvanceSubscription(db, operatorSession, parkId, blankEvidence(), terminate),
      ExportRequiredError,
    );
    assert.equal((await cursorOf(db, parkId)).released, null);
    await exportSubscription(db, operatorSession, parkId, blankEvidence(), terminate);
    await forceAdvanceSubscription(db, operatorSession, parkId, blankEvidence(), terminate);
    const released = await cursorOf(db, parkId);
    assert.ok(released.released);
    const letter = await sql<{ reason: string }>`
      SELECT reason FROM kernel.dead_letter
      WHERE subscription_id = ${parkId}::uuid AND seq = ${blocking.seq}::bigint`.execute(db);
    assert.equal(letter.rows[0]?.reason, 'FORCE_ADVANCE');
  } finally {
    await db.destroy();
  }
});

test('catch-up stays behind the installation cursor and does not deliver twice', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_batch'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    const seqs: string[] = [];
    for (let i = 0; i < CATCHUP_BATCH + 1; i += 1) {
      const appended = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
      seqs.push(appended.seq);
    }
    await ageSeqs(seqs);
    const ahead = await catchUpTenant(
      db,
      installed.id,
      TENANT_A,
      async () => {
        throw new Error('catch-up passed the installation cursor');
      },
      blankEvidence(),
      terminate,
    );
    assert.equal(ahead, 0);
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    await deliverAvailable(db, async () => {
      throw new Error('a disabled tenant received the event');
    }, terminate);
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    const seen: string[] = [];
    const first = await catchUpTenant(
      db,
      installed.id,
      TENANT_A,
      async (_trx, event) => {
        seen.push(event.seq);
      },
      blankEvidence(),
      terminate,
    );
    assert.equal(first, CATCHUP_BATCH);
    assert.deepEqual(seen, seqs.slice(0, CATCHUP_BATCH));
    const relayAgain: string[] = [];
    await deliverAvailable(db, async (_trx, event) => {
      relayAgain.push(event.seq);
    }, terminate);
    assert.deepEqual(relayAgain, [seqs[CATCHUP_BATCH]]);
    const second = await catchUpTenant(
      db,
      installed.id,
      TENANT_A,
      async () => {
        throw new Error('the relay catch-up already delivered the last event');
      },
      blankEvidence(),
      terminate,
    );
    assert.equal(second, 0);
    const markers = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM kernel.delivery
      WHERE subscription_id = ${installed.subscriptionId}::uuid`.execute(db);
    assert.equal(markers.rows[0]?.count, String(seqs.length));
  } finally {
    await db.destroy();
  }
});

test('re-enable does not advance the watermark past retained backlog', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_gap'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    const older = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
    await ageSeqs([older.seq]);
    await deliverAvailable(db, async () => {
      throw new Error('disabled tenant received the older event');
    }, terminate);
    const frozen = await watermark(db, installed.id, TENANT_A);
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    const newer = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
    await ageSeqs([newer.seq]);
    assert.ok(BigInt(frozen) < BigInt(newer.seq));
    const caught: string[] = [];
    await deliverAvailable(db, async (_trx, event) => {
      caught.push(event.seq);
    }, terminate);
    assert.deepEqual(caught, [older.seq, newer.seq]);
    assert.equal(await watermark(db, installed.id, TENANT_A), newer.seq);
  } finally {
    await db.destroy();
  }
});

test('a caught-up enabled watermark moves across events it does not consume', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_quiet'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    const first = await publish(db, TENANT_A, OTHER_TYPE, 1);
    const second = await publish(db, TENANT_A, OTHER_TYPE, 1);
    await ageSeqs([first.seq, second.seq]);
    await deliverAvailable(db, async () => {
      throw new Error('a filtered type was delivered');
    }, terminate);
    assert.equal(await watermark(db, installed.id, TENANT_A), second.seq);
    assert.equal((await cursorOf(db, installed.subscriptionId)).lastSeq, second.seq);
    await retainLog(db);
    const remaining = await outboxSeqs(db);
    assert.equal(remaining.includes(first.seq), false);
    assert.equal(remaining.includes(second.seq), true);
  } finally {
    await db.destroy();
  }
});

test('force-advance cannot release backlog past the tenant export', async () => {
  await resetBus();
  await insertCustomer(TENANT_B);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const session = { tenantId: operator.id };
    const installed = await installPackage(
      db,
      session,
      installInput('fixture_export'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, false, blankEvidence(), terminate);
    const covered = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    await ageSeqs([covered.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    const exported = await exportPackage(db, session, installed.id, TENANT_B, blankEvidence(), terminate);
    assert.equal(exported.exportedThroughSeq, covered.seq);
    const later = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    await ageSeqs([later.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    const advanced = await forceAdvancePackage(
      db,
      session,
      installed.id,
      TENANT_B,
      blankEvidence(),
      terminate,
    );
    assert.equal(advanced.watermarkSeq, covered.seq);
    await retainLog(db);
    assert.equal((await outboxSeqs(db)).includes(covered.seq), true);
    assert.equal((await outboxSeqs(db)).includes(later.seq), true);
    await exportPackage(db, session, installed.id, TENANT_B, blankEvidence(), terminate);
    const released = await forceAdvancePackage(
      db,
      session,
      installed.id,
      TENANT_B,
      blankEvidence(),
      terminate,
    );
    assert.equal(released.watermarkSeq, later.seq);
    await retainLog(db);
    const remaining = await outboxSeqs(db);
    assert.equal(remaining.includes(covered.seq), false);
    assert.equal(remaining.includes(later.seq), true);
  } finally {
    await db.destroy();
  }
});

test('requires blocks enablement and optionalRequires does not', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const session = { tenantId: operator.id };
    const edge = { plugin: 'fixture_base', contract: 'fixture_base.port', range: '>=0.1.0' };
    await installPackage(db, session, installInput('fixture_base', { filter: [] }), blankEvidence(), terminate);
    await installPackage(
      db,
      session,
      installInput('fixture_need', { filter: [], requires: [edge] }),
      blankEvidence(),
      terminate,
    );
    await assert.rejects(
      () => setPackageEnabled(db, { tenantId: TENANT_A }, 'fixture_need', true, blankEvidence(), terminate),
      DependencyNotEnabledError,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, 'fixture_base', true, blankEvidence(), terminate);
    const enabled = await setPackageEnabled(
      db,
      { tenantId: TENANT_A },
      'fixture_need',
      true,
      blankEvidence(),
      terminate,
    );
    assert.equal(enabled.enabled, true);
    await installPackage(
      db,
      session,
      installInput('fixture_opt', {
        filter: [],
        optionalRequires: [{ plugin: 'fixture_absent', contract: 'fixture_absent.port', range: '*' }],
      }),
      blankEvidence(),
      terminate,
    );
    const optional = await setPackageEnabled(
      db,
      { tenantId: TENANT_A },
      'fixture_opt',
      true,
      blankEvidence(),
      terminate,
    );
    assert.equal(optional.enabled, true);
  } finally {
    await db.destroy();
  }
});

test('enablement routes use the envelope and do not widen grants', async () => {
  const unauthenticated = await handleKernelRequest(request('/kernel/packages', { id: 'fixture_grant' }), {
    session: null,
    createTenant: async () => {
      throw new Error('unexpected');
    },
  });
  assert.equal(unauthenticated.status, errorStatus('UNAUTHENTICATED'));

  await resetBus();
  await insertCustomer(TENANT_A);
  const approved = ['db.own_schema', 'events.subscribe:fixture_publisher.note.recorded'];
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.plugin_grant WHERE plugin_id = $1', ['fixture_grant']);
    for (const grant of approved) {
      await client.query(
        'INSERT INTO kernel.plugin_grant (plugin_id, grant_name) VALUES ($1, $2)',
        ['fixture_grant', grant],
      );
    }
  });
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const ctx = kernelRequestContext({
      session: { tenantId: operator.id },
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
    });
    const body = installInput('fixture_grant', { filter: [] });
    const customer = await handleKernelRequest(request('/kernel/packages', body), {
      ...ctx,
      session: { tenantId: TENANT_A },
    });
    assert.equal(customer.status, errorStatus('FORBIDDEN'));
    const installed = await handleKernelRequest(request('/kernel/packages', body), ctx);
    assert.equal(installed.status, 201);
    const created = await installed.json() as PackageRecord;
    assert.equal(created.id, 'fixture_grant');
    assert.deepEqual(await grants('fixture_grant'), approved);

    const tenantCtx = kernelRequestContext({
      session: { tenantId: TENANT_A },
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
    });
    const widened = await handleKernelRequest(
      request('/kernel/package-enablement', { packageId: 'fixture_grant', enabled: true, grants: ['audit.append'] }),
      tenantCtx,
    );
    assert.equal(widened.status, errorStatus('VALIDATION'));
    assert.deepEqual(await grants('fixture_grant'), approved);
    const enabled = await handleKernelRequest(
      request('/kernel/package-enablement', { packageId: 'fixture_grant', enabled: true }),
      tenantCtx,
    );
    assert.equal(enabled.status, 200);
    assert.deepEqual(await grants('fixture_grant'), approved);
    const before = await watermark(db, 'fixture_grant', TENANT_A);

    const refused = await handleKernelRequest(
      request('/kernel/package-force-advance', { packageId: 'fixture_grant', tenantId: TENANT_A }),
      ctx,
    );
    assert.equal(refused.status, errorStatus('FORBIDDEN'));
    const refusal = await refused.json() as { code: string; next_step: string };
    assert.equal(refusal.code, 'FORBIDDEN');
    assert.match(refusal.next_step, /export/i);
    assert.equal(await watermark(db, 'fixture_grant', TENANT_A), before);

    const disabled = await handleKernelRequest(
      request('/kernel/package-enablement', { packageId: 'fixture_grant', enabled: false }),
      tenantCtx,
    );
    assert.equal(disabled.status, 200);
    const exported = await handleKernelRequest(
      request('/kernel/package-export', { packageId: 'fixture_grant', tenantId: TENANT_A }),
      ctx,
    );
    assert.equal(exported.status, 200);
    const advanced = await handleKernelRequest(
      request('/kernel/package-force-advance', { packageId: 'fixture_grant', tenantId: TENANT_A }),
      ctx,
    );
    assert.equal(advanced.status, 200);
    const advancedBody = await advanced.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(advancedBody).sort(), ['packageId', 'tenantId', 'watermarkSeq']);
    assert.equal(advancedBody.packageId, 'fixture_grant');
    assert.equal(advancedBody.tenantId, TENANT_A);
    assert.equal(advancedBody.enabled, undefined);

    const app = new pg.Client({ connectionString: DIRECT });
    app.on('error', () => undefined);
    await app.connect();
    try {
      await assert.rejects(
        () => app.query(
          `INSERT INTO kernel.plugin_grant (plugin_id, grant_name) VALUES ('fixture_grant', 'audit.append')`,
        ),
        (error: { code?: string }) => error.code === '42501',
      );
    } finally {
      await app.end();
    }
    assert.deepEqual(await grants('fixture_grant'), approved);
  } finally {
    await db.destroy();
  }
});

test('force-advance keeps a later unexported event in the log', async () => {
  await resetBus();
  await insertCustomer(TENANT_B);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const session = { tenantId: operator.id };
    const installed = await installPackage(
      db,
      session,
      installInput('fixture_hold'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, false, blankEvidence(), terminate);
    const covered = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    await ageSeqs([covered.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    await exportPackage(db, session, installed.id, TENANT_B, blankEvidence(), terminate);
    await forceAdvancePackage(db, session, installed.id, TENANT_B, blankEvidence(), terminate);
    const middle = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    const last = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    await ageSeqs([middle.seq, last.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    await retainLog(db);
    const remaining = await outboxSeqs(db);
    assert.equal(remaining.includes(middle.seq), true);
    assert.equal(remaining.includes(last.seq), true);
  } finally {
    await db.destroy();
  }
});

test('repeating disable does not restart the quota clock', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_clock'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    await withRoot(async (client) => {
      const updated = await client.query(
        `UPDATE kernel.package_enablement
         SET held_since = clock_timestamp() - interval '31 days'
         WHERE package_id = $1 AND tenant_id = $2::uuid`,
        [installed.id, TENANT_A],
      );
      assert.equal(updated.rowCount, 1);
    });
    const readHeld = async (): Promise<string> => {
      const result = await sql<{ held_since: Date }>`
        SELECT held_since
        FROM kernel.package_enablement
        WHERE package_id = ${installed.id} AND tenant_id = ${TENANT_A}::uuid`.execute(db);
      const held = result.rows[0]?.held_since;
      if (!held) throw new Error('hold clock missing');
      return held.toISOString();
    };
    const before = await readHeld();
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    assert.equal(await readHeld(), before);
    await retainLog(db);
    const warned = await sql<{ reason: string }>`
      SELECT reason FROM kernel.quota_warning
      WHERE package_id = ${installed.id} AND tenant_id = ${TENANT_A}::uuid`.execute(db);
    assert.equal(warned.rows[0]?.reason, 'age');
  } finally {
    await db.destroy();
  }
});

test('re-enable through the route resumes catch-up past one batch', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const operatorCtx = kernelRequestContext({
      session: { tenantId: operator.id },
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
    });
    const tenantCtx = kernelRequestContext({
      session: { tenantId: TENANT_A },
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
    });
    const created = await handleKernelRequest(
      request('/kernel/packages', installInput('fixture_resume')),
      operatorCtx,
    );
    assert.equal(created.status, 201);
    const disabled = await handleKernelRequest(
      request('/kernel/package-enablement', { packageId: 'fixture_resume', enabled: false }),
      tenantCtx,
    );
    assert.equal(disabled.status, 200);
    const seqs: string[] = [];
    for (let i = 0; i < CATCHUP_BATCH + 1; i += 1) {
      const appended = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
      seqs.push(appended.seq);
    }
    await ageSeqs(seqs);
    await deliverAvailable(db, async () => {
      throw new Error('disabled tenant received an event');
    }, terminate);
    const enabled = await handleKernelRequest(
      request('/kernel/package-enablement', { packageId: 'fixture_resume', enabled: true }),
      tenantCtx,
    );
    assert.equal(enabled.status, 200);
    const seen: string[] = [];
    const first = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.equal(first.delivered, CATCHUP_BATCH);
    assert.equal(first.budgetExhausted, true);
    assert.deepEqual(seen, seqs.slice(0, CATCHUP_BATCH));
    const second = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, seqs);
    assert.equal(second.budgetExhausted, false);
  } finally {
    await db.destroy();
  }
});

test('catch-up locks the subscription before the enablement row', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 2);
  const relay = new pg.Client({ connectionString: DIRECT });
  relay.on('error', () => undefined);
  await relay.connect();
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_lock'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    await relay.query('BEGIN');
    await relay.query("SET LOCAL statement_timeout = '3s'");
    await relay.query(
      'SELECT id FROM kernel.subscription WHERE id = $1::uuid FOR UPDATE',
      [installed.subscriptionId],
    );
    let catchError: unknown = null;
    let catchDone = false;
    const catching = catchUpTenant(
      db,
      installed.id,
      TENANT_A,
      async () => undefined,
      blankEvidence(),
      terminate,
    ).then(() => {
      catchDone = true;
    }, (error: unknown) => {
      catchError = error;
      catchDone = true;
    });
    await waitFor('catch-up waits on the subscription', async () => {
      if (catchError) throw catchError;
      if (catchDone) throw new Error('catch-up finished without waiting');
      return withRoot(async (client) => {
        const waiting = await client.query(
          `SELECT l.locktype, l.mode
           FROM pg_locks AS l
           JOIN pg_stat_activity AS a ON a.pid = l.pid
           WHERE a.usename = 'plerni_app'
             AND NOT l.granted`,
        );
        return (waiting.rowCount ?? 0) > 0;
      });
    }, () => withRoot(async (client) => {
      const activity = await client.query(
        `SELECT a.state, a.wait_event_type, a.wait_event, left(a.query, 120) AS query
         FROM pg_stat_activity AS a
         WHERE a.usename = 'plerni_app'`,
      );
      return JSON.stringify(activity.rows);
    }));
    await relay.query(
      'SELECT package_id FROM kernel.package_enablement WHERE package_id = $1 FOR UPDATE',
      [installed.id],
    );
    await relay.query('COMMIT');
    await catching;
    assert.equal(catchError, null);
  } finally {
    await relay.query('ROLLBACK').catch(() => undefined);
    await relay.end();
    await db.destroy();
  }
});

test('a failing catch-up tenant does not block the next tenant', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  await insertCustomer(TENANT_B);
  const db = appDb(POOLED, 2);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_split'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, false, blankEvidence(), terminate);
    const failed = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
    const healthy = await publish(db, TENANT_B, FIXTURE_TYPE, 1);
    await ageSeqs([failed.seq, healthy.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    await setPackageEnabled(db, { tenantId: TENANT_B }, installed.id, true, blankEvidence(), terminate);
    const seen: string[] = [];
    const blocked = await deliverAvailable(db, async (_trx, event) => {
      if (event.tenantId === TENANT_A) throw new Error('tenant A handler failed');
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [healthy.seq]);
    assert.ok(blocked.alerts.includes('handler failed'));
    assert.ok(BigInt(await watermark(db, installed.id, TENANT_A)) < BigInt(failed.seq));
    const recovered: string[] = [];
    await deliverAvailable(db, async (_trx, event) => {
      recovered.push(event.seq);
    }, terminate);
    assert.deepEqual(recovered, [failed.seq]);
  } finally {
    await db.destroy();
  }
});

test('catch-up keeps a contamination alert on the relay report', async () => {
  await resetBus();
  await insertCustomer(TENANT_A);
  const db = appDb(POOLED, 1);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const installed = await installPackage(
      db,
      { tenantId: operator.id },
      installInput('fixture_alert'),
      blankEvidence(),
      terminate,
    );
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, false, blankEvidence(), terminate);
    const appended = await publish(db, TENANT_A, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    await deliverAvailable(db, async () => undefined, terminate);
    await setPackageEnabled(db, { tenantId: TENANT_A }, installed.id, true, blankEvidence(), terminate);
    await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(db);
    const seen: string[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [appended.seq]);
    assert.ok(report.alerts.some((alert) => alert.includes('SECURITY contamination')));
  } finally {
    await db.destroy();
  }
});
