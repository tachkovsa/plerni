# ADRs

Architectural Decision Records. Short, dated, and they explain **why**, not just what.

- Get the next free number by listing this directory — never trust a number written in prose.
- New SDK capability or trust boundary → ADR first (spec §13).
- Acceptance follows [`../ai/model-routing.md`](../ai/model-routing.md). When every drafting model family is known, the reviewer is a human or an agent from a different model family than every generator, and the receipt states that separation. When a drafting family is unknown, the maintainer decision of 2026-10-26 accepts the record on a review by the project's maintainer-designated assistant reviewer plus a clean Codex review of the exact head. A human review is not required on that path. The receipt names that exact head, states that the review was done under this maintainer rule, and carries no human-review claim and no family-separation claim.

The pre-implementation decision record (32 decisions with evidence and flip conditions) lives in [`../decision-register.html`](../decision-register.html) and is summarized by ADR-0001.

## Index

- [0001 — Kernel + equal-citizen plugins](0001-kernel-and-equal-citizen-plugins.md)
- [0002 — ORM / data layer](0002-orm-data-layer.md)
- [0003 — Unified outbox + pg-boss](0003-outbox-pgboss.md)
- [0004 — Plugin isolation topology](0004-plugin-isolation-topology.md)
- [0005 — UI kit + token compiler](0005-ui-kit-token-compiler.md)
- [0006 — IPC flow control (Proposed)](0006-ipc-flow-control.md)
- [0007 — Pooled contamination recovery](0007-pooled-contamination-recovery.md)
