# K14 — pg-boss pooler proof and job handoff

- **Date:** 2026-11-12
- **Plan:** [p1-kernel-design-b.md](p1-kernel-design-b.md) §11 row K14
- **Records:** [ADR-0003](../adr/0003-outbox-pgboss.md) decisions 5 and 6, [ADR-0009](../adr/0009-leaderless-replica-log.md) decisions 4 and 5
- **Verdict:** pass. Pin adopted.

## Pin

`pg-boss` 12.38.2, installed in `@plerni/kernel`. Registry license MIT. `engines.node` is `>=22.12.0`. Registry time for 12.38.2 is 2026-11-10T19:33:53.102Z. Package `gitHead` is `fc78d0d95d4e62f0c3161e4da5b05e13408effe8`.

Checked against that package, not against a newer or older tree:

| Source | What it says |
|---|---|
| `README.md` | Claiming relies on PostgreSQL `SKIP LOCKED`. `LISTEN`/`NOTIFY` is optional low-latency delivery. Polling remains. |
| `dist/attorney.js` | `useListenNotify` defaults to false. `heartbeatSeconds`, when set, must be an integer of at least 10. |
| `dist/types.d.ts` | `useListenNotify` holds one dedicated connection and does not work through PgBouncer in transaction mode. |
| `dist/plans.js` `fetchNextJob` | The default lock clause is `FOR UPDATE OF j SKIP LOCKED`. |
| `dist/plans.js` `advisoryLock` | The lock is `pg_advisory_xact_lock`. It ends with the transaction. |
| `dist/plans.js` `timedOut` | The library monitor fails an active job from `started_on + expire_seconds` and does not read `heartbeat_on`. |

The adopted boss sets `useListenNotify: false`, `schedule: false`, and `supervise: false`. The library monitor would reclaim on lease expiry alone, which this task does not allow. `sweepJobs` updates an active row only when the lease is over and `heartbeat_on + heartbeat_seconds` is also over. `started_on` stays set so the next claim increments `retry_count`. That count is the fencing token on `complete`.

Schema install runs as `plerni_migrate` on the direct connection. Claim, send, complete, and the sweeper use the pooled connection. Heartbeat renewal uses a direct client whose endpoint is not the pooler's, and it refuses the pooled application name.

The cold lease is 60 seconds. The heartbeat window is 20 seconds. The zombie fixture uses the same columns with 2 and 10 so the run can observe both predicates. 10 is the library minimum.

## Handoff

`apps/kernel/sql/0008_job_handoff.sql` adds `kernel.job_dispatch`. sha256 `1ca7fe3e431d5b58fca094458a517d6618dfa0990d2aeefd9068eb4052a8e6d2`. The approval file is not in this change. The maintainer signs it.

One transaction claims a pending row with `FOR UPDATE OF d SKIP LOCKED`, inserts the job through that transaction, and marks the row dispatched. A throw leaves the row pending and commits no job. Retention skips a pending row. A dispatched row leaves with its log row.

## Commands

Pooler under test: PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`. The harness pooler is unchanged and still tracks named statements. The job tests start a second pooler on that image with prepared statements off.

```
pnpm --filter @plerni/kernel typecheck
```

Exit 0.

```
pnpm --filter @plerni/kernel test
```

Exit 0. 155 tests, 0 failures. The run printed:

```
{"pool_mode":"transaction","max_prepared_statements":"0","version":"PgBouncer 1.26.0"}
```

The job cases in that run:

```
✔ pg-boss claims through the transaction pooler without session state
✔ a rolled-back handoff leaves the row pending and inserts no job
✔ handoff commits the job and the dispatch mark together
✔ retention keeps a pending handoff and drops a dispatched log row
✔ a live heartbeat blocks reclaim and a stale fence updates zero rows
✔ heartbeat renewal refuses the pooled application name
```

The zombie case is the long one (about 12 seconds): heartbeats still landing after the lease, no redispatch, then a missed heartbeat while the effects transaction is open, redispatch. The replacement worker claims and leaves the job active. The stale token then updates zero rows and its effect rolls back. The replacement token commits after that.

```
pnpm gates
```

Exit 0. `license-audit: OK (112 dependencies checked)`. `kernel-purity: OK`. `private-markers: OK`. `commit-policy: OK`. `gate-health: OK (96 cases)`.

`pg-boss` depends on `serialize-error`, which depends on `type-fest` 5.10.0. That package's license field is `(MIT OR CC0-1.0)`. Both identifiers are already allowlisted. The license gate now accepts a parenthesized OR only when every disjunct is allowlisted. A disjunct outside the list still fails, and the existing GPL fixtures still fail.

```
pnpm lint
```

Exit 0. No package defines a lint task.
