// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractFailure, errorStatus } from '@plerni/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { listNotifications, sendNotification } from '../src/notify/deliver.ts';
import { recordNotificationPreference } from '../src/notify/preference.ts';
import { inspectTenantTable } from '../src/schema/tenant-table.ts';
import { blankEvidence, withTenant } from '../src/tenancy/hygiene.ts';
import { handleKernelRequest, kernelRequestContext } from '../src/transport/kernel-request.ts';
import { DIRECT, POOLED, ROOT, appDb, ready, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RECIPIENT = '33333333-3333-4333-8333-333333333333';
const SENDER = '55555555-5555-4555-8555-555555555555';
const COPY = 'plugin-copy-alpha';

const sender = { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] as const };
const recipient = { tenantId: TENANT, actorId: RECIPIENT };

function sendInput(overrides: Partial<{ idempotencyKey: string; recipientId: string; channel: string; body: string }> = {}) {
  return {
    idempotencyKey: 'announce-1',
    recipientId: RECIPIENT,
    channel: 'in_app',
    body: COPY,
    ...overrides,
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

async function resetNotify(): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.notification_delivery');
    await client.query('DELETE FROM kernel.notification_preference');
  });
}

async function counts(tenantId: string): Promise<{ delivered: number; rows: number; preferences: number }> {
  const db = appDb(DIRECT, 1);
  try {
    return await withTenant(db, tenantId, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ delivered: string; rows: string; preferences: string }>`
        SELECT
          (SELECT count(*) FROM kernel.notification_delivery WHERE outcome = 'delivered')::text AS delivered,
          (SELECT count(*) FROM kernel.notification_delivery)::text AS rows,
          (SELECT count(*) FROM kernel.notification_preference)::text AS preferences`.execute(trx);
      const row = result.rows[0];
      if (!row) throw new Error('count returned no row');
      return {
        delivered: Number(row.delivered),
        rows: Number(row.rows),
        preferences: Number(row.preferences),
      };
    });
  } finally {
    await db.destroy();
  }
}

function request(path: string, body?: unknown, method = 'POST'): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://kernel.test${path}`, init);
}

async function read(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('the kernel stores the rendered text and no message pattern', () => {
  const sqlText = readFileSync(join(here, '../sql/0006_notifications.sql'), 'utf8');
  const sources = [sqlText];
  const notifyDir = join(here, '../src/notify');
  for (const name of readdirSync(notifyDir)) {
    if (name.endsWith('.ts')) sources.push(readFileSync(join(notifyDir, name), 'utf8'));
  }
  sources.push(readFileSync(join(here, '../src/transport/notify-request.ts'), 'utf8'));
  for (const source of sources) assert.equal(/\btemplate\b/i.test(source), false);
  assert.equal(sqlText.includes('content_digest'), false);
  assert.match(sqlText, /\bbody text NOT NULL\b/);
});

test('a missing session on the send route is UNAUTHENTICATED and does not send', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/kernel/notifications', sendInput()), {
    session: null,
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, errorStatus('UNAUTHENTICATED'));
  const body = await read(response);
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.match(String(body.next_step), /tenant session/);
  assert.equal(called, 0);
});

test('a session without an actor is UNAUTHENTICATED', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/kernel/notification-preferences', {
    channel: 'in_app',
    enabled: true,
  }), {
    session: { tenantId: TENANT },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    recordNotificationPreference: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, 401);
  const body = await read(response);
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(called, 0);
});

test('a caller without notify.send is FORBIDDEN and does not send', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/kernel/notifications', sendInput()), {
    session: { tenantId: TENANT, actorId: SENDER, grants: ['storage.prefix'] },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, 403);
  const body = await read(response);
  assert.equal(body.code, 'FORBIDDEN');
  assert.match(String(body.next_step), /notify\.send/);
  assert.equal(called, 0);
});

test('a rejected notification body is VALIDATION and does not send', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/kernel/notifications', {
    idempotencyKey: 'bad key',
    recipientId: RECIPIENT,
    channel: 'in_app',
    body: COPY,
  }), {
    session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, 400);
  const body = await read(response);
  assert.equal(body.code, 'VALIDATION');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(called, 0);
});

