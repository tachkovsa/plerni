# ADR-0003 — Unified outbox + pg-boss: one durable machinery for events and jobs

- **Status:** Accepted · **Date:** 2026-10-14
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §7 (queue & events), §16.17 (duplicate/loss battery)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D10**
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §5 (capacity method), §8 (replacement-validation branch)

## Context

The platform needs durable work: domain events (subscriptions, cross-plugin consistency) and background jobs (retries, scheduling, deadlines). The predecessor's operational record (its outbox incidents are cited in the register's evidence) shows the failure modes: fan-out write amplification, leader-elected relays stalling silently, and delivery rows that can't prove what happened after a crash. Two properties are non-negotiable for us: work intent must commit **atomically with the business mutation** (the WorkUnit contract, spec §4.3), and correctness must never depend on a leader (SaaS replicas must not share fate through an election).

The design must also stay honest about scale: PostgreSQL is the substrate until measurements say otherwise, and the migration trigger is a measured threshold — never a calendar or a fashion cycle.

## Decision

1. **One machinery.** Events and jobs are outbox rows committed in the business transaction (via WorkUnit at the plugin tier, directly in kernel services). No separate event bus, no separate job queue at the durability layer.
2. **Event log shape (per the δ-pass rewrite recorded in the register):** a single append-only log in the kernel schema — `(seq bigserial, tenant_id, aggregate_type, aggregate_id, type, version, payload, created_at)`. `seq` from a PG sequence (non-transactional allocation; rollbacks leave absent rows, readers tolerate gaps). Subscriptions hold **one global cursor** (`last_seq`), never per-aggregate state. Readers use the **lagging-horizon rule**: process committed-visible rows with `seq > last_seq AND seq <= safe_point` (default horizon 10 s) so in-flight transactions' lower-sequence rows are never skipped.
3. **Lazy fan-out.** No eager per-subscription delivery rows at write time (that S×E amplification is the in-DB killer shape). An append-only log + durable per-subscription cursors materialize deliveries lazily. Retention is low-water-marked on the slowest *live* cursor (parked subscriptions honored per spec §4.5); poison/unroutable events go to a DLQ table with alarms, never to silent deletion.
4. **Relay topology:** stateless competing relay workers on every replica — **no leader election**. Claiming via short `FOR UPDATE SKIP LOCKED` transactions (PgBouncer-transaction-mode safe). LISTEN/NOTIFY is a zero-payload wake-up hint on a dedicated, unpooled, health-checked connection (an alert fires when no relay listener appears in `pg_stat_activity`); polling every ~1 s — continuous under backlog — is the correctness net, not a fallback. NOTIFY shares the outbox row's transaction, so wakeups are commit-consistent.
5. **Jobs → pg-boss** (claim/retries/expiry; SKIP LOCKED claiming must be verified in our pinned version) with the kernel envelope: tenant, plugin, handler+payload version, idempotency key, deadline, attempt budget, trace, service identity. The outbox→job handoff is a single transaction (claim row, insert job, mark dispatched) — exactly-once *inside* PostgreSQL; beyond PG's boundary only at-least-once exists, and the SDK says so in writing. Jobs are unordered by contract; handlers needing ordered side effects consume the event layer. `expiredIn` ≥ 3× p99 handler runtime, with a conservative cold-start default per job class until real p99 exists.
6. **Duplicate/loss battery is the acceptance suite** (spec §16.17): crash-after-effect-before-ack → redelivery carries the same idempotency key; zombie worker + lease expiry → fencing tokens rejected; retention never deletes below the slowest live cursor; relay crash between enqueue and publish-ack is atomic (same-connection transaction); NOTIFY listener absent → polling still dispatches within the latency floor; rolled-back seq allocations are skipped by the lagging horizon.
7. **Fairness:** per-tenant/plugin concurrency + enqueue admission limits; bounded batches; oldest-pending-age alerts; a boot/health check fails loudly if the dispatcher isn't draining.

## Consequences

- **Capacity is measured, never calendared.** Capacity C = sustained deliveries/sec while p99 publication lag ≤1 s, claim p95 ≤50 ms, foreground p99 degradation ≤20%, vacuum keeps up. Migration starts when forecast peak exceeds 50% of measured C. Reference ceilings on tuned NVMe PG: ~10–30k events/s batched dispatch; pg-boss low thousands of jobs/s per queue.
- **Named next step:** Debezium outbox CDC → Kafka, keyed by tenant+aggregate. If foreground OLTP is the limit instead → tenant-to-cell PG sharding (Kafka doesn't fix that).
- **Upgrade path preserved:** BullMQ (incl. its PostgreSQL backend) remains a possible dispatcher swap behind the unchanged contract.
- PgBouncer transaction mode constrains the relay: LISTEN/NOTIFY and advisory locks require dedicated unpooled connections (the relay gets one; see the harness's pooling rules).
- Plugin subscriptions participate in the disable lifecycle: parked cursors are exempt from retention within a bounded backlog quota (spec §4.5).

## Flip conditions

Forecast peak exceeds 50% of **measured** capacity C → migrate dispatch to Kafka (Debezium CDC), per D10's flip condition. Never earlier; never on projections without measurements.
