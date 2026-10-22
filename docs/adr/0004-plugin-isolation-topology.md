# ADR-0004 — Plugin isolation topology

- **Status:** Accepted · **Date:** 2026-10-22
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §1 invariant 5, §2 (runner topology), §4.4 (trust tiers), §5 (tenant wall), §17.2, §18
- **Register:** [`../decision-register.html`](../decision-register.html) — **D11**
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §2, §4, §8 item 10; [`../plans/2026-10-13-p0-detailed-implementation-plan.md`](../plans/2026-10-13-p0-detailed-implementation-plan.md) T10
- **Evidence:** [`../plans/2026-10-18-spike-b-report.md`](../plans/2026-10-18-spike-b-report.md); [ADR-0006](0006-ipc-flow-control.md); spike merged as #51 (`655ee20`)
- **Issue:** #18

## Context

D11 chooses topology over trust. Operator-approved plugins, including every first-party plugin, run as supervised child processes, one process per plugin and never one process per tenant. The untrusted tier — container isolation, or remote integration only — waits for measured demand (spec §15 P5).

Spec §2 is the shape that stdio and an egress-denied network can share. The plugin-runner hosts the supervisor. The supervisor keeps one mutually authenticated channel to the kernel on the internal-only network, spawns the plugin child, and speaks framed NDJSON over that child's stdio. The capability credential is issued at spawn and binds every call to plugin identity, version, and grants. v1 is one process per plugin. Pooling is dropped because it collapses per-plugin identity (spec §18).

Egress is the network. The runner reaches only the kernel broker and an operator allowlist of internal services. External HTTP, telemetry, and subprocess egress go through tenant-bound broker ports. A single-process dev topology relaxes this and says so (spec §4.4). The P0 compose harness is that relaxation (plan §2).

The tenant wall is not this topology. Spec §5 keeps it in PostgreSQL RLS plus the application tenant guard. A plugin process serves many tenants. The broker stamps the tenant for the call.

Spike B's evidence label, verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance".

| ID | Spike B report |
|---|---|
| B1 | PASS. Frozen shape, ≥5000 round-trips/s, p99 ≤10 ms, corrupt 0. |
| B2 | PASS, including concurrent commit-vs-revoke. |
| B3 | FAIL on that substrate. Partial high-water 69632, above the 36864 allowance. Accounted totals 106496, 57344, and 155648, above the 53248 allowance. Flow control is ADR-0006. |
| B4 | PASS. A malformed child leaves its sibling alive. |
| B5 | PASS. Mid-call exit is a typed error. The retired token is refused. |
| B6 | PASS. The supervisor stamps identity from the spawn-time credential. A sibling cancel under flood stays within 500 ms. The identity-stamping vacuity control fails the way its oracle requires. |

Recovery, which T6 requires this record to cite: `queued-past-lease` leaves a `QUEUED` row older than the lease `QUEUED`, and sweeps an expired `ACTIVE` row to `ABANDONED`. `second-executor-takeover` rejects a stale token after `COMMITTED`, `CANCELLED`, and `ABANDONED`: zero rows updated, fenced, takeover effects 0.

This record compares three ways to host that plugin code. ADR-0006 is the flow-control mechanism under the option this record adopts. It claims bounded hostile IPC for non-colluding plugins on the tested Linux ABI. The runtime, the pre-start helper cache, and ambient same-UID access stay trusted.

## Options

