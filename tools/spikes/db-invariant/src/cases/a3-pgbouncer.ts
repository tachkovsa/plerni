// SPDX-License-Identifier: Apache-2.0
// a3-pgbouncer.ts — A3 (plan §3.1): the full pinned flow through PgBouncer transaction mode.
// A1+A2 stay green on the pooled datasource, including mid-transaction error → rollback →
// context absent. Contamination lifecycle, inside the pinned transaction, before tenant access:
// (i) detection on the executing backend, (ii) privileged termination evicts it (pg_stat_activity),
// (iii) A2(c) absence is checked on the replacement session, (iv) positive control after recovery,
// (v) termination+retry stays within the bounded budget (≤2). Cleanup cost is recorded.
// Shared oracles below are also what the adversarial battery imports.
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  adminShow, direct, poolWaitingCount, pooled, rawApp, rawRoot, terminateBackendByPid, type Db,
} from '../client.ts';
import { record } from '../evidence.ts';
import {
  assertTenantContext, installTenantContext, MAX_RETRY, MissingTenantContextError,
  withTenant, type HygieneEvidence,
} from '../context.ts';
import { TENANT_A, TENANT_B } from './a2-oracle.ts';

const LABELS = ['assignment', 'goal', 'review'];

export interface TenantRow { tenant_id: string; label: string }

export function blankEv(): HygieneEvidence {
  return { terminatedBackendPids: [], attempts: 0, alerts: [] };
}

export async function readRows(trx: Transaction<Db>): Promise<TenantRow[]> {
  const r = await sql<TenantRow>`
    SELECT tenant_id::text AS tenant_id, label FROM plerni_tenant ORDER BY label`.execute(trx);
  return r.rows;
}

export function onlyTenant(rows: TenantRow[], id: string): boolean {
  return rows.length === LABELS.length && rows.every((row, i) => row.tenant_id === id && row.label === LABELS[i]);
}

const BACKEND_GONE_DEADLINE_MS = 2000;

