// SPDX-License-Identifier: Apache-2.0
// Kernel-internal relations have no tenant policy (spec §5, ADR-0010).
// Plugin roles and PUBLIC receive no grant. The owner and plerni_app are
// the only grantees, and the app role's privileges stay inside DML
// (sequences: USAGE and SELECT).
import type { Queryable } from './tenant-table.ts';

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;
const TABLE_DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const SEQUENCE_DML = new Set(['USAGE', 'SELECT']);

export async function inspectKernelInternal(client: Queryable, relation: string): Promise<string[]> {
  if (!IDENT.test(relation)) throw new Error(`refusing unexpected identifier: ${relation}`);
  const label = `kernel.${relation}`;
  const problems: string[] = [];
  const shape = await client.query<{
    relkind: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    owner: string;
  }>(
    `SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'kernel' AND c.relname = $1`,
    [relation],
  );
  const row = shape.rows[0];
  if (!row) {
    problems.push(`${label}: absent`);
    return problems;
  }
  if (row.relrowsecurity) problems.push(`${label}: rls enabled`);
  if (row.relforcerowsecurity) problems.push(`${label}: rls forced`);

  const policies = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_policy pol
     WHERE pol.polrelid = $1::regclass`,
    [label],
  );
  if (policies.rows[0]?.count !== '0') {
    problems.push(`${label}: policy count ${policies.rows[0]?.count ?? 'unknown'}`);
  }

  const allowed = row.relkind === 'S' ? SEQUENCE_DML : TABLE_DML;
  const grants = await client.query<{ grantee: string; privilege_type: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            acl.privilege_type
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(c.relkind, c.relowner))) AS acl
     WHERE n.nspname = 'kernel' AND c.relname = $1`,
    [relation],
  );
  for (const grant of grants.rows) {
    if (grant.grantee === row.owner) continue;
    if (grant.grantee === 'plerni_app' && allowed.has(grant.privilege_type)) continue;
    problems.push(`${label}: ${grant.grantee} ${grant.privilege_type}`);
  }
  return problems;
}
