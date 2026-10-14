# Contract conventions

**Status:** Accepted at P0 · **Date:** 2026-10-14 · **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §6 · **Spec:** [`2026-10-12-plerni-design.md`](2026-10-12-plerni-design.md) §8, §10, §12

Every convention below is stated as a **checkable rule** — each must be enforceable by a lint/gate when its subject lands (compliance lives in code, spec §12). Where a rule's mechanism lands later than the rule, the landing phase is named.

## 1. One registry drives every surface

- **R1.1.** All API contracts are zod schemas in `packages/contracts`. REST routes, the generated OpenAPI document, and MCP tool descriptors are produced **from that single registry**. Hand-written OpenAPI or MCP descriptors are forbidden.
- **R1.2.** Plugin-owned domain contracts live in the plugin and **compose into** the registry at admission (spec §4.7); the kernel never imports a plugin, and no surface is hand-derived from plugin code.
- **R1.3.** Declarative UI schemas are *declared* per plugin and registered — never generated (presentation metadata has no home in zod, spec §1 invariant 2).

## 2. Versioning — four independent axes

- **R2.1.** The axes are: kernel release · plugin package · SDK protocol · public API. A versioned artifact names which axis it moves.
- **R2.2.** "Breaking" is defined per artifact type, and the breaking-change gate (spec §12) enforces it: **routes** — removing/renaming an operation ID, tightening a request schema, loosening a response schema, changing an error code's meaning; **events** — payload field removal/rename/retype without a version bump; **jobs** — handler payload or envelope change without a version bump; **ports** — signature or semantics change without an SDK major; **SDK** — per semver; **event payloads** — semver with deprecation windows.
- **R2.3.** The compatibility window (spec §10) covers API clients, queued work, persisted proposals, **and installed plugin code across SDK majors**.

## 3. Error envelope — transport-neutral

- **R3.1.** Every error carries: a closed-set `code`, a human message, and a mandatory **`next_step`** field (what happened, what it means, what to do next — principle 4 mechanized).
- **R3.2.** Codes are transport-neutral. Mappings fixed now: **HTTP** — the envelope's status field (e.g. `CONCURRENCY_CONFLICT` → 409); **MCP** — a tool result with `isError: true` and the code in the structured payload, **never** a JSON-RPC protocol error (spec §16.19 requires identical behavior over REST and MCP; MCP read ships in P1).
- **R3.3.** The closed code set is owned by `packages/contracts`; adding a code is a contract PR (the set includes at minimum: `VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONCURRENCY_CONFLICT`, `RATE_LIMITED`, `INTERNAL`, `UNAVAILABLE`).

## 4. Action classification

- **R4.1.** Every mutating action is manifest-classified as **`routine` | `sensitive` | `destructive`** (spec §8); the manifest declaration is lint-verified against the route contracts (a route mutating without a classification fails CI).
- **R4.2.** Sensitive/destructive actions pass through the durable-proposal ceremony with proof-of-human step-up (spec §8) — the ceremony is browser-gated by design and carved out of the API-parity gate, with its own browser test.

## 5. Event taxonomy — reserved for interop adapters

- **R5.1.** Event types are namespaced `<domain>.<noun>.<verb>` (e.g. `learning.assignment.completed`) and semver-versioned; the registry marks public vs plugin-private schemas (spec §4.8).
- **R5.2.** **No xAPI/SCORM/LTI nouns in kernel or contract-registry types.** Interop adapters (future plugins) publish under their own namespaces (`xapi.*`, `scorm.*`, …) per this taxonomy. The frozen workload assumptions for that traffic live in the plan's Annex L — referenced, never redefined here.
- **R5.3.** Unknown event version → the consumer parks with error, never best-effort handles (spec §4.8).

## 6. Executable no-AI workflow inventory

- **R6.1.** Every workflow declares its no-AI completion path in a machine-readable inventory (a JSON registry in `packages/contracts`, introduced with the first workflows).
- **R6.2.** A CI check — landing in P1 with the first workflows — verifies every inventory entry references an **existing** no-AI acceptance-test ID (the declaration without an executable path is a lint failure). Spec §12's gate table gains this row when the mechanism lands.
- **R6.3.** The assistant-absent UI state is a fixture-gallery state (spec §9), reviewed like any other workflow surface.