/** Poll until the pid leaves pg_stat_activity. Termination only signals the process. */
export async function backendGone(pid: number): Promise<{ gone: boolean; waitedMs: number }> {
  const started = performance.now();
  const deadline = started + BACKEND_GONE_DEADLINE_MS;
  const c = rawRoot();
  await c.connect();
  try {
    for (;;) {
      const r = await c.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (r.rows.length === 0) return { gone: true, waitedMs: Math.round(performance.now() - started) };
      if (performance.now() >= deadline) return { gone: false, waitedMs: Math.round(performance.now() - started) };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await c.end();
  }
}

/** Drop leftover app backends so the next pooled checkout is a fresh login. */
export async function drainAppBackends(): Promise<void> {
  const c = rawRoot();
  await c.connect();
  try {
    const listed = await c.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE usename = 'plerni_app' AND pid <> pg_backend_pid()`,
    );
    const pids = listed.rows.map((row) => Number(row.pid));
    if (pids.length === 0) return;
    // The zero-timeout form only delivers the signal. Wait until those pids are gone.
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])', [pids]);
    const deadline = performance.now() + BACKEND_GONE_DEADLINE_MS;
    for (;;) {
      const still = await c.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])', [pids]);
      if (still.rows.length === 0) return;
      if (performance.now() >= deadline) {
        throw new Error(`app backends still present after terminate: ${still.rows.map((row) => row.pid).join(',')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await c.end();
  }
}

async function pidOf(trx: Transaction<Db>): Promise<number> {
  const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
  return Number(r.rows[0]!.pid);
}

/** A2(c) on whatever backend this transaction pinned, plus the app guard. */
export async function absenceOn(db: Kysely<Db>): Promise<{ pid: number; absent: boolean; rows: number; guard: boolean }> {
  return db.transaction().execute(async (trx) => {
    const pid = await pidOf(trx);
    const absent = await sql<{ absent: boolean }>`
      SELECT NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL AS absent`.execute(trx);
    let guard = false;
    try {
      await assertTenantContext(trx);
    } catch (e) {
      guard = e instanceof MissingTenantContextError;
    }
    return { pid, absent: absent.rows[0]!.absent === true, rows: (await readRows(trx)).length, guard };
  });
}

function scrub(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (/pass|secret|token|hash/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  });
}

/** Plan §3.0, collected only when an assertion has already failed. */
export async function section30(raw: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let admin: Record<string, unknown>;
  try {
    const [config, databases, users] = await Promise.all([
      adminShow('CONFIG'), adminShow('DATABASES'), adminShow('USERS'),
    ]);
    const cfg = config as Record<string, unknown>[];
    const value = (key: string) => cfg.find((r) => r.key === key)?.value ?? null;
    admin = {
      endpoint: 'pooled db=plerni role=plerni_app',
      pool_mode: value('pool_mode'),
      max_prepared_statements: value('max_prepared_statements'),
      default_pool_size: value('default_pool_size'),
      auth_type: value('auth_type'),
      databases: scrub(databases as Record<string, unknown>[]),
      users: scrub(users as Record<string, unknown>[]),
    };
  } catch (e) {
    admin = { error: e instanceof Error ? e.message : String(e) };
  }
  let rawPg: unknown;
  try {
    rawPg = await raw();
  } catch (e) {
    rawPg = { error: e instanceof Error ? e.message : String(e) };
  }
  return { protocol: 'plan §3.0', environment: { node: process.version }, admin, rawPg };
}

export interface Probe {
  pass: boolean;
  detail: Record<string, unknown>;
}

/**
 * Plan §3.0: a passing assertion is recorded once. A failing one is not labeled —
 * the same probe runs three times, a raw-pg control is attached, and the admin
 * console supplies effective config. Mixed results are an invalid run.
 */
async function takeProbe(probe: () => Promise<Probe>): Promise<Probe> {
  try {
    return await probe();
  } catch (e) {
    return { pass: false, detail: { thrown: e instanceof Error ? e.message : String(e) } };
  }
}

export async function recordProbe(
  meta: { case: string; datasource: string },
  probe: () => Promise<Probe>,
  raw: () => Promise<unknown>,
): Promise<Probe> {
  const first = await takeProbe(probe);
  if (first.pass) {
    record({ ...meta, pass: true, detail: first.detail });
    return first;
  }
  // The caller already knows this run is noise (an upstream probe was invalid).
  // Three identical failures would be recorded as an established failure.
  if (first.detail.outcome === 'environmental-noise') {
    const detail = { ...first.detail, verdict: 'invalid-run-no-verdict' };
    record({ ...meta, pass: false, detail });
    return { pass: false, detail };
  }
  const runs = [false];
  const repeatErrors: string[] = [];
  for (let i = 0; i < 2; i++) {
    const again = await takeProbe(probe);
    runs.push(again.pass);
    if (typeof again.detail.thrown === 'string') repeatErrors.push(again.detail.thrown);
  }
  const noise = runs.some(Boolean);
  const detail = {
    ...first.detail,
    runs,
    repeatErrors,
    outcome: noise ? 'environmental-noise' : 'established-failure',
    verdict: noise ? 'invalid-run-no-verdict' : 'unlabeled-pending-section-3.0',
    section30: await section30(raw),
  };
  record({ ...meta, pass: false, detail });
  return { pass: false, detail };
}

/** Minimal raw-pg script. Each step is a constant; a step error is data, not a thrown miss. */
export async function rawAppSteps(
  steps: readonly { text: string; values?: unknown[]; name?: string }[],
): Promise<unknown[]> {
  const c = rawApp();
  await c.connect();
  const out: unknown[] = [];
  try {
    for (const step of steps) {
      try {
        const r = step.name !== undefined
          ? await c.query({ name: step.name, text: step.text, values: step.values ?? [] })
          : step.values === undefined
            ? await c.query(step.text)
            : await c.query(step.text, step.values);
        out.push(r.rows);
      } catch (e) {
        const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
        out.push({
          error: e instanceof Error ? e.message : String(e),
          code: typeof code === 'string' ? code : null,
        });
      }
    }
    return out;
  } finally {
    await c.end();
  }
}

export interface Recovery {
  pass: boolean;
  cleanupMs: number;
  terminations: number;
  attempts: number;
  retries: number;
  deadPid: number | null;
  accessPid: number | null;
  followPid: number | null;
  deadGone: boolean;
  backendGoneMs: number | null;
  detectedBeforeAccess: boolean;
  positive: boolean;
  replacementAbsent: boolean;
  rivalPid: number | null;
  rivalGuc: string | null;
  rivalWaiting: number;
  rivalHeldOff: boolean;
  thrown: string | null;
  alerts: string[];
}

/**
 * One injected contamination → detect, terminate, recover on the replacement, measure cleanup.
 * The pool must be size 1. A competing checkout is queued inside the terminator, while the
 * contaminated checkout is still held, and must not observe that backend.
 */
export async function recoverInjected(db: Kysely<Db>, ev: HygieneEvidence, before: number): Promise<Recovery> {
  const t0 = performance.now();
  let accessPid: number | null = null;
  let rows: TenantRow[] = [];
  let thrown: string | null = null;
  let rivalPid: number | null = null;
  let rivalGuc: string | null = null;
  let rivalWaiting = 0;
  let rivalHeldOff = false;
  let rivalPending: Promise<void> | null = null;
  const terminate = async (pid: number): Promise<void> => {
    let entered = false;
    const pending = db.transaction().execute(async (trx) => {
      entered = true;
      const seen = await pidOf(trx);
      const g = await sql<{ g: string | null }>`SELECT current_setting('plerni.tenant_id', true) AS g`.execute(trx);
      return { pid: seen, guc: g.rows[0]?.g ?? null };
    });
    rivalPending = pending.then(
      (row) => { rivalPid = row.pid; rivalGuc = row.guc; },
      (e: unknown) => { thrown = thrown ?? (e instanceof Error ? e.message : String(e)); },
    );
    const deadline = performance.now() + BACKEND_GONE_DEADLINE_MS;
    for (;;) {
      rivalWaiting = poolWaitingCount(db);
      if (rivalWaiting > 0 || entered) break;
      if (performance.now() >= deadline) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Queued, and still not inside the callback, before the backend is killed and released.
    rivalHeldOff = rivalWaiting > 0 && !entered;
    await terminateBackendByPid(pid);
    if (entered) rivalHeldOff = false;
  };
  try {
    const got = await withTenant(db, TENANT_B, ev, terminate, async (trx) => {
      const pid = await pidOf(trx);
      return { pid, rows: await readRows(trx) };
    });
    accessPid = got.pid;
    rows = got.rows;
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  if (rivalPending) await rivalPending;
  const cleanupMs = Math.round(performance.now() - t0);
  const terminations = ev.terminatedBackendPids.length - before;
  const deadPid = terminations > 0 ? ev.terminatedBackendPids[ev.terminatedBackendPids.length - 1]! : null;
  const gone = deadPid === null ? null : await backendGone(deadPid);
  const deadGone = gone?.gone === true;
  const backendGoneMs = gone?.waitedMs ?? null;
  const follow = thrown === null ? await absenceOn(db) : null;
  const detectedBeforeAccess = deadPid !== null && accessPid !== null && accessPid !== deadPid;
  const positive = onlyTenant(rows, TENANT_B);
  const rivalClean = rivalPid !== null && deadPid !== null && rivalPid !== deadPid
    && (rivalGuc === null || rivalGuc === '');
  const replacementAbsent = follow !== null
    && follow.absent && follow.rows === 0 && follow.guard
    && follow.pid === accessPid && follow.pid !== deadPid;
  const retries = Math.max(0, ev.attempts - 1);
  return {
    pass: thrown === null && detectedBeforeAccess && deadGone && positive && replacementAbsent
      && rivalHeldOff && rivalClean
      && retries <= MAX_RETRY && terminations === 1,
    cleanupMs, terminations, attempts: ev.attempts, retries, deadPid, accessPid,
    followPid: follow?.pid ?? null, deadGone, backendGoneMs, detectedBeforeAccess, positive, replacementAbsent,
    rivalPid, rivalGuc, rivalWaiting, rivalHeldOff, thrown,
    alerts: [...ev.alerts],
  };
}

async function pooledPinning(): Promise<{ pass: boolean; runs: number[][] }> {
  const db = pooled(8);
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () =>
      db.transaction().execute(async (trx) => {
        const pids: number[] = [];
        for (let i = 0; i < 3; i++) pids.push(await pidOf(trx));
        return pids;
      })));
    return { pass: runs.every((p) => p.length === 3 && new Set(p).size === 1), runs };
  } finally {
    await db.destroy();
  }
}

