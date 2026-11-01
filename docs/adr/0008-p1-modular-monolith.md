# ADR-0008 — P1 loads plugins in-process

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §2 (runner topology), §4.4 (trust tiers), §15 (P1 kernel, P2 plugin platform), §16.4 and §16.12 (crash isolation and egress, both P2 exit tests)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D11**, **D23**
- **Related:** [ADR-0004](0004-plugin-isolation-topology.md) stays Accepted. This record proposes when that topology starts. [ADR-0001](0001-kernel-and-equal-citizen-plugins.md) stays Accepted.
- **Plan:** [`../plans/p1-kernel-design-a.md`](../plans/p1-kernel-design-a.md) (draft A)
- **Number:** Listing `docs/adr/` shows 0001–0007. This is the next free integer.

## Context

ADR-0004 decides the v1 isolation mode: one supervised Node child process per installed plugin, brokered, with production egress decided by placement. The spec puts that runner in P2. P2's exit criteria are the external tarball, the rolling runner restart, crash isolation, and the egress test.

P1's exit criteria are different: tenant isolation, named API-only workflows, and a backup/restore drill. P1 also has to prove the kernel boundary the maintainer set for this phase: a plugin owns its tables and its migrations, and adding one leaves the kernel source unchanged. That proof needs a host that can admit a manifest, apply SQL, and call the plugin. It does not need the runner.

Building the runner inside P1 would make the kernel exit depend on IPC, supervisor credentials, and egress placement. Those are P2's subject. Shipping P1 with no host at all would leave the boundary unproven until P2, which is too late: the kernel services would grow around an imagined plugin shape.

`worker_threads` and `node:vm` stay rejected. ADR-0004's rejection of an in-process isolate as a security boundary still stands. This record does not reopen it.

## Decision

1. **P1's host is in-process.** The kernel process loads each admitted plugin as a module and calls it through the port types in `packages/contracts`. The host stamps tenant, actor, plugin identity, version, grants, trace, and deadline. The plugin does not mint them. The plugin holds no database connection and submits writes as WorkUnits.
2. **The port types are the stable surface.** P2's supervisor performs the same call over framed NDJSON. A plugin that uses only those types moves to the child process without a rewrite of its tables, contracts, or handlers. ADR-0004 remains the placement for that later move.
3. **Admission has one function.** First-party workspace packages and, in P2, external tarballs both enter through `admit`. P1 does not add a side door for first-party code. P1 does not verify a tarball signature; P2 adds that check in front of the same function.
4. **The kernel source does not name plugins.** The loader reads the install journal. Plugin ids, including ids that are governed domain nouns, live in the journal and under `plugins/`. `apps/kernel/src` stays free of those nouns (the kernel-purity gate).
5. **P1 states the residual honestly.** A plugin fault can stop the kernel process. Spec §16.4 (kernel and siblings serving within 10 seconds) and spec §16.12 (direct network from a plugin fails because of placement) remain P2 exit tests. An import lint that forbids plugin network modules is a P1 hedge. It is not those tests, and it is not a sandbox.

## Consequences

- P1 compose is one application image: kernel replicas, PgBouncer, PostgreSQL, the cache, object storage, and a proxy. The plugin-runner service arrives with P2.
- Equal citizenship in P1 means the same manifest, the same migration rules, and the same `admit` function. It does not mean a process boundary that P2 has not built.
- Accepting this record times ADR-0004's child-process mode to P2. It does not change the topology ADR-0004 chooses, and it does not withdraw ADR-0004.
- Rejecting this record leaves ADR-0004 in force for P1 as well. Draft A's in-process host tasks would then be withdrawn.

## Flip conditions

- Accepting ADR-0004's topology earlier, by building the P2 runner before the P1 exit, withdraws the timing half of this record. The port types stay.
- A P1 measurement in which an in-process plugin fault blocks the API-only exit workflows is a reason to start the runner sooner. It is not a reason to adopt `worker_threads` or `node:vm`.
- The D11 flip (untrusted third-party code, on the P5 demand trigger) is unchanged. This record does not build a sandbox.
