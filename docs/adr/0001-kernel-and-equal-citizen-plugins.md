# ADR-0001 — Kernel + equal-citizen plugins

- **Status:** Accepted · **Date:** 2026-10-12
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) (the load-bearing reference)
- **Register:** [`../decision-register.html`](../decision-register.html) (32 decisions, D01–D32, with evidence and flip conditions)

## Context

Plerni rebuilds a previously sold enterprise HCM/LXP product from scratch (clean-room: concepts only, no code). The predecessor tried a dynamic plugin marketplace before demand existed, deleted it, and collapsed to compile-time feature flags; its first-party code bypassed the plugin contract, producing a second-class third-party developer experience. The full evidence base, including four independent adversarial model reviews and a historical counter-evidence pass, is integrity-manifested in `docs/reviews/SHA256SUMS.txt` (transcripts retained privately — they cite predecessor internals; available from the maintainer on request).

## Decision

1. **Stable kernel + plugins.** The kernel owns identity/sessions, tenancy (PostgreSQL RLS), resource authorization, plugin host, brokered persistence, the unified outbox (events + jobs), audit, the AI gateway control plane, storage, notifications plumbing, settings, the secret store, telemetry, and the admin shell backend. Everything else — including all first-party domains — is a plugin.
2. **Equal citizenship.** First-party and third-party plugins use the identical SDK, contracts, and admission pipeline (import parity + admission parity gates in CI). Trust tiers stratify *isolation*, never contract access.
3. **Contracts are the only shared code.** `packages/contracts` carries zod schemas, the event registry, and port types; `packages/sdk` is convenience code over them. The kernel never imports a plugin; plugins never import kernel internals.
4. **One artifact** for on-prem appliance and SaaS; multi-tenant from the first commit.

## Consequences

- Domain logic in the kernel fails the build (kernel-purity gate).
- Plugins ship SQL migrations and declared static queries; runtime data access goes through the broker (WorkUnit). No plugin ever holds a database connection.
- Every kernel capability is reachable via REST/OpenAPI and (curated) MCP; the shell is just another API client.
- The 32-decision register (D01–D32) is incorporated by reference; any reversal must cite its flip condition.

## Flip conditions

None accepted at acceptance time. The register records per-decision flip conditions; the equality invariant (D01) is explicitly non-flippable.
