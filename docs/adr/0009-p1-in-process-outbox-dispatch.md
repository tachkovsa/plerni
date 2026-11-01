# ADR-0009 — P1 dispatches the transactional outbox in-process

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §7 (one machinery), §16.17 (duplicate/loss battery)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D10**
- **Related:** [ADR-0003](0003-outbox-pgboss.md) stays Accepted. This record proposes the P1 shape of the dispatcher and defers the pg-boss handoff. The event-log rules in ADR-0003 stay.
- **Plan:** [`../plans/p1-kernel-design-a.md`](../plans/p1-kernel-design-a.md) (draft A)
- **Number:** 0008 is the modular-monolith proposal. This is the next integer.

## Context

ADR-0003 binds events and jobs to one durable rule: the intent commits in the same transaction as the business write. The event log is append-only, with one global cursor per subscription, a lagging horizon, and lazy fan-out. Claiming uses `FOR UPDATE SKIP LOCKED`. There is no leader. Beyond PostgreSQL, delivery is at-least-once.

ADR-0003 also names two moving parts P1 does not yet need: a relay that uses `LISTEN/NOTIFY` as a wake hint, and a pg-boss handoff for jobs. Both are real machinery, with their own tables, their own version pin, and their own failure modes. The spec's own duplicate/loss battery already requires the system to dispatch when no `NOTIFY` listener exists. The poll is the correctness net.

P1 has to run that net on more than one replica, because cluster deployment is one of the kernel's test cases. A separate relay process and a second job product are extra moving parts in front of a poll the spec already treats as sufficient.

## Decision

1. **The log stays the log ADR-0003 describes.** One append-only `kernel.outbox` row per intent, inserted in the business transaction: `seq`, `tenant_id NOT NULL`, `kind` (`event` or `job`), aggregate identity, type, payload schema version, payload, and `created_at`. `seq` is a PostgreSQL sequence. Rollbacks leave gaps. Readers tolerate gaps. A platform fan-out's parent bookkeeping row carries the operator tenant. Each child claim carries the target tenant ([ADR-0010](0010-operator-tenant-no-bypassrls.md)).
2. **Subscriptions keep one global cursor** (`last_seq`) and the lagging-horizon rule: process committed rows with `seq > last_seq` and `seq <= safe_point`, where `safe_point` excludes rows younger than 10 seconds. Filtered subscriptions skip types they do not match and still advance. A matching row whose schema version is outside the consumer's range parks the subscription on that `seq`. The cursor stays. The row stays. An alarm fires. Retention uses the minimum live cursor. Parked subscriptions are exempt inside the quota in spec §4.5.
3. **Delivery is a transactional inbox.** Dedup marker `UNIQUE (subscription, seq)`, handler effects, cursor advance, and the fencing check commit in one transaction.
4. **Jobs are claim rows born in that same transaction.** The business transaction inserts the outbox row and one `kernel.job_claim` row. There is no later handoff into another product. Claims use `FOR UPDATE SKIP LOCKED`. A job carries the kernel envelope: tenant, plugin, handler and payload version, idempotency key, deadline, attempt budget, trace, fencing token. Jobs are unordered. Ordered side effects use the event log.
5. **Each API replica runs the dispatcher in-process.** The replica that committed a unit schedules a dispatch tick after commit. Every replica also polls every 1 second. The poll is the correctness net. P1 does not open a `LISTEN` connection.
6. **The dispatcher uses one dedicated connection per replica** for claim and heartbeat. Request traffic stays on the PgBouncer transaction-mode pool. Heartbeats are not issued inside the handler transaction. Session-level advisory locks and session `SET` stay off the pool. Transaction-scoped advisory locks are allowed inside the claim transaction.
7. **Fencing and the sweeper follow the P0 protocol.** The sweeper expires leases on `ACTIVE` claims only. `QUEUED` work stays queued. Terminal states stay terminal. Shutdown stops scheduling renewals, then resolves the effect transaction, then drains outstanding renewals.
8. **pg-boss is deferred.** Cron in P1 is a `next_run_at` scan on the same claim table, with an idempotency key so a misfire still runs once. Singleton keys and a separate job database wait until a measured job class needs them.

## Consequences

- Adopting this record amends the P1 contents line "outbox/relay/pg-boss" in spec §15 to "transactional outbox, dispatched in-process on every replica". The D10 capacity rule is unchanged: migrate dispatch when a forecast peak exceeds 50% of measured capacity C. The named next step remains Debezium CDC to Kafka.
- Spec §16.17's clause for an absent `NOTIFY` listener is the P1 design, not a degraded mode. The latency floor is the 1 second poll, and the originating replica also ticks after commit.
- The SDK states at-least-once in writing. Exactly-once holds only inside the PostgreSQL transaction that applies the inbox or the job effect.
- Accepting this record does not withdraw ADR-0003's event-log rules. It defers the pg-boss handoff and the `LISTEN` hint.
- Rejecting this record puts the pg-boss handoff and the relay back on the P1 path, as ADR-0003 writes them.

## Flip conditions

- A job class that needs singleton keys, or a misfire policy the claim table cannot express without becoming a second scheduler, adopts pg-boss behind the same envelope. That adoption follows ADR-0003's job half and does not change the event log.
- Claim p95 above 50 ms, publication lag p99 above 1 second, or foreground p99 degradation above 20%, measured as capacity C in ADR-0003, opens the D10 migration. It does not open it on a projection.
- A demonstration that the 1 second poll loses a committed row that the horizon has already released falsifies this record. The fix is a correct claim scan, or the relay ADR-0003 describes. Silent deletion is not a fix.