export function rawCleanDeny(): Promise<unknown> {
  return rawAppSteps([
    { text: 'BEGIN' },
    { text: 'SELECT count(*)::int AS n FROM plerni_tenant' },
    { text: 'ROLLBACK' },
  ]);
}

export function rawPositive(id: string): Promise<unknown> {
  return rawAppSteps([
    { text: 'BEGIN' },
    { text: `SELECT set_config('plerni.tenant_id', $1, true)`, values: [id] },
    { text: 'SELECT tenant_id::text AS tenant_id, label FROM plerni_tenant ORDER BY label' },
    { text: 'COMMIT' },
  ]);
}

export function rawLeak(id: string): Promise<unknown> {
  return rawAppSteps([
    { text: 'BEGIN' },
    { text: `SELECT set_config('plerni.tenant_id', $1, true)`, values: [id] },
    { text: 'COMMIT' },
    { text: 'BEGIN' },
    { text: `SELECT NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL AS absent` },
    { text: 'SELECT count(*)::int AS n FROM plerni_tenant' },
    { text: 'ROLLBACK' },
  ]);
}

export function rawRollbackClearsContext(id: string): Promise<unknown> {
  return rawAppSteps([
    { text: 'BEGIN' },
    { text: `SELECT set_config('plerni.tenant_id', $1, true)`, values: [id] },
    { text: 'SELECT 1/0' },
    { text: 'ROLLBACK' },
    { text: `SELECT NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL AS absent` },
    { text: 'SELECT count(*)::int AS n FROM plerni_tenant' },
  ]);
}

