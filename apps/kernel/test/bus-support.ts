// SPDX-License-Identifier: Apache-2.0
import pg from 'pg';
import { ROOT, ready } from './support.ts';

export const FIXTURE_TYPE = 'fixture_publisher.note.recorded';
export const FIXTURE_AGGREGATE = 'fixture_publisher.note';
export const OTHER_TYPE = 'kernel.bus.signaled';

export async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function resetBus(): Promise<void> {
  await ready();
  await withRoot(async (client) => {
    await client.query('DROP TABLE IF EXISTS kernel.bus_effect');
    await client.query('DELETE FROM kernel.dead_letter');
    await client.query('DELETE FROM kernel.delivery');
    await client.query('DELETE FROM kernel.subscription');
    await client.query('DELETE FROM kernel.service_credential');
    await client.query('DELETE FROM kernel.service_principal_scope');
    await client.query('DELETE FROM kernel.service_principal');
    await client.query('DELETE FROM kernel.job_dispatch');
    await client.query('DELETE FROM kernel.password_reset');
    await client.query('DELETE FROM kernel.rescue_code');
    await client.query('DELETE FROM kernel.session');
    await client.query('DELETE FROM kernel.login_throttle');
    await client.query('DELETE FROM kernel.auth_audit');
    await client.query('DELETE FROM kernel.user_auth_state');
    await client.query('DELETE FROM kernel.user_account');
    await client.query('DELETE FROM kernel.tenant_auth_policy');
    await client.query('DELETE FROM kernel.outbox');
    await client.query('DELETE FROM kernel.tenant_idempotency');
    await client.query('DELETE FROM kernel.audit_record');
    await client.query('DELETE FROM kernel.tenants');
  });
}

export async function insertCustomer(id: string): Promise<void> {
  await withRoot(async (client) => {
    await client.query(
      `INSERT INTO kernel.tenants (id, kind, aggregate_version)
       VALUES ($1::uuid, 'customer', 0)`,
      [id],
    );
  });
}

export async function ageSeqs(seqs: readonly string[]): Promise<void> {
  if (seqs.length === 0) throw new Error('no seq to age');
  await withRoot(async (client) => {
    const updated = await client.query(
      `UPDATE kernel.outbox
       SET created_at = clock_timestamp() - interval '11 seconds'
       WHERE seq::text = ANY($1::text[])`,
      [seqs],
    );
    if (updated.rowCount !== seqs.length) {
      throw new Error(`aged ${updated.rowCount ?? 0} of ${seqs.length} rows`);
    }
  });
}

export async function createEffectTable(): Promise<void> {
  await withRoot(async (client) => {
    await client.query(`
      CREATE TABLE kernel.bus_effect (
        subscription_id uuid NOT NULL,
        seq bigint NOT NULL,
        idempotency_key text NOT NULL,
        PRIMARY KEY (subscription_id, seq)
      )`);
    await client.query('GRANT SELECT, INSERT ON TABLE kernel.bus_effect TO plerni_app');
  });
}

/** The deadline fails a missed barrier. Callers wait on a row or a lock. */
export async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  detail?: () => Promise<string>,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    if (await probe()) return;
    if (performance.now() >= deadline) {
      const extra = detail ? await detail().catch((error: unknown) => String(error)) : '';
      throw new Error(`deadline: ${label}${extra ? ` ${extra}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function errorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
