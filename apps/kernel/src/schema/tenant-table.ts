// SPDX-License-Identifier: Apache-2.0
// Live-database shape check for one tenant-domain table (spec §4.6).
import type pg from 'pg';

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

/** Deparsed form of the canonical predicate, observed on PostgreSQL 18. */
export const CANONICAL_PREDICATE =
  "(tenant_id = (NULLIF(current_setting('plerni.tenant_id'::text, true), ''::text))::uuid)";

export type ViolationCode =
  | 'tenant_id_missing'
  | 'tenant_id_nullable'
  | 'rls_disabled'
  | 'rls_not_forced'
  | 'policy_count'
  | 'policy_command'
  | 'policy_text'
  | 'primary_key'
  | 'privilege'
  | 'foreign_key';

export interface TenantTableViolation {
  table: string;
  code: ViolationCode;
  detail: string;
}

export interface TenantTableSpec {
  schema: string;
  table: string;
  foreignKey?: string;
  /** DML grantee. Kernel tables leave this as plerni_app. A plugin table names its schema role. */
  runtimeRole?: string;
}

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

function ident(value: string): string {
  if (!IDENT.test(value)) throw new Error(`refusing unexpected identifier: ${value}`);
  return value;
}

export async function inspectTenantTable(
  client: Queryable,
  spec: TenantTableSpec,
): Promise<TenantTableViolation[]> {
  const schema = ident(spec.schema);
  const table = ident(spec.table);
  const label = `${schema}.${table}`;
  const violations: TenantTableViolation[] = [];
  const regclass = `${schema}.${table}`;

  const shape = await client.query<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    owner: string;
    tenant_not_null: boolean | null;
    tenant_type: string | null;
  }>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            a.attnotnull AS tenant_not_null,
            a.atttypid::regtype::text AS tenant_type
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attribute a
       ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  const row = shape.rows[0];
  if (!row) {
    violations.push({ table: label, code: 'tenant_id_missing', detail: 'relation is absent' });
    return violations;
  }
  if (row.tenant_type !== 'uuid') {
    violations.push({ table: label, code: 'tenant_id_missing', detail: `type ${row.tenant_type ?? 'absent'}` });
  } else if (row.tenant_not_null !== true) {
    violations.push({ table: label, code: 'tenant_id_nullable', detail: 'tenant_id accepts null' });
  }
  if (!row.relrowsecurity) {
    violations.push({ table: label, code: 'rls_disabled', detail: 'ENABLE ROW LEVEL SECURITY is absent' });
  }
  if (!row.relforcerowsecurity) {
    violations.push({ table: label, code: 'rls_not_forced', detail: 'FORCE ROW LEVEL SECURITY is absent' });
  }

  const keys = await client.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [regclass],
  );
  const keyNames = keys.rows.map((item) => item.attname);
  if (keyNames.join(',') !== 'tenant_id,id') {
    violations.push({ table: label, code: 'primary_key', detail: keyNames.join(',') || 'none' });
  }

  const policies = await client.query<{
    polname: string;
    polpermissive: boolean;
    polcmd: string;
    using_expr: string | null;
    check_expr: string | null;
  }>(
    `SELECT pol.polname, pol.polpermissive, pol.polcmd,
            pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
            pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
     FROM pg_policy pol
     JOIN pg_class c ON c.oid = pol.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  if (policies.rows.length !== 1) {
    violations.push({ table: label, code: 'policy_count', detail: String(policies.rows.length) });
  }
  for (const policy of policies.rows) {
    if (policy.polcmd !== '*' || policy.polpermissive !== true || policy.polname !== 'tenant_isolation') {
      violations.push({
        table: label,
        code: 'policy_command',
        detail: `${policy.polname} cmd=${policy.polcmd} permissive=${String(policy.polpermissive)}`,
      });
    }
    if (policy.using_expr !== CANONICAL_PREDICATE || policy.check_expr !== CANONICAL_PREDICATE) {
      violations.push({ table: label, code: 'policy_text', detail: policy.polname });
    }
  }

  // role_table_grants hides a grant unless the inspector is the grantor or an
  // enabled grantee, so a PUBLIC grant from another role is invisible.
  // table_privileges also drops MAINTAIN. The ACL lists every grant, and
  // grantee 0 is PUBLIC.
  const grants = await client.query<{ grantee: string; privilege_type: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) AS acl
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  const runtimeRole = spec.runtimeRole ?? 'plerni_app';
  for (const grant of grants.rows) {
    if (grant.grantee === row.owner) continue;
    if (grant.grantee === runtimeRole && DML.has(grant.privilege_type)) continue;
    violations.push({ table: label, code: 'privilege', detail: `${grant.grantee} ${grant.privilege_type}` });
  }

  if (spec.foreignKey !== undefined) {
    const foreignKeys = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = $1::regclass AND contype = 'f'`,
      [regclass],
    );
    const defs = foreignKeys.rows.map((item) => item.def);
    if (defs.length !== 1 || defs[0] !== spec.foreignKey) {
      violations.push({ table: label, code: 'foreign_key', detail: defs.join('; ') || 'none' });
    }
  }

  return violations;
}
