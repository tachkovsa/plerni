# ADR-0013 — P1 keeps sensitive and destructive actions on human sessions

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §8 (action class, proof-of-human), §10 (MCP read in P1, MCP write in P3)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D17**, **D26**, **D32**
- **Conventions:** [`../specs/contract-conventions.md`](../specs/contract-conventions.md) R4
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §5.2 and §7
- **Number:** Next integer after 0012.

## Context

"AI proposes, humans commit" is mechanized in spec §8 by the durable proposal and a nondelegable proof-of-human step-up. That ceremony is P3. P1 already exposes service principals and a curated MCP read surface. Without a rule at this boundary, a principal or an MCP client can call a mutating route the ceremony does not cover yet and the product has already lost the rule.

P1 does not invent a weaker ceremony and call it the same thing. It refuses the calls the ceremony will later wrap.

## Decision

1. **Every mutating route carries a class** of `routine`, `sensitive`, or `destructive` in the manifest. A mutating route with no class fails admission. The lint is the one convention R4.1 already names.
2. **MCP in P1 is the read inventory.** A write-shaped MCP call returns `FORBIDDEN` with `next_step` pointing at the human route. The tool result uses `isError: true` and the shared envelope. It is not a transport-protocol error.
3. **Service principals cannot call `sensitive` or `destructive` routes.** A `routine` route still requires the principal's ordinary grants. A human session can call the classified routes. Admin and sensitive routes re-read the session row on each request (spec §6).
4. **The P3 ceremony wraps these same routes.** It does not add a second class vocabulary. Plugin handlers stay as they are when the proposal path arrives.

## Consequences

- Recording an assessment result, issuing a certificate, sending an all-tenant announcement, and previewing another person's flag variant are `sensitive` in the walkthroughs. A service principal and an MCP client receive `FORBIDDEN` on each.
- Routine plugin writes remain available to a service principal that holds the grant. The audit row records the principal.
- An MCP actor still holds no more than its human's grants (D26). This record only removes mutations from P1's MCP surface. It does not add grants.

## Flip conditions

- Moving MCP writes earlier than the P3 ceremony contradicts spec §10. This record does not flip to allow them.
- A routine route that is later reclassified as sensitive loses service-principal access at that reclassification. The manifest change is the break, on the public-API axis.
