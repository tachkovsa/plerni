#!/usr/bin/env node
// seed.mjs — two tenants with overlapping domain identifiers (isolation-suite seed shape, spec §5).
import pg from 'pg';

const dsn = process.env.HARNESS_ADMIN_DSN
  || `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? ''}@localhost:54320/plerni`;

const client = new pg.Client(dsn);
await client.connect();
await client.query('BEGIN');
await client.query('DELETE FROM plerni_tenant');
const a = '11111111-1111-1111-1111-111111111111';
const b = '22222222-2222-2222-2222-222222222222';
for (const tenant of [a, b]) {
  for (const label of ['goal', 'assignment', 'review']) {
    await client.query('INSERT INTO plerni_tenant (tenant_id, label) VALUES ($1, $2)', [tenant, label]);
  }
}
await client.query('COMMIT');
const { rows } = await client.query('SELECT tenant_id, count(*) FROM plerni_tenant GROUP BY 1 ORDER BY 1');
console.log('seed: tenants with overlapping labels:', rows);
await client.end();
