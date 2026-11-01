# ADR-0009 — P1 accepts the log on two replicas, with Valkey outside durability

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §7 (one machinery, no leader), §15 P1 (outbox/relay/pg-boss), §16.17 (duplicate/loss battery, full suite at P3)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D10**, **D22**
- **Depends on:** [ADR-0003](0003-outbox-pgboss.md). This record sequences P1. It does not replace the log shape.
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §4 and §8
- **Number:** 0008 is the capability-grant record drafted with this one. 0009 is the next integer.

## Context

ADR-0003 already chooses one append-only log, one cursor per subscription, a lagging horizon, lazy fan-out, and stateless relays that claim with `FOR UPDATE SKIP LOCKED`. Correctness does not depend on a leader. Jobs use pg-boss behind that log. Capacity C is measured later. Kafka is the named next step after a measured threshold, not a P1 component.

The open sequencing question is whether P1 may ship that machinery as a single process and call the second replica a later exercise. A single process hides lock and crash bugs that only appear when two relays compete. Draft B treats those bugs as P1 bugs. The full §16.17 battery still belongs to the MVP slice. P1 runs the kernel-only subset that can fail without any domain plugin.

Valkey (D22) is the cache, the rate-limit counter, and the cross-replica hint for session-epoch fan-out and process-local SSE. It is a fork of the open-source Redis project from before that project's source-available license change, which is why a Redis-protocol client can speak the small command subset P1 uses. Durability and revocation stay in PostgreSQL (spec §6, ADR-0003).

## Decision

1. **P1's bus acceptance runs two kernel processes and two relays against one PostgreSQL primary.** The relays are two instances of one implementation. Each kernel replica may host a relay, and the same module may run as its own process. There is no leader election, no lease on "the" relay, and no correctness path that requires exactly one of them to be alive.

2. **The claim unit is the subscription row, and `safe_point` is a sequence.** `seq` is a `bigint`. `safe_point` is a `bigint`. A timestamp, or the horizon length cast to an integer, is not a cutoff the reader can compare to `seq`.

   The horizon is 10 seconds of database time (`clock_timestamp()`). Each allocation is a row in `kernel.seq_reservation(seq, allocated_at, finished_at)`, written on the reserved unpooled connection so other backends see it before the business transaction commits. `allocated_at` is `clock_timestamp()` at `nextval`. The business insert uses that same `seq`. `finished_at` is set when that transaction ends. A sweeper sets it when the allocating backend is gone (pid and backend start, so a recycled pid does not finish a live reservation) and the log row is either visible or absent.

   ```
   horizon_seq    = max seq reserved with allocated_at <= clock_timestamp() - horizon
   inflight_floor = min seq reserved with finished_at null
   safe_point     = least(horizon_seq, inflight_floor - 1)
   ```

   With no open reservation, `safe_point = horizon_seq`. With nothing old enough, the relay delivers nothing. The reader then takes committed-visible log rows with `seq > last_seq AND seq <= safe_point`. A sequence at or below `safe_point` with no log row is a gap and is skipped. An open reservation holds `safe_point` strictly below its `seq`, including when that reservation is older than the horizon, so a later committed sequence cannot move the cursor past it.

   A relay, in a short transaction: compute that `safe_point`; `SELECT` one live subscription that is behind it `FOR UPDATE SKIP LOCKED`; read a bounded batch of matching log rows. Delivery of one event is its own transaction: dedup marker `UNIQUE(subscription, seq)`, handler effects, cursor advance, fencing check. A second relay skips a locked subscription. A second attempt at the same seq hits the unique marker and commits no second effect. The log insert path does not take the subscription lock.

3. **Hints are optional. Polling is the net.** Each relay keeps one dedicated unpooled `LISTEN` connection. `NOTIFY` carries no payload and shares the outbox transaction. An alert fires when `pg_stat_activity` shows no listener. Polling about once a second still dispatches. Two listeners are the healthy two-replica case. One listener is degraded. Zero listeners are the alert. Valkey pub/sub is not on this path.

4. **P1's loss subset, on those two processes.** Crash after the handler effect and before ack redelivers the same idempotency key, and the unique marker keeps a single effect. A relay killed between enqueue and the delivery commit leaves the log row and does not advance the cursor. A rolled-back `seq` is skipped only once `safe_point` has passed it. A filtered subscription advances across types it does not handle. A payload version the subscription lists and does not accept parks that subscription: cursor unchanged, row retained. `NOTIFY` with both listeners down still delivers by polling. Retention does not delete a row still at or above the minimum of live cursors and unexpired tenant watermarks (design §4.2, §4.4). The rest of §16.17 (zombie lease, external idempotency keys) lands with the component that introduces it: jobs in the pg-boss task, external effects when the first brokered egress exists.