1. **OS process per plugin, framed NDJSON over stdio.** The supervisor spawns a child. Calls, cancels, and grants are IPC. ADR-0006 reserves the kernel writer-end ceiling inside the configured caps. This is spec §2 and §4.4.
2. **`worker_threads`.** Each plugin is a Node `Worker` in the supervisor process. Node documents that most Node.js APIs are available inside a Worker, that workers can share memory by transferring `ArrayBuffer`s or sharing `SharedArrayBuffer`s, and that workers are for CPU-intensive JavaScript and do not help much with I/O-intensive work ([worker_threads](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html)). Spec §18 rejects this as a security boundary because Node capabilities leak.
3. **In-process V8 isolate sandbox.** Each plugin is a V8 isolate (its own heap) or a `vm` context inside the supervisor, with a narrowed API. V8's embedder guide defines an isolate as a VM instance with its own heap ([embed](https://v8.dev/docs/embed)). Node's `node:vm` module, which runs code in a V8 context, states that it is not a security mechanism and must not run untrusted code ([vm](https://nodejs.org/docs/latest-v22.x/api/vm.html)). A hardened isolate is still an object inside the supervisor's OS process.

## Comparison

| | OS process + IPC | `worker_threads` | V8 isolate sandbox |
|---|---|---|---|
| Security | Separate address space. B4: a malformed child leaves its sibling alive. B5: the crash is typed and the old token is refused. B6: identity is stamped before multiplexing. Spawn does not hand the child the supervisor's broker socket. The child still shares the runner's network namespace; egress denial is that environment (spec §4.4). The published claim is ADR-0006's bounded hostile IPC, which matches spec §17.2 (a trusted-code runtime is not a sandbox). Same-UID file and cache access stay trusted. | Same OS process as the supervisor and every sibling, which is the process that holds the broker socket. Most Node APIs are available in the worker, which is the capability leak spec §18 names. Shared memory is a documented feature. `worker.terminate()` stops that thread. | Own heap, so a JavaScript reference stays inside the isolate. `node:vm` is not that boundary. The isolate still shares the supervisor's process, file descriptors, and broker socket. A fatal native error and a process-wide memory limit take every plugin with the supervisor. |
| Multi-tenancy | One process per plugin, many tenants per process. The tenant wall stays RLS plus the broker guard (spec §5). The child sees the call the supervisor sent; the broker checks the tenant again at commit (fencing, B2). | Every tenant's in-flight calls for every plugin share the supervisor heap. A leaked object in that heap is cross-tenant. A worker per tenant multiplies that shared heap by tenants, which is the per-tenant footprint D11 rejects. | Same shared process. An isolate per tenant has the same multiplication and still does not move the tenant wall out of PostgreSQL. |
| Performance | B1 PASS on the frozen shape: ≥5000 round-trips/s, p99 ≤10 ms, 1 KiB payloads, corrupt 0. The cost is one Node heap per plugin, paid when the child is activated, not on each call. B3 failed on flow control; ADR-0006 is that redesign. The B1 rate bar held on this topology. | Lower per-call copying, and shared memory can avoid the copy. Port calls are I/O-shaped; Node documents that workers do not help much there. No measurement against the B1 contract. Shared memory would also drop the byte accounting ADR-0006 requires. | V8 documents that the first context is the expensive one and later contexts are cheaper. That is startup of contexts, not the B1 sustained rate. An isolate on the supervisor thread stalls every plugin behind one call. There is no measurement. |
| Operability | The spike already spawns, reaps, respawns, and fences. One plugin crash leaves the others (B4, B5). Limits and logs attach to a pid. The product boots on hosts that disable user namespaces, because this option does not require one. The dev topology relaxes egress and says so. | One native fault or one process OOM takes the runner down. rlimits and a seccomp filter are process-wide, so they cannot tighten one plugin while the supervisor keeps its broker socket. There is no per-plugin pid for the operator to restart. | Not a Node LTS API. `node:vm` is the API that looks like this option, and Node forbids that use. A real isolate means embedding V8 or shipping a native addon: a second runtime beside the pinned Node, an ABI, and an air-gap supply-chain surface. Spec §1 invariant 5 (mainstream-only) and the Wasm rejection in §18 are the same class of objection. |

## Decision

Adopt option 1 for the operator-approved tier.

One runner supervisor. One Node child process per plugin, never per tenant. Framed NDJSON over stdio, with ADR-0006 as the flow-control record. The supervisor stamps identity from the spawn-time capability credential before multiplexing. A child-supplied identity is an untrusted hint (spec §4.4, plan §4 B6). Egress is the runner network in Context. Equal citizenship is the contract, not equal trust (ADR-0001).

Reject option 2. Spec §4.4 and §18 already reject `worker_threads` as a boundary. The comparison above is the reason: shared process, shared memory, and a full Node API, with no spike evidence against B1–B6.

Reject option 3. An in-process isolate has its own heap and still shares the supervisor's process and sockets. `node:vm` is not a security mechanism. The option adds an embedder or a native addon that the mainstream-only invariant does not call for, and no spike measured it.

The untrusted tier stays deferred. Container isolation, or remote-integration-only, is spec §4.4's answer when the code is not operator-approved. It is not built here, and it is not a fallback to option 2 or 3.

## Consequences

- The merged spike (`655ee20`) is this topology plus ADR-0006's ceilings. It does not claim malicious-plugin isolation. Plugin-to-plugin tampering, plugin-to-cache tampering, dumpable after exec or re-exec, and same-user file writes sit outside the operator-approved claim.
- A host that disables user namespaces still runs this topology. Those namespaces are not a boot requirement.
- Dev and the P0 harness stay single-host. They are the stated relaxation of the egress-denied production topology.
- Spike B does not prove the broker. The evidence label stands until P2 acceptance.
- B3's failed figures are a flow-control result. They are not buffer sizes and they do not flip D11. ADR-0006 owns that redesign.
- About 50 plugins on one host means about 50 long-lived Node heaps. That memory is the cost of a separate address space per plugin. B4 and B5 are the crash boundary that space buys.

## Flip conditions

Demand for untrusted third-party code builds the container tier, or remote-integration-only, per D11. Spec §15 P5 starts on measured demand: at least three external authors with real installs via manual distribution. That demand leaves the operator-approved process topology in place.

A miss of B1's rate bar on a later substrate is ADR-0006's flow-control flip. It does not switch the operator-approved tier to worker threads or an in-process isolate.

## Sources

Retrieved 2026-10-22:

- Node.js v22 `worker_threads`, <https://nodejs.org/docs/latest-v22.x/api/worker_threads.html>
- Node.js v22 `vm`, <https://nodejs.org/docs/latest-v22.x/api/vm.html>
- V8 embedder's guide, <https://v8.dev/docs/embed>
