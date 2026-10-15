// contaminated-session.ts — battery §3.2.3. Every class that survives transaction-mode reuse:
// tenant GUC, SET ROLE (T2 membership fixture), search_path, a first-use connection, and
// ALTER ROLE … SET via the superuser credential. Cleanup cost is measured.
// terminations == injected contaminations, including a warm tail that must add zero.
// A replayed server login (PgBouncer restores a tracked parameter onto the replacement
// backend) counts as its own injected contamination: each one is terminated, and a warm
// client afterwards adds none.
import { sql } from 'kysely';
import { kyselyOf, pooled, rawRoot, terminateBackendByPid } from '../client.ts';
import { MAX_RETRY, withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from '../cases/a2-oracle.ts';
import {
  blankEv, drainAppBackends, rawRoleDefault, rawSearchPath, rawSessionGuc, rawSetRole,
  readRows, recordProbe, recoverInjected, type Recovery,
} from '../cases/a3-pgbouncer.ts';

async function freshPool() {
  await drainAppBackends();
  return pooled(1);
}

function directOne() {
  const password = process.env.PLERNI_APP_PASSWORD;
  if (!password) throw new Error('spike: missing env var PLERNI_APP_PASSWORD');
  const dsn = process.env.HARNESS_DIRECT_DSN
    ?? `postgres://plerni_app:${password}@localhost:54320/plerni`;
  return kyselyOf(dsn, 1);
}

function detailOf(rec: Recovery): Record<string, unknown> {
  return {
    terminations: rec.terminations,
    retries: rec.retries,
    cleanupMs: rec.cleanupMs,
    deadPid: rec.deadPid,
    deadGone: rec.deadGone,
    detectedBeforeAccess: rec.detectedBeforeAccess,
    positiveControl: rec.positive,
    absenceOnReplacement: rec.replacementAbsent,
    thrown: rec.thrown,
  };
}

function asCount(detail: Record<string, unknown>): number {
  const n = detail.terminations;
  if (typeof n !== 'number') throw new Error('contamination probe did not report terminations');
  return n;
}

async function setAppTenantDefault(root: ReturnType<typeof rawRoot>, tenant: string): Promise<void> {
  const built = await root.query(
    `SELECT format('ALTER ROLE plerni_app SET plerni.tenant_id = %L', $1::text) AS stmt`,
    [tenant],
  );
  const stmt = built.rows[0]?.stmt;
  if (typeof stmt !== 'string' || !stmt.startsWith('ALTER ROLE plerni_app SET plerni.tenant_id = ')) {
    throw new Error('refusing unexpected role-default statement');
  }
  await root.query(stmt);
}

export async function contaminatedSession(): Promise<void> {
  let injected = 0;
  let terminated = 0;

  // Reuse path: a clean protocol use, then a session GUC on that same backend.
  const warm = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated tenant GUC', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await withTenant(warm, TENANT_B, ev, terminateBackendByPid, readRows);
        const before = ev.terminatedBackendPids.length;
        await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(warm);
        const rec = await recoverInjected(warm, ev, before);
        return { pass: before === 0 && rec.pass, detail: { ...detailOf(rec), warmTerminations: before } };
      },
      rawSessionGuc,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await warm.destroy();
  }

  const role = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated SET ROLE', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET ROLE plerni_plugin_a`.execute(role);
        const rec = await recoverInjected(role, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec) };
      },
      rawSetRole,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await role.destroy();
  }

  // Direct: killing the backend yields a fresh login, so the protocol recovers.
  const directPath = directOne();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'direct(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(directPath);
        const rec = await recoverInjected(directPath, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec) };
      },
      rawSearchPath,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await directPath.destroy();
  }

  // Pooled, PostgreSQL 18: the server reports search_path and PgBouncer restores it on every
  // server connection for this client (pgbouncer.org track_extra_parameters). Terminating the
  // backend cannot clear it; the same client fails loud inside the retry budget. A new client
  // does not inherit the tracked value.
  const path = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'pooled(1)' },
      async () => {
        const pathEv = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(path);
        let loud: string | null = null;
        try {
          await withTenant(path, TENANT_B, pathEv, terminateBackendByPid, readRows);
        } catch (e) {
          loud = e instanceof Error ? e.message : String(e);
        }
        const replayed = pathEv.terminatedBackendPids.length === MAX_RETRY + 1
          && pathEv.alerts.every((a) => a.includes('search_path'));
        const fresh = await freshPool();
        const freshEv = blankEv();
        try {
          await withTenant(fresh, TENANT_B, freshEv, terminateBackendByPid, readRows);
          return {
            pass: loud !== null && loud.includes('loud failure') && replayed && freshEv.terminatedBackendPids.length === 0,
            detail: {
              loud,
              terminations: pathEv.terminatedBackendPids.length,
              alerts: pathEv.alerts,
              freshClientTerminations: freshEv.terminatedBackendPids.length,
              mechanism: 'PgBouncer restores client-tracked search_path onto each new server connection (PostgreSQL 18 reports it)',
            },
          };
        } finally {
          await fresh.destroy();
        }
      },
      rawSearchPath,
    );
    const replays = asCount(observed.detail);
    injected += replays;
    terminated += replays;
  } finally {
    await path.destroy();
  }

  // First protocol use on a connection that has never been clean.
  const first = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated first-use', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(first);
        const rec = await recoverInjected(first, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec) };
      },
      rawSessionGuc,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await first.destroy();
  }

  // Role default re-applies on every login, so killing the backend cannot clear it.
  // The protocol must fail loud inside the retry budget — one termination per contaminated login.
  const root = rawRoot();
  await root.connect();
  let defDb: ReturnType<typeof pooled> | undefined;
  try {
    await setAppTenantDefault(root, TENANT_A);
    await drainAppBackends();
    const db = pooled(1);
    defDb = db;
    const observed = await recordProbe(
      { case: 'battery contaminated ALTER ROLE default', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        const t0 = performance.now();
        let loud: string | null = null;
        try {
          await withTenant(db, TENANT_B, ev, terminateBackendByPid, readRows);
        } catch (e) {
          loud = e instanceof Error ? e.message : String(e);
        }
        const cleanupMs = Math.round(performance.now() - t0);
        const expected = MAX_RETRY + 1;
        return {
          pass: loud !== null && loud.includes('loud failure') && ev.terminatedBackendPids.length === expected,
          detail: { loud, terminations: ev.terminatedBackendPids.length, expected, cleanupMs, alerts: ev.alerts },
        };
      },
      rawRoleDefault,
    );
    const defaults = asCount(observed.detail);
    injected += defaults;
    terminated += defaults;
  } finally {
    await defDb?.destroy();
    await root.query('ALTER ROLE plerni_app RESET plerni.tenant_id');
    await drainAppBackends();
    await root.end();
  }

  const tail = await freshPool();
  try {
    await recordProbe(
      { case: 'battery terminations == injected', datasource: 'pooled(1)' },
      async () => {
        const tailEv = blankEv();
        await withTenant(tail, TENANT_A, tailEv, terminateBackendByPid, readRows);
        await withTenant(tail, TENANT_B, tailEv, terminateBackendByPid, readRows);
        return {
          pass: tailEv.terminatedBackendPids.length === 0 && terminated === injected,
          detail: { injected, terminated, warmTailTerminations: tailEv.terminatedBackendPids.length },
        };
      },
      rawSessionGuc,
    );
  } finally {
    await tail.destroy();
  }
}
