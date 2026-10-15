// SPDX-License-Identifier: Apache-2.0
// contaminated-session.ts — battery §3.2.3. Every class that survives transaction-mode reuse:
// tenant GUC, SET ROLE (T2 membership fixture), search_path, a first-use connection, and
// ALTER ROLE … SET via the superuser credential. Cleanup cost is measured.
// terminations == injected contaminations, including a warm tail that must add zero.
// Injection counts are fixed at the injection site: 1 for a single session SET, and
// MAX_RETRY+1 for a class that contaminates every new login. They are not copied
// from the termination list. A warm client afterwards adds none.
import { sql } from 'kysely';
import { adminShow, direct, pooled, rawApp, terminateBackendByPid } from '../client.ts';
import { MAX_RETRY, withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from '../cases/a2-oracle.ts';
import {
  blankEv, drainAppBackends, rawRoleDefault, rawSearchPath, rawSessionGuc, rawSetRole,
  readRows, recordProbe, recoverInjected, resetAppTenantDefault, setAppTenantDefault, type Recovery,
} from '../cases/a3-pgbouncer.ts';

async function freshPool() {
  await drainAppBackends();
  return pooled(1);
}

function detailOf(rec: Recovery, injectedLogins: number): Record<string, unknown> {
  return {
    terminations: rec.terminations,
    injectedLogins,
    retries: rec.retries,
    cleanupMs: rec.cleanupMs,
    deadPid: rec.deadPid,
    deadGone: rec.deadGone,
    backendGoneMs: rec.backendGoneMs,
    detectedBeforeAccess: rec.detectedBeforeAccess,
    positiveControl: rec.positive,
    absenceOnReplacement: rec.replacementAbsent,
    rivalPid: rec.rivalPid,
    rivalGuc: rec.rivalGuc,
    rivalWaiting: rec.rivalWaiting,
    rivalHeldOff: rec.rivalHeldOff,
    thrown: rec.thrown,
  };
}

function asCount(detail: Record<string, unknown>): number {
  const n = detail.terminations;
  // A probe that threw has already been recorded. Keep the later cases running.
  return typeof n === 'number' ? n : 0;
}

async function searchPathConfig(): Promise<Record<string, unknown>> {
  const config = await adminShow('CONFIG') as Record<string, unknown>[];
  const value = (key: string) => config.find((row) => row.key === key)?.value ?? null;
  const pgbouncerVersion = await adminShow('VERSION');
  const app = rawApp();
  await app.connect();
  try {
    const pg = await app.query(`SELECT current_setting('server_version') AS version`);
    const raw = String(pg.rows[0]?.version ?? '');
    const match = /^[0-9]+(?:\.[0-9]+)*/.exec(raw);
    return {
      track_extra_parameters: value('track_extra_parameters'),
      server_reset_query: value('server_reset_query'),
      server_reset_query_always: value('server_reset_query_always'),
      pgbouncerVersion,
      postgresVersion: match?.[0] ?? null,
    };
  } finally {
    await app.end();
  }
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
        return { pass: before === 0 && rec.pass, detail: { ...detailOf(rec, 1), warmTerminations: before } };
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
        return { pass: rec.pass, detail: detailOf(rec, 1) };
      },
      rawSetRole,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await role.destroy();
  }

  // Direct: killing the backend yields a fresh login, so the protocol recovers.
  const directPath = direct(1);
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'direct(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(directPath);
        const rec = await recoverInjected(directPath, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec, 1) };
      },
      rawSearchPath,
    );
    injected += 1;
    terminated += asCount(observed.detail);
  } finally {
    await directPath.destroy();
  }

  // Pooled: killing the backend while the checkout is still held makes the driver drop that
  // client. The retry is a new client, so a client-tracked search_path is not replayed onto it.
  // Releasing a still-queryable client and killing afterwards is the ordering that leaves the
  // tracked value in place. Config is recorded on the passing path.
  const path = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(path);
        const rec = await recoverInjected(path, ev, 0);
        const searchAlerts = ev.alerts.filter((a) => a.includes('search_path')).length;
        return {
          pass: rec.pass && searchAlerts === 1,
          detail: {
            ...detailOf(rec, 1),
            searchAlerts,
            config: await searchPathConfig(),
            mechanism: 'The driver drops a client whose backend dies during the checkout. The retry is a new client, so client-tracked search_path is not replayed.',
          },
        };
      },
      rawSearchPath,
    );
    injected += 1;
    terminated += asCount(observed.detail);
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
        return { pass: rec.pass, detail: detailOf(rec, 1) };
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
  let defDb: ReturnType<typeof pooled> | undefined;
  try {
    await setAppTenantDefault(TENANT_A);
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
          detail: {
            loud, terminations: ev.terminatedBackendPids.length, injectedLogins: expected,
            expected, cleanupMs, alerts: ev.alerts,
          },
        };
      },
      rawRoleDefault,
    );
    injected += MAX_RETRY + 1;
    terminated += asCount(observed.detail);
  } finally {
    await defDb?.destroy();
    await resetAppTenantDefault();
    await drainAppBackends();
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
          detail: { injected, terminated, warmTailTerminations: tailEv.terminatedBackendPids.length,
            counting: 'injected is the sum of per-class login budgets; terminated is the measured count' },
        };
      },
      rawSessionGuc,
    );
  } finally {
    await tail.destroy();
  }
}
