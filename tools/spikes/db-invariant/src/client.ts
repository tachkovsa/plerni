// client.ts — three datasources per plan §2/δ-R2#10:
// direct PG · pooled through PgBouncer (transaction mode) · PgBouncer admin console (read-only SHOW).
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export interface Db { plerni_tenant: { id: string; tenant_id: string; label: string } }

// Fail-loud on unset credentials (harness standard: named var, non-zero exit — γ-m5;
// otherwise pg dies deep inside SASL with a meaningless message).
function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`spike: missing env var ${name} (export the harness passwords first)`);
    process.exit(1);
  }
  return v;
}

const DIRECT = process.env.HARNESS_DIRECT_DSN
  ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54320/plerni`;
const POOLED = process.env.HARNESS_POOLED_DSN
  ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54321/plerni`;
const ADMIN = process.env.HARNESS_ADMIN_DSN
  ?? `postgres://plerni_admin_ro:${envOrDie('PLERNI_ADMIN_PASSWORD')}@localhost:54321/pgbouncer`;
// Raw superuser (raw-pg controls + pg_stat_activity checks + the privileged terminator;
// spike-only, never in the protocol path).
const ROOT = process.env.HARNESS_ROOT_DSN
  ?? `postgres://postgres:${envOrDie('POSTGRES_PASSWORD')}@localhost:54320/plerni`;

// pg emits 'error' on idle pool clients whose backend died (our contamination protocol kills
// backends on purpose). Query-level rejections still propagate to callers; idle-level events
// would otherwise crash the process as unhandled. They are recorded, not swallowed.
// Checked-out clients need their own listener (pg-pool only forwards idle clients' errors) —
// attach at 'connect' per pg docs: a backend killed mid-transaction emits FATAL 08P01 as a
// client-level 'error' with no active query to absorb it.
export const idlePoolErrors: string[] = [];

const pools = new WeakMap<Kysely<Db>, pg.Pool>();

export function kyselyOf(dsn: string, max = 10): Kysely<Db> {
  const pool = new pg.Pool({ connectionString: dsn, max });
  pool.on('error', (e) => { idlePoolErrors.push(String(e)); });
  pool.on('connect', (client) => { client.on('error', (e) => { idlePoolErrors.push(String(e)); }); });
  const db = new Kysely<Db>({ dialect: new PostgresDialect({ pool }) });
  pools.set(db, pool);
  return db;
}

/** Checkouts queued on this client's pool. The driver does not expose the count. */
export function poolWaitingCount(db: Kysely<Db>): number {
  const pool = pools.get(db);
  if (!pool) throw new Error('spike client has no pool');
  return pool.waitingCount;
}

interface PoolClient {
  connection?: { stream?: { destroyed?: boolean; destroy: () => void } };
}

function poolClients(db: Kysely<Db>): PoolClient[] {
  const pool = pools.get(db);
  if (!pool) return [];
  return (pool as unknown as { _clients?: PoolClient[] })._clients ?? [];
}

/**
 * Close every client socket on this pool. Each socket is one PgBouncer client
 * session, and that session owns the variable cache that replays tracked
 * parameters (including search_path on PostgreSQL 18) onto the next backend.
 * A backend kill does not clear the cache while the socket stays up.
 * Returns how many sockets were still open.
 */
export function discardPoolerSessions(db: Kysely<Db>): number {
  let closed = 0;
  for (const client of poolClients(db)) {
    const stream = client.connection?.stream;
    if (!stream || stream.destroyed) continue;
    stream.destroy();
    closed++;
  }
  return closed;
}

/** Drop sockets on this pool so a wedged checkout cannot hold the process open. */
export function unblockPool(db: Kysely<Db>): void {
  discardPoolerSessions(db);
}

export const direct = (max = 10) => kyselyOf(DIRECT, max);
export const pooled = (max = 10) => kyselyOf(POOLED, max);
export const rawRoot = () => {
  const c = new pg.Client({ connectionString: ROOT });
  c.on('error', (e) => { idlePoolErrors.push(String(e)); });
  return c;
};

// Raw client as the APP role on the direct DSN — controls must run on the application path
// (γ-m4), never as superuser.
export const rawApp = () => rawClient(DIRECT);

// Same app role through PgBouncer (transaction mode). A1's raw control on the pooled
// datasource has to open this client; the direct control does not stand in for it.
export const rawAppPooled = () => rawClient(POOLED);

function rawClient(connectionString: string): pg.Client {
  const c = new pg.Client({ connectionString });
  c.on('error', (e) => { idlePoolErrors.push(String(e)); });
  return c;
}

// The privileged termination path (γ-M1): in the spike, harness root; in production this is the
// broker's maintenance identity (pg_signal_backend / membership), never the compromised session.
const TERMINATE_DEADLINE_MS = 2000;

export async function terminateBackendByPid(pid: number): Promise<void> {
  const c = rawRoot();
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend($1)', [pid]);
    // pg_terminate_backend only signals. Do not return while the pid is still queryable.
    const deadline = performance.now() + TERMINATE_DEADLINE_MS;
    for (;;) {
      const r = await c.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (r.rows.length === 0) return;
      if (performance.now() >= deadline) {
        throw new Error(`backend ${pid} still present after terminate`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await c.end();
  }
}

// §3.0② evidence: effective PgBouncer config via the admin-console datasource (SHOW only).
export async function adminShow(command: 'CONFIG' | 'DATABASES' | 'USERS' | 'VERSION'): Promise<unknown[]> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try {
    const r = await c.query(`SHOW ${command}`);
    return r.rows;
  } finally {
    await c.end();
  }
}
