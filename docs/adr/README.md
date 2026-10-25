# ADRs

Architectural Decision Records. Short, dated, and they explain **why**, not just what.

- Get the next free number by listing this directory — never trust a number written in prose.
- New SDK capability or trust boundary → ADR first (spec §13).

The pre-implementation decision record (32 decisions with evidence and flip conditions) lives in [`../decision-register.html`](../decision-register.html) and is summarized by ADR-0001.

## Index

- [0001 — Kernel + equal-citizen plugins](0001-kernel-and-equal-citizen-plugins.md)
- [0003 — Unified outbox + pg-boss](0003-outbox-pgboss.md)
- [0004 — Plugin isolation topology](0004-plugin-isolation-topology.md)
- [0006 — IPC flow control (Proposed)](0006-ipc-flow-control.md)
- [0007 — Pooled contamination recovery](0007-pooled-contamination-recovery.md)
