# ADR-0007 — Pooled contamination recovery discards the client session

- **Status:** Accepted · **Date:** 2026-10-24
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §5 (transaction pooling, no session state on a pooled connection)
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §2 (ordered connection-hygiene protocol)
- **Evidence:** [`../plans/2026-10-18-spike-a-report.md`](../plans/2026-10-18-spike-a-report.md) § Pooled search_path replay; issue #36, from the review of #33
- **Number:** 0002 and 0005 are names the plan already assigns. 0006 is the IPC flow-control record. This is the next free integer.

## Context

Plan §2 recovers a contaminated session by `pg_terminate_backend` on the executing backend, a security alert, and a bounded retry on a fresh connection. The #33 battery read "fresh connection" as a new Postgres backend. That is enough for state that lives only on the backend. It is not enough for state the pooler replays.

PgBouncer 1.26.0's `doc/config.md` (`track_extra_parameters`, tag `pgbouncer_1_26_0`) says the pooler tracks every parameter Postgres reports to the client, and that `search_path` is one of those parameters from PostgreSQL 18. `track_extra_parameters` only adds names. The built-in list is in `src/varcache.c` (`init_var_lookup`): `DateStyle`, `client_encoding`, `TimeZone`, `standard_conforming_strings`, `application_name`, `default_transaction_read_only`, `IntervalStyle`, `search_path`, `scram_iterations`, `session_authorization`. An empty `track_extra_parameters` does not remove `search_path`.

`server_reset_query` defaults to `DISCARD ALL` and does not run in transaction mode unless `server_reset_query_always` is on (`doc/config.md`, same tag). The harness leaves that at 0. Turning it on would discard prepared statements between transactions, which fights `max_prepared_statements` (A4b), and it would not clear the client cache: the next time that client is linked, `varcache_apply` sends the cached values again.

`src/objects.c` `unlink_server` disconnects the client only when the server is `SV_ACTIVE`. An idle server that is killed does not take the client with it.

## What was measured

Harness admin `SHOW CONFIG` / `SHOW VERSION`, and `current_setting('server_version')` on the direct app role. PgBouncer 1.26.0. PostgreSQL 18.6. `pool_mode=transaction`. `track_extra_parameters` empty and not changeable from the console. `server_reset_query=DISCARD ALL`. `server_reset_query_always=0`. `ignore_startup_parameters` empty. `max_prepared_statements=200`. `default_pool_size=10`.

One pooled client, then an idle `pg_terminate_backend` of its backend (the client socket stays up, the pid changes):

| Setting | After the idle kill |
|---|---|
| `search_path`, `TimeZone`, `application_name`, `IntervalStyle`, `DateStyle`, `default_transaction_read_only` | Still the values that client set |
| `plerni.tenant_id`, `SET ROLE` | Gone. They are not in the variable cache |

A second client given that same backend sees the tracked settings corrected to its own defaults (`search_path` back to the pinned `public`) and still sees the custom GUC and the leaked role. Tracked state sticks to the client that set it. Untracked state sticks to the backend.

Killing the backend while it is linked to an open transaction closes the client socket. The follow-up query is not queryable. That is why the battery's in-transaction kill recovers today, and why that case records `discardedPoolerSessions` 0: the socket is already gone before the explicit discard runs.

Closing the surviving client's socket, and checking out again, puts the tracked settings back to the login defaults on the backend the replay was using. `withTenant` then installs context with zero further terminations. A direct connection does not replay `search_path` across a new session. The replay is the pooler cache.

## Decision

On confirmed contamination, in this order:

1. Terminate the backend before the checkout is released. That drops untracked state (`plerni.tenant_id`, `SET ROLE`) so the next client cannot inherit it, and it is still the check the plan names.
2. Discard every still-open client socket on that pool. The variable cache belongs to the pooler client session, not to the backend. A retry on a socket that survived the kill would see `search_path` applied again and would fail loud inside the retry budget.
3. Retry at most twice on a new pooler session, then fail loud. A role default (`ALTER ROLE … SET`) is reapplied at every login, so discard cannot clear it. That class stays a loud failure.

`server_reset_query_always` stays 0. `track_extra_parameters` stays empty. Neither setting is the recovery.

## Consequences

- "Fresh connection" in plan §2 means a new client session to the pooler, not only a new backend pid.
- The spike's `withTenant` discards those sockets after the kill is confirmed. The idle-server regression is `pooler discard clears replay`: terminate-only leaves `search_path` set, discard clears it, and the protocol does not terminate again.
- Production code that copies the protocol has to close the pooler session as well as the backend. Closing only the backend is the wedge issue #36 describes.

## Flip conditions

- The same-client replay case fails because a future pooler no longer replays `search_path` unless it is listed in `track_extra_parameters`. Re-measure before deleting the discard. The discard stays safe while the case is red.
- The active-terminate case fails because a linked kill no longer closes the client. The discard is then the only recovery, and `discardedPoolerSessions` on the in-transaction path must be at least 1.