5. **pg-boss stays behind the log, and the pin waits for a pooler proof.** Registry metadata read on 2026-11-01: `pg-boss` 12.38.0, MIT, published 2026-10-13, `engines.node` `>=22.12.0`. The published `README` states that pg-boss relies on PostgreSQL `SKIP LOCKED`. The published `dist/plans.js` defaults the claim to `FOR UPDATE … SKIP LOCKED` (`noSkipLocked` false). That reading adopts nothing. ADR-0003 requires the claim to be verified on the pin we run. P1 adopts a pin only after a harness passes through PgBouncer in transaction mode with `max_prepared_statements = 0`, the unnamed-statement default from ADR-0002. A pin that needs named prepared statements, session advisory locks, or `LISTEN` on a pooled connection is not adopted. BullMQ remains the dispatcher swap ADR-0003 already allows, behind the same contract.

6. **Valkey is not the log, the job store, or the revocation authority.** P1's default is a single Valkey primary. Loss of Valkey drops cache hits, cross-replica SSE hints, and fast epoch fan-out. Ordinary requests then follow the PostgreSQL freshness lease. Admin and sensitive routes still read the session row. Rate limiting fails closed (`UNAVAILABLE`) while the counter store is unreachable. A restored Valkey snapshot cannot authorize a session (spec §16.15). Valkey Cluster and Sentinel are deployment options for later; the kernel uses a command subset (get, set, delete, expire, increment, publish, subscribe, ping) so a topology change is a client configuration change. The pin is chosen in the cache task. Observation on 2026-11-01: Valkey 9.1.3, released 2026-10-26, BSD-3-Clause. The 9.1.3 `README` states the project was forked from the open-source Redis project immediately before the license change. The introduction on valkey.io documents replication, Sentinel, Cluster, pub/sub, and key expiry. D22 still allows the operator to bring another server that implements the same commands. P1 does not ship a Redis-branded default.

7. **One PostgreSQL primary is the v1 data plane.** Two application replicas are not multi-primary, not tenant sharding, and not the dedicated-database placement spec §18 defers. The D10 flip (forecast peak above 50% of measured C, then Debezium to Kafka, or cell sharding if OLTP is the limit) is unchanged.

## Consequences

- A P1 green run on one process does not meet this record. The task is red until two processes have run the subset in decision 4.
- Plugin-level parked cursors and the per-tenant enablement watermark are specified in the design. They ride the same log. They do not introduce a second bus.
- Read replicas stay incompatible with transaction-pinned `set_config` (spec §5). This record does not add one.
- Operating-envelope numbers stay provisional at P1 and are revised against P4 measurements (spec §15). This record sets no delivery date (issue #15).

## Flip conditions

- The two-process subset fails unless a leader is introduced. That falsifies decision 1. Fix the claim or the horizon. Do not add an election to make the test pass.
- The pg-boss pooler proof fails on the grounds in decision 5. Leave jobs on the outbox until a pin passes or a maintainer-accepted swap is written. Do not point plugins at a second queue.
- Measured C crosses the D10 threshold. Follow D10. This record does not move that threshold.

## Sources

Retrieved 2026-11-01.

| Artifact | What was checked |
|---|---|
| `pg-boss` 12.38.0 | Registry `time` 2026-10-13, license MIT, `engines.node` `>=22.12.0`. Published `README.md`: relies on PostgreSQL `SKIP LOCKED` for concurrent claim. Published `dist/plans.d.ts` and `dist/plans.js`: default claim is `FOR UPDATE SKIP LOCKED`; `noSkipLocked=true` turns it off. |
| Valkey 9.1.3 | Release 2026-10-26. `COPYING` SPDX `BSD-3-Clause`. `README.md` on tag 9.1.3: forked from the open-source Redis project before the source-available license change. [Introduction](https://valkey.io/topics/introduction/): in-memory store, replication, Sentinel, Cluster, pub/sub, TTL. |
| ADR-0003, D10, D22, spec §6–§7 | Log shape, revocation authority, license posture for the cache. |