test('service failures use the error envelope and do not echo the thrown text', async () => {
  const missing = await handleKernelRequest(request('/kernel/notifications', sendInput()), {
    session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      throw new ContractFailure({
        code: 'NOT_FOUND',
        message: 'No notification preference is recorded for this recipient.',
        next_step: 'Record the recipient preference for the in_app channel, then send again.',
      });
    },
  });
  assert.equal(missing.status, 404);
  const missingBody = await read(missing);
  assert.equal(missingBody.code, 'NOT_FOUND');
  assert.equal(typeof missingBody.next_step, 'string');

  const conflict = await handleKernelRequest(request('/kernel/notifications', sendInput()), {
    session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      throw new ContractFailure({
        code: 'CONCURRENCY_CONFLICT',
        message: 'The idempotency key is already bound to a different notification.',
        next_step: 'Retry the original send, or choose a new idempotency key.',
      });
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await read(conflict)).code, 'CONCURRENCY_CONFLICT');

  const broken = await handleKernelRequest(request('/kernel/notifications', sendInput()), {
    session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    createTenant: async () => {
      throw new Error('unexpected');
    },
    sendNotification: async () => {
      throw new Error('driver detail must stay internal');
    },
  });
  assert.equal(broken.status, 500);
  const brokenBody = await read(broken);
  assert.equal(brokenBody.code, 'INTERNAL');
  assert.equal(JSON.stringify(brokenBody).includes('driver detail'), false);
});

test('records one preference and a later record updates that row', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    const first = await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const second = await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: false }, blankEvidence(), terminate,
    );
    assert.equal(second.id, first.id);
    assert.equal(second.recipientId, RECIPIENT);
    assert.equal(second.enabled, false);
    const tally = await counts(TENANT);
    assert.equal(tally.preferences, 1);
    assert.equal(tally.rows, 0);
  } finally {
    await db.destroy();
  }
});

test('delivers once, and a duplicate send does not deliver again', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const first = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    const second = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    assert.equal(first.outcome, 'delivered');
    assert.equal(second.id, first.id);
    assert.equal(second.outcome, 'delivered');
    assert.equal(second.body, COPY);
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 1);
    assert.equal(tally.rows, 1);
    const stored = await withRoot(async (client) => {
      const result = await client.query<{ body: string }>('SELECT body FROM kernel.notification_delivery');
      return result.rows;
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.body, COPY);
  } finally {
    await db.destroy();
  }
});

test('a different message with the same key does not deliver again', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const first = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    await assert.rejects(
      () => sendNotification(db, sender, sendInput({ body: 'plugin-copy-beta' }), blankEvidence(), terminate),
      (error: unknown) => error instanceof ContractFailure && error.code === 'CONCURRENCY_CONFLICT',
    );
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 1);
    assert.equal(tally.rows, 1);
    const again = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    assert.equal(again.id, first.id);
  } finally {
    await db.destroy();
  }
});

test('a disabled preference suppresses delivery and a duplicate stays suppressed', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: false }, blankEvidence(), terminate,
    );
    const first = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const second = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    assert.equal(first.outcome, 'suppressed');
    assert.equal(second.id, first.id);
    assert.equal(second.outcome, 'suppressed');
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 0);
    assert.equal(tally.rows, 1);
  } finally {
    await db.destroy();
  }
});

test('a blank message does not deliver', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    await assert.rejects(
      () => sendNotification(db, sender, sendInput({ body: '   ' }), blankEvidence(), terminate),
      (error: unknown) => error instanceof ContractFailure && error.code === 'VALIDATION',
    );
    const tally = await counts(TENANT);
    assert.equal(tally.rows, 0);
    assert.equal(tally.delivered, 0);
  } finally {
    await db.destroy();
  }
});

test('the same key for another recipient does not deliver again', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const otherRecipient = '66666666-6666-4666-8666-666666666666';
    await recordNotificationPreference(
      db,
      { tenantId: TENANT, actorId: otherRecipient },
      { channel: 'in_app', enabled: true },
      blankEvidence(),
      terminate,
    );
    await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    await assert.rejects(
      () => sendNotification(
        db, sender, sendInput({ recipientId: otherRecipient }), blankEvidence(), terminate,
      ),
      (error: unknown) => error instanceof ContractFailure && error.code === 'CONCURRENCY_CONFLICT',
    );
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 1);
    assert.equal(tally.rows, 1);
  } finally {
    await db.destroy();
  }
});