export async function rawSessionGuc(): Promise<unknown> {
  const c = rawApp();
  await c.connect();
  try {
    await c.query(`SELECT set_config('plerni.tenant_id', $1, false)`, [TENANT_A]);
    const stuck = await c.query(`SELECT current_setting('plerni.tenant_id', true) AS guc`);
    await c.query(`SELECT set_config('plerni.tenant_id', '', false)`);
    return { denied: false, sessionGuc: stuck.rows[0].guc, cleared: true };
  } finally {
    await c.end();
  }
}

export function rawSetRole(): Promise<unknown> {
  return rawAppSteps([
    { text: 'SET ROLE plerni_plugin_a' },
    { text: 'SELECT current_user, session_user' },
    { text: 'RESET ROLE' },
  ]);
}

export function rawSearchPath(): Promise<unknown> {
  return rawAppSteps([
    { text: 'SHOW search_path' },
    { text: 'SET search_path TO pg_catalog' },
    { text: 'SHOW search_path' },
    { text: 'SET search_path TO public' },
  ]);
}

export function rawInterleave(): Promise<unknown> {
  return rawAppSteps([
    { text: 'BEGIN' },
    { text: `SELECT set_config('plerni.tenant_id', $1, true)`, values: [TENANT_A] },
    { text: 'SELECT tenant_id::text AS tenant_id FROM plerni_tenant ORDER BY label' },
    { text: 'COMMIT' },
    { text: 'BEGIN' },
    { text: `SELECT set_config('plerni.tenant_id', $1, true)`, values: [TENANT_B] },
    { text: 'SELECT tenant_id::text AS tenant_id FROM plerni_tenant ORDER BY label' },
    { text: 'COMMIT' },
  ]);
}

const ROLE_DEFAULT_PREFIX = 'ALTER ROLE plerni_app SET plerni.tenant_id = ';

/** Superuser role default. The statement is built with format('%L') and prefix-checked. */
export async function setAppTenantDefault(tenant: string): Promise<void> {
  const root = rawRoot();
  await root.connect();
  try {
    const built = await root.query(
      `SELECT format('ALTER ROLE plerni_app SET plerni.tenant_id = %L', $1::text) AS stmt`,
      [tenant],
    );
    const stmt = built.rows[0]?.stmt;
    if (typeof stmt !== 'string' || !stmt.startsWith(ROLE_DEFAULT_PREFIX)) {
      throw new Error('refusing unexpected role-default statement');
    }
    await root.query(stmt);
  } finally {
    await root.end();
  }
}

export async function resetAppTenantDefault(): Promise<void> {
  const root = rawRoot();
  await root.connect();
  try {
    await root.query('ALTER ROLE plerni_app RESET plerni.tenant_id');
  } finally {
    await root.end();
  }
}

/** Superuser default injection. Always resets the role default before returning. */
export async function rawRoleDefault(): Promise<unknown> {
  await setAppTenantDefault(TENANT_A);
  try {
    const app = rawApp();
    await app.connect();
    try {
      const seen = await app.query(`SELECT current_setting('plerni.tenant_id', true) AS guc`);
      return { gucOnNewLogin: seen.rows[0].guc };
    } finally {
      await app.end();
    }
  } finally {
    await resetAppTenantDefault();
  }
}

