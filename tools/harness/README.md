# Dev harness

Minimal compose substrate both P0 spikes run against: PostgreSQL 18 (digest-pinned) + PgBouncer 1.26 (`pool_mode = transaction`, `max_prepared_statements = 200`, digest-pinned). From it grow the P1 isolation suite and the `onprem/` compose skeleton. `200` is PgBouncer 1.26.0's documented default. The harness used `0` until A4 measured unnamed-statement overhead above 20%; A4b reruns A1–A3 on the pool with named client statements, which PgBouncer does not track at `0`.

`track_extra_parameters` stays empty. That does not turn off PgBouncer 1.26's built-in variable cache: on PostgreSQL 18 the cache includes `search_path`. `server_reset_query` stays `DISCARD ALL` and `server_reset_query_always` stays `0`, so transaction mode does not run it between transactions. A client that survives its backend keeps the cached value. The spike recovery closes that client session ([ADR-0007](../../docs/adr/0007-pooled-contamination-recovery.md)).

**Honesty note:** this single-host compose topology relaxes the production egress-denied topology (spec §4.4) — the runner/plugin isolation boundary is *not* modeled here, and this file says so rather than pretending.

## Quickstart

```bash
export POSTGRES_PASSWORD=… PLERNI_APP_PASSWORD=… PLERNI_MIGRATE_PASSWORD=… PLERNI_ADMIN_PASSWORD=…
./reset.sh        # render-secrets → compose up → create db → apply sql/001–003
node seed.mjs     # 2 tenants, overlapping labels
```

Any unset variable fails the script with a named message. Passwords are never committed: `render-secrets.mjs` generates `pgbouncer/userlist.txt` (gitignored). It is mode 640, owned by the invoker and grouped to the image gid 70, so that user can read the read-only mount and other local accounts cannot. Setting that group is non-interactive (`sudo -n` only). If it cannot be set, the file is mode 600 inside `pgbouncer/private` (directory 700) and a gitignored compose override runs pgbouncer as the invoker.

## The three datasources

| Purpose | Connection |
|---|---|
| Direct PG | `host=localhost port=54320 dbname=plerni` |
| Pooled (PgBouncer, transaction mode) | `host=localhost port=54321 dbname=plerni` |
| PgBouncer admin console (read-only, `SHOW CONFIG/DATABASES/USERS`) | `host=localhost port=54321 dbname=pgbouncer user=plerni_admin_ro` |

(Host ports are 54320/54321, not 5432/6432: the standard ports are commonly occupied on dev machines by other projects' containers — the datasource contract is the topology, not the port number.)

Spike heartbeat traffic (plan §4 B2) uses a **dedicated direct connection on 54320**, never the main pooled datasource — renewals sharing the main pool can starve under load.

The host firewall must allow forwarded traffic on the compose network. A drop rule there makes the pooled port fail before a query (`client_login_timeout` or `query_wait_timeout`) while the direct port and the admin console can still answer. That failure is environmental. It is not a spike verdict.

Spike B's FIONREAD helper is compiled on first use. The compile needs gcc and the Node headers that ship with the running Node. If either is missing, the probe is unavailable and that run is invalid. It is not a scored failure.

Image digests are recorded here at implementation time: postgres:18 `@sha256:74935e72…fc4336` · edoburu/pgbouncer:v1.26.0-p0 `@sha256:b17551c7…95b711` (full values in docker-compose.yml).
