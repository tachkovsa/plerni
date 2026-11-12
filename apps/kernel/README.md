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

`kernel.subscription` is one global cursor. `kernel.delivery` is `UNIQUE(subscription, seq)`. The relay claims a live subscription with `FOR UPDATE SKIP LOCKED`, then delivers one event in its own transaction: dedup marker, handler effect, cursor advance, and the fencing predicate. `safe_point` is the maximum committed `seq` whose `created_at` is at least 10 seconds old. A missing `seq` at or below that cutoff is a rolled-back `nextval` and is skipped. A filter skips other types and still advances. A payload version the subscription lists and does not accept parks that subscription with `UNKNOWN_EVENT_VERSION`; the cursor and the row stay. Retention deletes log rows strictly below the minimum subscription cursor, live or parked. `LISTEN` uses a direct connection. Polling still delivers when no listener is visible in `pg_stat_activity`. Enablement watermarks, the backlog quota, and export-then-force-advance are a later task. Two relays are a later task.

Role chain for this API, with no shell: an operator session creates a customer and can read the audit row for that action; the customer session is refused and sees no audit row; a plugin role cannot select the registry.

## Local accounts and sessions

`bootstrapInstallation` reads `PLERNI_BOOTSTRAP_CREDENTIAL` from the process environment. The value is compared and then discarded. It is not stored, logged, or written into a fixture. One call creates the operator tenant and its admin, then one customer tenant and its admin, and marks the credential consumed. A later call with the same value is rejected.

Passwords and rescue codes are argon2id PHC strings (`@noble/hashes` 2.4.0, m=19456 KiB, t=2, p=1). Session tokens and reset tokens are sha256 of 256-bit random values. `disableUser` sets `disabled_at`, bumps `revocation_epoch`, revokes sessions, writes `kernel.audit_record` and `kernel.auth_audit`, and `NOTIFY`s in one transaction. A revoked token or a stale epoch fails on the next read. The freshness-lease object is a stub: a hit does not authorize. The commitment chain, TOTP ciphertext, and the cache are later tasks.

Role chain, with no shell: the bootstrap credential creates both admins and then stops working. The customer admin logs in, creates a member, and disables that member; the member token then fails, and disabling the only admin is refused. A member cannot disable. A customer token does not authenticate as the operator tenant. A plugin role cannot select `kernel.user_account`. Rescue codes and reset tokens are stored hashed, and none of those secrets appear in the identity log.

## Grants and the fixture schema

ADR-0008 is the capability wall. `kernel.plugin_grant` stores the operator-approved grant names. `kernel.principal_grant` is the tenant-scoped row a synthetic principal must hold before the broker runs that plugin's read. `kernel.plugin_migration` records package SQL. None of these tables name a plugin schema.

Package migration uses two unpooled connections. An admin connection creates `plerni_plugin_<id>` because `plerni_migrate` has no `CREATEROLE` and `CREATE ROLE` cannot run inside the journal transaction. The migration connection creates the schema and the DML grants. The request path does not create objects. After hygiene it may `SET LOCAL ROLE` to that plugin role and pin `search_path` for that transaction only. The next statement on the same pooled client is the replay probe. A `search_path` or role that survives the commit discards that pooler session.

`plugins/fixture_alpha` is the proof package. Its schema is `plugin_fixture_alpha`. The kernel `Database` interface does not list it. The fixture-file check used before apply rejects unqualified table names, another plugin schema, and functions. It is not the P2 admission parser. The manifest's edge-type list is the `directory.write_edge:<type>` grants. This package has none.

## Object storage

Put and get go through the storage port. The caller sends a relative key and must hold `storage.prefix`. The stored key is `t/<tenant-uuid>/p/<plugin-id>/<relative-key>` (ADR-0015). The tenant id is lowercased. A key that could leave that prefix is `VALIDATION` and is not written. A missing object, including one that exists only under another tenant or another plugin, is `NOT_FOUND` with `next_step`. The store's own message is not copied into the envelope. One call accepts at most 32 MiB. The port does not add an HTTP route.

The client speaks S3 with path-style addressing and does not retry. The suite runs it against moto 5.2.5 (`python3 -m moto.server`). There is no SQL migration.