test('a send with no preference does not deliver', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await assert.rejects(
      () => sendNotification(db, sender, sendInput(), blankEvidence(), terminate),
      (error: unknown) => error instanceof ContractFailure && error.code === 'NOT_FOUND' && error.next_step.length > 0,
    );
    const tally = await counts(TENANT);
    assert.equal(tally.rows, 0);
    assert.equal(tally.delivered, 0);
  } finally {
    await db.destroy();
  }
});

test('a caller without the grant does not write a delivery', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    await assert.rejects(
      () => sendNotification(
        db,
        { tenantId: TENANT, actorId: SENDER, grants: [] },
        sendInput(),
        blankEvidence(),
        terminate,
      ),
      (error: unknown) => error instanceof ContractFailure && error.code === 'FORBIDDEN',
    );
    const tally = await counts(TENANT);
    assert.equal(tally.rows, 0);
  } finally {
    await db.destroy();
  }
});

test('another tenant cannot see the delivery, and the same key there is a separate row', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    const first = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    const hidden = await counts(OTHER);
    assert.equal(hidden.rows, 0);
    assert.equal(hidden.preferences, 0);
    await recordNotificationPreference(
      db,
      { tenantId: OTHER, actorId: RECIPIENT },
      { channel: 'in_app', enabled: true },
      blankEvidence(),
      terminate,
    );
    const second = await sendNotification(
      db,
      { tenantId: OTHER, actorId: SENDER, grants: ['notify.send'] },
      sendInput(),
      blankEvidence(),
      terminate,
    );
    assert.notEqual(second.id, first.id);
    const home = await counts(TENANT);
    const away = await counts(OTHER);
    assert.equal(home.delivered, 1);
    assert.equal(away.delivered, 1);
  } finally {
    await db.destroy();
  }
});

test('notification tables match the tenant shape and hide rows when the tenant is unset', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
    await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
  } finally {
    await db.destroy();
  }
  await withRoot(async (client) => {
    assert.deepEqual(await inspectTenantTable(client, { schema: 'kernel', table: 'notification_preference' }), []);
    assert.deepEqual(await inspectTenantTable(client, { schema: 'kernel', table: 'notification_delivery' }), []);
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'notification_delivery'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'tenant_id', 'id', 'idempotency_key', 'recipient_id', 'channel', 'body', 'outcome', 'created_at',
    ]);
  });
  const app = new pg.Client({ connectionString: DIRECT });
  await app.connect();
  try {
    const seen = await app.query('SELECT id FROM kernel.notification_delivery');
    assert.equal(seen.rows.length, 0);
    await app.query('BEGIN');
    await assert.rejects(
      () => app.query('DELETE FROM kernel.notification_delivery'),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await assert.rejects(
      () => app.query('UPDATE kernel.notification_delivery SET outcome = \'delivered\''),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
    await app.query('ROLLBACK');
  } finally {
    await app.end();
  }
});

function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  let openGate: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) openGate();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('race barrier timed out')), 10_000);
      void opened.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
  };
}

test('two pooled sends that both miss the key leave one delivery', async () => {
  await ready();
  await resetNotify();
  const setup = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      setup, recipient, { channel: 'in_app', enabled: true }, blankEvidence(), terminate,
    );
  } finally {
    await setup.destroy();
  }
  const left = appDb(POOLED, 1);
  const right = appDb(POOLED, 1);
  try {
    const arrived = rendezvous(2);
    const [first, second] = await Promise.all([
      sendNotification(left, sender, sendInput({ idempotencyKey: 'race-send' }), blankEvidence(), terminate, arrived),
      sendNotification(right, sender, sendInput({ idempotencyKey: 'race-send' }), blankEvidence(), terminate, arrived),
    ]);
    assert.equal(second.id, first.id);
    assert.equal(first.outcome, 'delivered');
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 1);
    assert.equal(tally.rows, 1);
  } finally {
    await left.destroy();
    await right.destroy();
  }
});

