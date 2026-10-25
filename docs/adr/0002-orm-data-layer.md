# ADR-0002 — ORM / data layer

- **Status:** Proposed · **Date:** 2026-10-25
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §3 (kernel purity), §4.3 (DbPort and WorkUnit), §4.6 (migrations and the boundary checker), §4.8 (plugin dependencies), §5 (data and tenancy)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D05** (shared tables, RLS), **D06** (ORM), **D07** (brokered SQL and WorkUnit), **D08** (per-plugin schemas)
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §3 (Spike A), §8 task 8
- **Evidence:** [`../plans/2026-10-18-spike-a-report.md`](../plans/2026-10-18-spike-a-report.md); pooled session discard: [ADR-0007](0007-pooled-contamination-recovery.md)
- **Issue:** [#16](https://github.com/tachkovsa/plerni/issues/16)
- **Number:** Plan §8 assigns 0002 to this record. Listing this directory shows 0001, 0003, 0004, 0006, and 0007. 0002 is free.

## Context

The kernel stays small and free of domain nouns. Features, including every first-party feature, are plugins. Plugins depend on each other through public contracts and the event log ([ADR-0003](0003-outbox-pgboss.md)), and they never read each other's tables (spec §4.8). A plugin must be able to own tables and migrations under the same RLS tenancy as the kernel, and shipping that plugin must not require a kernel change.

Four properties decide the data layer:

1. **Plugin-owned schemas.** Each plugin ships its own tables. The kernel does not gain a module, a type, or a migration when a plugin is added.
2. **Migration order across dependent plugins.** Install order is deterministic. A dependency is a contract or an event, and it does not become a cross-plugin foreign key.
3. **Tenant isolation.** Shared tables, `FORCE` RLS, and an application guard. Pooled connections cannot carry another tenant's session state into the next checkout.
4. **Testability.** The tenancy path, the typecheck cost, and schema drift each have a failing fixture. A green run is one an independent reviewer can repeat.

D06 already selects Kysely over node-postgres, with Drizzle as the runner-up and Prisma rejected for this project. Spike A is the gate on that selection. This record writes the selection down against the spike, and it states the schema and migration rules the query builder does not own.

## Versions

Registry metadata and the linked docs were read on 2026-10-25. The spike pin is the version the suite ran. The registry column is the version a new install resolved that day.

| Package | Spike pin | Registry on 2026-10-25 | Role |
|---|---|---|---|
| `kysely` | 0.29.6 | 0.29.7 (`latest`, published 2026-10-17) | Kernel query builder |
| `pg` | 8.23.1 | 8.23.1 | PostgreSQL driver |
| `kysely-codegen` | 0.20.0 | 0.20.0 (published 2026-02-16) | CI type generation |
| `typescript` | 5.9.3 | — | Spike compiler |
| `drizzle-orm` | — | 0.45.4 (`latest`). 1.0.0-rc.5 is a pre-release (2026-10-21) | Runner-up, not pinned |
| `drizzle-kit` | — | 0.31.11 | Runner-up migration CLI |
| `@prisma/client` | — | 7.10.1 (`latest`); 6.19.3 (`prev`) | Rejected |
| `@prisma/adapter-pg` | — | 7.10.1 | Prisma 7 driver adapter |
| `prisma` (CLI) | — | 8.0.0-rc.27 (`latest`, release candidate) | Not a stable choice |
| `@prisma/orm-postgres` | — | 8.0.0-rc.20 (`latest`, release candidate) | Prisma 8 PostgreSQL library |

`kysely@0.29.6` and `kysely@0.29.7` publish no `dependencies` and no `peerDependencies`. The PostgreSQL dialect takes a `pg` `Pool` the application constructs ([Getting started](https://kysely.dev/docs/getting-started)). `kysely-codegen` is a dev tool: its own dependency list is non-empty, and it does not ship in the runtime image. `drizzle-orm@0.45.4` likewise publishes peers and no required `dependencies` (Apache-2.0). Licenses of the measured runtime pins: `kysely` MIT, `pg` MIT, `kysely-codegen` MIT.

The 0.29.7 notes describe controlled-transaction connection handling (`startTransaction`) and releasing a PostgreSQL client destroyed while a connection is still being acquired ([release](https://github.com/kysely-org/kysely/releases/tag/v0.29.7)). The spike called `transaction().execute`. 0.29.7 is not the measured revision.

## What Spike A measured

The scored A1–A4 evidence is three suite invocations on 2026-10-18. Each followed a harness reset and seed, exited 0, and reported 0 failing cases. Node v24.22.0. PostgreSQL 18.6. PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0` for the unnamed run, `server_reset_query=DISCARD ALL`, `server_reset_query_always=0`. The A5 curve is the 2026-10-17 CI run [39044052211](https://github.com/tachkovsa/plerni/actions/runs/39044052211) at `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. JSONL stays gitignored. The lines that back the verdicts are in [`../plans/2026-10-18-spike-rerun-evidence.md`](../plans/2026-10-18-spike-rerun-evidence.md).

The first suite after reset is not a verdict. The pooled checkout threw `client_login_timeout (server down)` before Kysely sent a statement, and a raw pooled `psql` failed the same way. Plan §3.0 labels that environmental. The verdicts are the three later invocations.

| ID | Verdict | What this record uses |
|---|---|---|
| A1 direct and pooled | PASS | `transaction().execute` kept one `pg_backend_pid()` across 3 statements in each of 8 concurrent transactions. The raw `pg` control matched, on the direct DSN and through PgBouncer. |
| A2 | PASS | A context-less read returns 0 rows and the app guard raises. Tenant B's transaction returns B's three labels. After commit, context is absent and the follow-up reads 0 rows. Both datasources. |
| A3 | PASS | A1 and A2 hold through PgBouncer, including a `22012` rollback. Contamination is detected on the executing backend, that backend is terminated, and the absence check runs on the replacement. |
| A4 | PASS on unnamed names. Overhead above 20%. | 75 statements, 0 non-empty names. Unnamed-vs-named means 30.4%, 27.3%, and 25.7%, each `mean-exceeds-20`. |
| A4b | PASS, separate experiment | With `max_prepared_statements=200`, A1–A3 passed again on the pooled datasource. 102 extended-protocol observations, all named. The default client in the suite stayed unnamed. Node v22.23.4. |
| A5 | PASS at band 75 | 375 queries. Corpus wall 3410 ms, RSS 429960 KiB. Ceiling 120000 ms and 3906250 KiB. Bands 200 and 400 stayed under that ceiling and do not choose an ORM. |
| Battery | PASS | Terminations equalled injected contaminations (8 and 8). Warm-tail terminations 0. The vacuity control, skip-the-context, reads 0 rows and raises. |

The drift gate regenerated `database-types.ts` with kysely-codegen 0.20.0 from the live migrated schema and required an empty `git diff`. A renamed column and a column added only in SQL both failed the gate, then the tree was restored. That gate is not yet a required check.

A4b and the later search-path probes are in the same report. [ADR-0007](0007-pooled-contamination-recovery.md) records the search-path result: after an idle backend kill, PgBouncer 1.26.0 replays `search_path` onto the new backend for the same client, and `plerni.tenant_id` and `SET ROLE` do not replay. Recovery discards the surviving pooler client session and retries at most twice. Three invocations of that path exited 0.

Spike A did not measure Drizzle, Prisma, a Prisma driver adapter, PostgreSQL 16 or 17, or PgBouncer 1.26.1.

## How the pieces fit the criteria

| Criterion | Kysely + SQL journal | Drizzle 0.45 | Prisma 6 / 7 / 8 | Raw `pg` |
|---|---|---|---|---|
| Plugin-owned schema, no kernel edit | Plugin package ships SQL. Kernel `Database` lists kernel tables. Codegen can exclude plugin schemas. | `schema.ts` is the source Drizzle Kit diffs ([schema](https://orm.drizzle.team/docs/sql-schema-declaration), [`generate`](https://orm.drizzle.team/docs/drizzle-kit-generate)). A kernel schema graph that imports plugin models is a kernel edit per plugin. `pull` can introspect SQL, and the TypeScript schema is then a second artifact. | `schema.prisma` plus `prisma generate` ([generate](https://www.prisma.io/docs/cli/v7/generate)). One generated client that includes plugin models puts domain types in the kernel build. | SQL files live in the plugin. The kernel has no generated interface that would fail closed when a column drifts. |
| Order across dependent plugins | The journal orders SQL. The builder does not. | Kit orders one schema's generated files. It does not know a contract dependency between packages. | Migrate orders one schema's history. Same gap. | The journal would still be required. |
| Tenant isolation on a transaction pool | Measured. Caller-supplied `Pool`. `set_config(..., true)` is ordinary SQL in one place. | Same `pg` driver is available as a peer, and none of A1–A3 was run on it. | 7.10.1 requires `@prisma/adapter-pg` ([PostgreSQL connector](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)). The adapter's pinning was not spiked. 8 is a release candidate and its own status page lists transaction isolation levels as unavailable ([release status](https://www.prisma.io/docs/orm/release-status)). | The raw control matched Kysely on A1. Isolation is a driver property. The typed layer is what A5 scored. |
| Testability | Drift fixtures failed when SQL and the interface diverged. A5 has a numeric ceiling and a corpus lint that rejects type escapes. | Not measured. | The register rejects 6 on generated-type compile cost. This record does not remeasure that cost. | No generic ceiling. Drift is a review comment. |

Kysely's own migrator runs TypeScript `up`/`down` functions with a `Kysely` instance and a database lock, in alphanumeric file order ([Migrations](https://kysely.dev/docs/migrations)). That is a different tool from the journal below. Plugin migrations are admitted SQL, and a plugin never holds the connection those functions would hold (spec §4.3).

## Decision

1. **Kernel queries use Kysely over node-postgres.** The kernel constructs one `Kysely` with `PostgresDialect` and a `pg` `Pool` it owns ([Getting started](https://kysely.dev/docs/getting-started)). The acceptance pin is `kysely` 0.29.6 and `pg` 8.23.1. A later pin re-runs A1–A3. Those docs require `strict` mode. They support TypeScript 5.4 and recommend 5.9 or newer; the spike compiled with 5.9.3.
2. **SQL is the schema source of truth.** Kernel and plugin migrations are ordered SQL files applied by the journal. `kysely-codegen` 0.20.0, in CI, introspects the migrated database and writes the `Database` interface that is committed ([Generating types](https://kysely.dev/docs/generating-types)). A diff against a fresh introspection fails the build. There is no runtime generate step.
3. **The kernel interface contains kernel tables only.** Plugin schemas are outside that interface. Adding or upgrading a plugin does not change a kernel source file. The broker executes a plugin's admitted SQL text with bound parameters inside the kernel transaction. Plugins do not depend on Kysely and do not receive a `Pool`, in production or in tests.
4. **Each plugin owns one PostgreSQL schema.** The schema holds tables, indexes, and constraints (D08). It does not hold functions, triggers, or `DO` blocks. The migration role has `CREATE` on that schema only. The only cross-schema references are the declared read-only `REFERENCES` grants on the kernel identity columns `users(id, tenant_id)` (spec §4.6). Extensions come from the kernel allowlist. Every migration carries the signed approval artifact spec §4.6 already requires.
5. **The journal orders migrations.** Kernel bootstrap (extensions, identity) runs first. A plugin's own files then run in the order that package declares. Across plugins, a plugin that requires a port, or that subscribes to an event type, runs after every installed plugin that provides that port or publishes that event type. The manifest names the port and the event (spec §4.2). Admission resolves which installed plugin provides it. A cycle fails admission. Plugins with no such edge run in plugin-id order so a replay is the same replay. That order is a contract order. It does not permit a foreign key into another plugin's schema (spec §4.8).
6. **Tenant-domain tables, kernel and plugin, share one shape.** `tenant_id` is `NOT NULL`. Row security is enabled and forced, so the table owner is also subject to it ([ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html), [row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)). Exactly one canonical permissive policy exists, and the boundary checker compares its text, because PostgreSQL OR-combines permissive policies. Kernel-internal machinery tables stay a separate class with named service identities (spec §5). Per-tenant reference rows ship as versioned per-tenant migrations, applied in background batches, off the request path.
7. **Tenant context is transaction-local, on one pinned connection.** `set_config(name, value, true)` applies for the current transaction only ([configuration functions](https://www.postgresql.org/docs/18/functions-admin.html)). The call sits in the kernel hygiene path, after `BEGIN` and after the pre-override inspection, and the authorized value is read back before any tenant read. node-postgres requires the same client for every statement of a transaction; `pool.query` does not provide that ([transactions](https://node-postgres.com/features/transactions)). `transaction().execute` commits when the callback returns and rolls back when it throws ([simple transaction](https://kysely.dev/docs/examples/transactions/simple-transaction)). A1 measured one backend for the whole callback, including through PgBouncer transaction mode, where the server connection is released when the transaction finishes ([`pool_mode`](https://www.pgbouncer.org/config.html)).
8. **Pooled sessions stay clean by the hygiene protocol and by ADR-0007.** The pooler is PgBouncer in transaction mode. `server_reset_query` does not run in that mode unless `server_reset_query_always` is on, and the default of that flag is 0 ([config](https://www.pgbouncer.org/config.html)). The flag stays 0. On confirmed contamination the kernel terminates the backend and discards every still-open client socket on that pool, then retries at most twice (ADR-0007). `ignore_startup_parameters` stays empty. Missing context fails closed twice: the policy returns no rows, and the application guard raises.
9. **The kernel client keeps unnamed extended-protocol statements.** A4 observed empty statement names under load. A4's overhead was above the plan's 20% line, and A4b then showed that protocol-level named statements also pass A1–A3 when `max_prepared_statements` is 200 (the current documented default). Named statements are a measured configuration. They are not the default this record ships. SQL `PREPARE` / `EXECUTE` / `DEALLOCATE` are not the naming mechanism: PgBouncer forwards those to PostgreSQL and tracks only protocol-level names ([`max_prepared_statements`](https://www.pgbouncer.org/config.html)).
10. **Tests use the spike's shape.** A tenancy change is green only when the direct datasource and the pooled datasource both pass, a raw `pg` control matches the pinning result, a second tenant's positive control returns that tenant's rows, a context-less read returns 0 rows and raises, and a contamination case terminates the dirty backend and completes on a discarded-and-replaced session. The run is three invocations, or it is not a verdict. Environmental failure is an invalid run (plan §3.0). Plugin SQL is tested by applying that plugin's migrations to a live database and running the same two-tenant suite through the `NOBYPASSRLS` app role. The journal order has its own fixture: a dependent declared ahead of its provider is refused, and a foreign key into another plugin schema fails the boundary checker. The A5 acceptance point remains band 75, 375 queries, at most 120 s and 4 GB RSS on the CI runner class.

WorkUnit (D07) is how a plugin writes. The broker runs the plugin's admitted statements, the audit row, and the outbox row in the same Kysely transaction. Cross-plugin consistency stays on the event log. This record does not reopen D07 or D10.

## Consequences

- Domain tables live in plugin schemas. The kernel-purity gate continues to see a kernel that does not import them.
- The codegen include list for the kernel interface is part of the purity boundary. A plugin schema that appears in that interface is a kernel change and fails review.
- `kysely` 0.29.7 is current upstream and is not what A1–A5 ran. The pin moves only with an A1–A3 rerun.
- The scored pooler is 1.26.0 on PostgreSQL 18.6. Current PgBouncer docs still default `max_prepared_statements` to 200 and still skip `server_reset_query` in transaction mode. The 1.26.0 changelog is what made `search_path` tracked on PostgreSQL 18. The 1.26.1 changelog (2026-10-14) says further `search_path` tracking bugs are left for a later release, and that listing `search_path` in `ignore_startup_parameters` restores the 1.25 ignore behavior ([changelog](https://www.pgbouncer.org/changelog)). This record keeps the ADR-0007 discard and does not turn that ignore on. PostgreSQL 16 and 17 were not scored; the spec floor remains 16, and a deployment below 18 is unmeasured pooler behavior.
- Unnamed statements cost about 26–30% against named ones on the direct A4 benchmark. That cost is accepted until a later record adopts the A4b client.
- The drift gate has fixtures and is not yet required in CI. Wiring it is follow-up work, and the decision already treats a stale interface as a failed build.
- Read replicas remain incompatible with transaction-pinned `set_config`, as spec §5 already says.
- Kysely's `Migrator`, Drizzle Kit's schema diff, and Prisma Migrate are not the journal. Operators do not get a second migration history.

## Rejected alternatives

- **Drizzle as the kernel builder.** Same thin runtime, and a SQL-first workflow exists via `pull` ([migrations](https://orm.drizzle.team/docs/migrations)). The typed schema is still a second representation, and the kit's primary path generates SQL from that schema. Spike A did not run on it. It stays the fallback named in D06, opened only by an ergonomics failure at the A5 acceptance point.
- **Prisma ORM 6** (`@prisma/client` 6.19.3). The register rejects it for this project because of generated-type compile cost and codegen coordination across many schemas. Those numbers are the register's prior. This record does not repeat them as a new measurement. Security patches for 6 continue until 19 November 2026 ([release status](https://www.prisma.io/docs/orm/release-status)).
- **Prisma ORM 7** (`@prisma/client` 7.10.1 with `@prisma/adapter-pg` 7.10.1). Driver adapters are mandatory, so the "pinning unproven" objection in spec §18 is now an objection to a specific adapter rather than to a missing feature. Spike A did not run through that adapter. `prisma generate` is still required, and the schema file is still the source. A driver-level failure on `pg` would also fail this adapter. The fallback stays Drizzle.
- **Prisma ORM 8** (`prisma` 8.0.0-rc.27, `@prisma/orm-postgres` 8.0.0-rc.20). Release candidate. The status page, current on 2026-10-23 and matched against the registry on 2026-10-25, expects general availability in October 2026 and lists transaction isolation levels among the APIs that are not available yet. Not a kernel dependency.
- **Raw `pg` as the kernel API.** Sufficient for tenancy, which is why it is the §3.0 control, and silent on drift. A5's fail-closed types are the reason the kernel keeps a builder.
- **Kysely `Migrator` as the plugin journal.** The functions are executable TypeScript, they hold a connection, and their order is alphanumeric within one folder. Admission parses SQL. The journal stays SQL.
- **Schema-per-tenant, and dedicated databases in v1.** Already rejected (D05, spec §18).
- **Session `SET`, or relying on `DISCARD ALL` between transactions.** Transaction pooling does not run the reset query. The spike measured the state that survives. ADR-0007 is the recovery.

## Flip conditions

These match D06 and plan §3.0. The spike's pass means none of them is open.

- A driver-level failure of connection pinning, of transaction-local `set_config`, or of PgBouncer transaction mode sends the design back to the tenancy substrate. It does not swap the ORM. The same failure is predicted for any client on node-postgres, including Prisma's `pg` adapter.
- A typecheck failure at the A5 acceptance point (band 75, 375 queries, the CI ceiling) opens a Drizzle re-spike of the same suite. It does not open Prisma. An overrun at band 200 or 400 is a budget input and does not choose an ORM.
- Unnamed-statement discipline failing its own assertion is a §3.0 diagnosis, not an automatic move to named statements. A4b already passed; adopting named statements as the default is a separate record.
- ADR-0007's flip conditions still govern the pooler discard. A future pooler that stops replaying `search_path` is re-measured before the discard is removed.
- An invalid environment produces no verdict and no flip. The packet-filter run in the spike report is that case.

## Review

Tenancy content is high-risk. This draft does not carry a review receipt. A receipt binds the reviewed commit SHA and comes from a human reviewer, or from a reviewer outside the family that generated the text. Acceptance is that receipt plus this status moving to Accepted.