async function rawPinning(): Promise<unknown> {
  const c = rawApp();
  await c.connect();
  try {
    await c.query('BEGIN');
    const pids: number[] = [];
    for (let i = 0; i < 3; i++) pids.push(Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    await c.query('COMMIT');
    return { pids, constant: new Set(pids).size === 1 };
  } finally {
    await c.end();
  }
}

function lifecycleDetail(rec: Recovery): Record<string, unknown> {
  return {
    detectedOnExecutingBackend: rec.detectedBeforeAccess,
    terminatedAndGone: rec.deadGone,
    absenceOnReplacement: rec.replacementAbsent,
    positiveControl: rec.positive,
    retries: rec.retries,
    boundedRetry: rec.retries <= MAX_RETRY,
    cleanupMs: rec.cleanupMs,
    deadPid: rec.deadPid,
    backendGoneMs: rec.backendGoneMs,
    replacementPid: rec.accessPid,
    followPid: rec.followPid,
    rivalPid: rec.rivalPid,
    rivalGuc: rec.rivalGuc,
    rivalWaiting: rec.rivalWaiting,
    rivalHeldOff: rec.rivalHeldOff,
    alerts: rec.alerts,
    thrown: rec.thrown,
  };
}

export async function a3Pgbouncer(): Promise<void> {
  await recordProbe(
    { case: 'A3 A1 pinning', datasource: 'pooled' },
    async () => {
      const pinned = await pooledPinning();
      return { pass: pinned.pass, detail: { statementsPerTransaction: 3, concurrent: 8, runs: pinned.runs } };
    },
    rawPinning,
  );

  const oracle = pooled(1);
  try {
    await recordProbe(
      { case: 'A3 A2a clean-deny', datasource: 'pooled' },
      async () => {
        let rows = -1;
        let guard = false;
        await oracle.transaction().execute(async (trx) => {
          rows = (await readRows(trx)).length;
          try { await assertTenantContext(trx); } catch (e) { guard = e instanceof MissingTenantContextError; }
        });
        return { pass: rows === 0 && guard, detail: { rows, guard } };
      },
      rawCleanDeny,
    );
    let positivePid = 0;
    await recordProbe(
      { case: 'A3 A2b positive control', datasource: 'pooled' },
      async () => {
        const ev = blankEv();
        const positive = await withTenant(oracle, TENANT_B, ev, terminateBackendByPid, async (trx) => {
          positivePid = await pidOf(trx);
          return readRows(trx);
        });
        return {
          pass: onlyTenant(positive, TENANT_B) && ev.terminatedBackendPids.length === 0,
          detail: { read: positive.map((r) => r.tenant_id), pid: positivePid },
        };
      },
      () => rawPositive(TENANT_B),
    );
    await recordProbe(
      { case: 'A3 A2c leak-freedom', datasource: 'pooled' },
      async () => {
        const leak = await absenceOn(oracle);
        return {
          pass: leak.absent && leak.rows === 0 && leak.guard && leak.pid === positivePid && positivePid !== 0,
          detail: { ...leak, positivePid },
        };
      },
      () => rawLeak(TENANT_B),
    );
  } finally {
    await oracle.destroy();
  }

  await drainAppBackends();
  const rollback = pooled(1);
  try {
    await recordProbe(
      { case: 'A3 mid-transaction error rollback', datasource: 'pooled' },
      async () => {
        const ev = blankEv();
        let installedPid = 0;
        let code: string | undefined;
        try {
          await rollback.transaction().execute(async (trx) => {
            await installTenantContext(trx, TENANT_B, ev);
            installedPid = await pidOf(trx);
            await sql`SELECT 1/0`.execute(trx);
          });
        } catch (e) {
          code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : undefined;
        }
        const after = await absenceOn(rollback);
        return {
          pass: code === '22012' && after.absent && after.rows === 0 && after.guard
            && after.pid === installedPid && ev.terminatedBackendPids.length === 0,
          detail: { code, installedPid, after },
        };
      },
      () => rawRollbackClearsContext(TENANT_B),
    );
  } finally {
    await rollback.destroy();
  }

  await drainAppBackends();
  const life = pooled(1);
  try {
    await recordProbe(
      { case: 'A3 contamination lifecycle', datasource: 'pooled' },
      async () => {
        const ev = blankEv();
        await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(life);
        const rec = await recoverInjected(life, ev, 0);
        return { pass: rec.pass, detail: lifecycleDetail(rec) };
      },
      rawSessionGuc,
    );
  } finally {
    await life.destroy();
  }

  // direct is not the A3 hypothesis; one positive control confirms the same protocol off the pool.
  const side = direct();
  try {
    await recordProbe(
      { case: 'A3 direct positive control', datasource: 'direct' },
      async () => {
        const ev = blankEv();
        const rows = await withTenant(side, TENANT_A, ev, terminateBackendByPid, readRows);
        return {
          pass: onlyTenant(rows, TENANT_A) && ev.terminatedBackendPids.length === 0,
          detail: { terminations: ev.terminatedBackendPids.length },
        };
      },
      () => rawPositive(TENANT_A),
    );
  } finally {
    await side.destroy();
  }
}
