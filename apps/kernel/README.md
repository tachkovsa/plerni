# apps/kernel — kernel services

P1 starts here. K1 is the tenancy substrate: the `kernel` schema, row-level security on tenant-domain tables, the ordered connection-hygiene protocol, and the application tenant guard.

`src/db/database.ts` names kernel tables only. Plugin schemas do not enter that interface. SQL files in `sql/` are the schema source of truth. `applyKernelMigrations` records them in `kernel.schema_migration` and refuses a tenant-domain table that misses the canonical shape.

Tenant work goes through `withTenant`: one transaction, hygiene inspect before any local override, terminate and discard on contamination, `set_config(..., true)`, read-back, then the caller's statements. `assertTenantContext` is the second fail-closed layer. It raises when the tenant GUC is absent.

## Tenant registry

`kernel.tenants` is the kernel-internal list of tenants. It has no tenant policy. Plugin roles and `PUBLIC` have no grant on it. Bootstrap creates the one operator tenant (`kind = operator`). A second bootstrap returns that row and writes nothing. The lookup runs inside the hygiene transaction, so a contaminated pooled connection is recovered before the read.

`POST /kernel/tenants` is the public create-tenant route (`kernel.tenant.create` in `@plerni/contracts`). `handleKernelRequest` checks the published body, calls `createTenant`, and returns the tenant. A failure uses the error envelope: closed `code`, `message`, `next_step`, and optional `reason`. `CONCURRENCY_CONFLICT` is HTTP 409. A path that is not in the registry is `NOT_FOUND`. The OpenAPI document is generated from that registry; a path added by hand fails review.

`createTenant` is the create-tenant API. The session tenant must be the operator. The call allocates an id and, in one `withTenant` transaction, inserts the customer row, an audit record, and a `kernel.tenant.created` outbox row. It does not seed reference data. The same idempotency key returns the original tenant. When two requests both miss that key before either commits, the loser rolls its writes back and reads the winner inside a new hygiene transaction. A customer session is refused.

`kernel.outbox` is the append-only log. `seq` comes from `nextval` inside that transaction, and `aggregate_version` is incremented under a row lock on the tenant. This path takes no advisory lock. A zero-payload `NOTIFY` shares the transaction. The relay is a separate module and is not started by the registry.

## Outbox relay

`kernel.subscription` is one global cursor. `kernel.delivery` is `UNIQUE(subscription, seq)`. The relay claims a live subscription with `FOR UPDATE SKIP LOCKED`, then delivers one event in its own transaction: dedup marker, handler effect, cursor advance, and the fencing predicate. `safe_point` is the maximum committed `seq` whose `created_at` is at least 10 seconds old. A missing `seq` at or below that cutoff is a rolled-back `nextval` and is skipped. A filter skips other types and still advances. A payload version the subscription lists and does not accept parks that subscription with `UNKNOWN_EVENT_VERSION`; the cursor and the row stay. Retention deletes log rows strictly below the minimum of unreleased subscription cursors and unreleased enablement watermarks. A parked cursor stays in that minimum until export-then-force-advance. `LISTEN` uses a direct connection. Polling still delivers when no listener is visible in `pg_stat_activity`. Two relays are a later task.

Role chain for this API, with no shell: an operator session creates a customer and can read the audit row for that action; the customer session is refused and sees no audit row; a plugin role cannot select the registry.

## Package registry

`kernel.package` is the registry row: id, version, digest, and the installation subscription. `kernel.package_enablement` is the per-tenant watermark. Install is an operator route (`kernel.package.install`). Enable and disable are the session tenant's route (`kernel.package.enablement`). Neither route writes `kernel.plugin_grant`. A `requires` edge blocks enablement until that package is enabled for the same tenant. `optionalRequires` does not.

Disabling a tenant freezes that tenant's watermark and stops delivery for that `tenant_id`. The installation cursor keeps advancing. Re-enable catch-up delivers at most 8 retained events per call, from the watermark up to that cursor, and records the same delivery marker as the relay. The backlog quota is 30 days or 256 MiB. Crossing it inserts `kernel.quota_warning` and does not delete rows. Export (`kernel.package.export`) records the installation cursor for that tenant. Force-advance (`kernel.package.forceAdvance`) moves that tenant's watermark forward only up to the exported sequence and leaves the watermark in the retention minimum, so a later unexported event stays in the log. The route itself deletes no log row. A later retention pass may drop rows below the advanced watermark. Re-enable does not deliver by itself. The next relay pass catch-up delivers at most 8 events, and a pass that stops with backlog remaining continues. A parked subscription is released only after its own export and writes a `FORCE_ADVANCE` dead letter. This pass is one process.

`test/enablement.test.ts` is the enablement suite. It runs in the same harness command as the rest of the kernel tests.

## Grants and the fixture schema

ADR-0008 is the capability wall. `kernel.plugin_grant` stores the operator-approved grant names. `kernel.principal_grant` is the tenant-scoped row a synthetic principal must hold before the broker runs that plugin's read. `kernel.plugin_migration` records package SQL. None of these tables name a plugin schema.

Package migration uses two unpooled connections. An admin connection creates `plerni_plugin_<id>` because `plerni_migrate` has no `CREATEROLE` and `CREATE ROLE` cannot run inside the journal transaction. The migration connection creates the schema and the DML grants. The request path does not create objects. After hygiene it may `SET LOCAL ROLE` to that plugin role and pin `search_path` for that transaction only. The next statement on the same pooled client is the replay probe. A `search_path` or role that survives the commit discards that pooler session.

`plugins/fixture_alpha` is the proof package. Its schema is `plugin_fixture_alpha`. The kernel `Database` interface does not list it. The fixture-file check used before apply rejects unqualified table names, another plugin schema, and functions. It is not the P2 admission parser. The manifest's edge-type list is the `directory.write_edge:<type>` grants. This package has none.

## Object storage

Put and get go through the storage port. The caller sends a relative key and must hold `storage.prefix`. The stored key is `t/<tenant-uuid>/p/<plugin-id>/<relative-key>` (ADR-0015). The tenant id is lowercased. A key that could leave that prefix is `VALIDATION` and is not written. A missing object, including one that exists only under another tenant or another plugin, is `NOT_FOUND` with `next_step`. The store's own message is not copied into the envelope. One call accepts at most 32 MiB. The port does not add an HTTP route.

The client speaks S3 with path-style addressing and does not retry. The suite runs it against moto 5.2.5 (`python3 -m moto.server`). There is no SQL migration.

Role chain, with no shell: a caller with the grant puts bytes and reads them back under that prefix; a caller for another tenant, or another plugin, gets `NOT_FOUND` and does not receive the bytes; a caller without the grant is refused and nothing is written.

## Tenancy suite

The suite talks to the dev harness (PostgreSQL through PgBouncer, transaction mode). Export `POSTGRES_PASSWORD`, `PLERNI_APP_PASSWORD`, `PLERNI_MIGRATE_PASSWORD`, and `PLERNI_ADMIN_PASSWORD`, then reset the harness, then:

```bash
pnpm --filter @plerni/kernel test
```

`test/hygiene.test.ts` and `test/surviving-client.test.ts` do not open a database. `test/schema.test.ts`, `test/tenancy.test.ts`, and `test/tenant-registry.test.ts` do. Negative SQL fixtures live in `test/fixtures/`.