test('the http route delivers once and the recipient can read the stored text', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    const session = { tenantId: TENANT, actorId: RECIPIENT, grants: ['notify.send'] };
    const ctx = kernelRequestContext({
      session,
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
    });
    const recorded = await handleKernelRequest(request('/kernel/notification-preferences', {
      channel: 'in_app',
      enabled: true,
    }), ctx);
    assert.equal(recorded.status, 200);
    const preference = await read(recorded);
    assert.equal(preference.recipientId, RECIPIENT);
    assert.equal(preference.enabled, true);
    const payload = {
      idempotencyKey: 'http-1',
      recipientId: RECIPIENT,
      channel: 'in_app',
      body: COPY,
    };
    const first = await handleKernelRequest(request('/kernel/notifications', payload), {
      ...ctx,
      session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    });
    const second = await handleKernelRequest(request('/kernel/notifications', payload), {
      ...ctx,
      session: { tenantId: TENANT, actorId: SENDER, grants: ['notify.send'] },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = await read(first);
    const secondBody = await read(second);
    assert.equal(firstBody.outcome, 'delivered');
    assert.equal(firstBody.body, COPY);
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(secondBody.body, COPY);
    const tally = await counts(TENANT);
    assert.equal(tally.delivered, 1);
    assert.equal(tally.rows, 1);
    const inbox = await handleKernelRequest(request('/kernel/notifications', undefined, 'GET'), {
      ...ctx,
      session: { tenantId: TENANT, actorId: RECIPIENT },
    });
    assert.equal(inbox.status, 200);
    const listed = await read(inbox);
    const deliveries = listed.deliveries as { id?: string; body?: string }[];
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.id, firstBody.id);
    assert.equal(deliveries[0]?.body, COPY);
    const otherInbox = await handleKernelRequest(request('/kernel/notifications', undefined, 'GET'), {
      ...ctx,
      session: { tenantId: TENANT, actorId: SENDER },
    });
    assert.equal(otherInbox.status, 200);
    assert.deepEqual((await read(otherInbox)).deliveries, []);
  } finally {
    await db.destroy();
  }
});

test('an uppercase recipient id delivers once and a different case is the same delivery', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db,
      { tenantId: TENANT, actorId: RECIPIENT.toUpperCase() },
      { channel: 'in_app', enabled: true },
      blankEvidence(),
      terminate,
    );
    const first = await sendNotification(
      db,
      sender,
      sendInput({ recipientId: RECIPIENT.toUpperCase() }),
      blankEvidence(),
      terminate,
    );
    const second = await sendNotification(db, sender, sendInput(), blankEvidence(), terminate);
    assert.equal(first.body, COPY);
    assert.equal(first.recipientId, RECIPIENT);
    assert.equal(second.id, first.id);
    assert.equal(second.body, COPY);
    const inbox = await listNotifications(
      db,
      { tenantId: TENANT.toUpperCase(), actorId: RECIPIENT.toUpperCase() },
      blankEvidence(),
      terminate,
    );
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body, COPY);
    const tally = await counts(TENANT);
    assert.equal(tally.rows, 1);
    assert.equal(tally.delivered, 1);
  } finally {
    await db.destroy();
  }
});

test('a suppressed send is stored once and is not listed to the recipient', async () => {
  await ready();
  await resetNotify();
  const db = appDb(DIRECT, 1);
  try {
    await recordNotificationPreference(
      db, recipient, { channel: 'in_app', enabled: false }, blankEvidence(), terminate,
    );
    const stored = await sendNotification(
      db, sender, sendInput({ idempotencyKey: 'hidden' }), blankEvidence(), terminate,
    );
    assert.equal(stored.outcome, 'suppressed');
    assert.equal(stored.body, COPY);
    const inbox = await listNotifications(db, recipient, blankEvidence(), terminate);
    assert.deepEqual(inbox, []);
    const tally = await counts(TENANT);
    assert.equal(tally.rows, 1);
    assert.equal(tally.delivered, 0);
  } finally {
    await db.destroy();
  }
});