Role chain, with no shell: a caller with the grant puts bytes and reads them back under that prefix; a caller for another tenant, or another plugin, gets `NOT_FOUND` and does not receive the bytes; a caller without the grant is refused and nothing is written.

## Notification plumbing

`kernel.notification_preference` and `kernel.notification_delivery` are tenant-domain tables. A session actor records their own in-app preference. A caller holding `notify.send` sends to a recipient. The first accepted send for an idempotency key inserts one row and stores the text the caller supplied. That row is the in-app delivery. A later send with that key returns the same row and does not insert another. A different recipient, channel, or message text is `CONCURRENCY_CONFLICT`. A missing preference is `NOT_FOUND` and writes nothing. A disabled preference inserts one suppressed row, which is not listed to the recipient. No template is stored.

`POST /kernel/notification-preferences`, `POST /kernel/notifications`, and `GET /kernel/notifications` are the public routes. The list returns the caller's delivered rows, newest first, at most 50. Failures use the error envelope.

## Directory

`kernel.directory_user`, `kernel.directory_group`, `kernel.directory_membership`, `kernel.directory_edge_type`, and `kernel.directory_edge` are tenant-domain tables. Creating, reading, updating, and deleting stay inside the session tenant. Another tenant's list is empty, including when the ids match. Lists are ordered by id and return at most 50 rows.

An edge type is a row. `registerDirectoryEdgeType` inserts that row for a name `registeredEdgeTypes` returns, and only when `kernel.plugin_grant` holds both `directory.register_edge_type` and `directory.write_edge:<type>` for that plugin. It does not add a kernel migration. `insertDirectoryEdge` inserts an edge only for a name that same parsing lists and only when that write grant is installed. The check reads the grant table inside the tenant transaction. The broker writes the edge as the app role, in the caller's transaction, so a plugin statement in that transaction commits or rolls back with the edge. The plugin role has no `INSERT` on these tables.

This port does not add a public route. Failures are the error envelope (`ContractFailure`). Plan §7's directory read tools are a later task.

Role chain, with no shell: tenant A creates a user and a group and adds the user to the group; tenant B sees none of those rows and can store the same user id with a different label; the fixture manifest lists no edge type, so a write in the same transaction as a fixture row rolls that row back; a parsed manifest that lists one type registers a row and the broker writes the edge with a fixture row; the plugin role's insert is rejected.

## Service principals

`kernel.service_principal` is tenant-scoped. `kernel.service_credential` stores sha256 of a 256-bit token, never the token. `kernel.service_principal_scope` stores the permissions the administrator declared, and no others. A credential expires within 90 days. Rotate revokes the previous credential and returns a new one. Revoke marks the principal and its credentials revoked.

`POST /kernel/service-principals`, `POST /kernel/service-principal-rotations`, and `POST /kernel/service-principal-revocations` are administrator routes. The bearer is an administrator session. A service credential presented to those routes is not an administrator session. On a routine route, an `Authorization: Bearer` credential replaces any grants on the injected caller. `POST /kernel/notifications` is that routine route: it requires `notify.send` in the stored scope. A token that is not 64 hex, including an upstream IdP token, is rejected. A user session token is not a service credential. Denial of a `sensitive` or `destructive` route is a later task.

Role chain, with no shell: a customer administrator provisions a principal whose scope is the declared permissions. That credential calls the routine notification route when the scope includes `notify.send`. A scope that does not declare `notify.send` is `FORBIDDEN` even if the caller object lists that permission. After rotate, the previous credential fails and the new one calls the route. After revoke, the current credential fails. The identity log and the stored rows do not contain the secret.

## Tenancy suite

The suite talks to the dev harness (PostgreSQL through PgBouncer, transaction mode). Export `POSTGRES_PASSWORD`, `PLERNI_APP_PASSWORD`, `PLERNI_MIGRATE_PASSWORD`, and `PLERNI_ADMIN_PASSWORD`, then reset the harness, then:

```bash
pnpm --filter @plerni/kernel test
```

`test/hygiene.test.ts` and `test/surviving-client.test.ts` do not open a database. `test/schema.test.ts`, `test/tenancy.test.ts`, and `test/tenant-registry.test.ts` do. Negative SQL fixtures live in `test/fixtures/`.
