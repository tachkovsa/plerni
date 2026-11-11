# ADR-0014 — Frozen error envelope and HTTP status map

- **Status:** Proposed · **Date:** 2026-11-11
- **Spec:** [`../specs/contract-conventions.md`](../specs/contract-conventions.md) R1–R3 · [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §10
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §6 and the K19 row

## Context

K19 freezes the first error envelope so later fields cannot arrive as a small response change. The plan names `code`, a human message, `next_step`, and an optional `reason`. It says HTTP status comes from the code, and it assigns a status only for `CONCURRENCY_CONFLICT` (409). The JSON name of the human message is not given. `UNKNOWN_EVENT_VERSION` is in the code set and also has no status.

OpenAPI is generated from the zod registry. A hand-written path fails review. The breaking-change check covers kernel routes (convention R2.2).

## Decision

1. **The human message field is `message`.** The other JSON keys are the names in the plan: `code`, `next_step`, and optional `reason`.
2. **Each code has one HTTP status.** `VALIDATION` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONCURRENCY_CONFLICT` 409, `RATE_LIMITED` 429, `UNKNOWN_EVENT_VERSION` 422, `INTERNAL` 500, `UNAVAILABLE` 503. 422 is used for `UNKNOWN_EVENT_VERSION` because that failure is not a concurrency conflict. One status per code keeps a response from naming two codes.
3. **Changing a status, removing a code, or renaming `message` is an error-code meaning change.** The check treats it as a break unless the public API major in the OpenAPI `info.version` changes.
4. **OpenAPI 3.1 is generated from the registry** with `OpenApiGeneratorV31`. Plugin-private routes are not emitted. A document path whose method, path, and operation id are not a public registry route fails review. The committed `packages/contracts/openapi/kernel.openapi.json` must match the generator.
5. **An MCP failure is a tool result** with `isError: true` and the envelope as `structuredContent`. It is not a JSON-RPC error. Registering the read tools is a later task.
6. **`POST /kernel/tenants` is `kernel.tenant.create`.** It is the K2 create-tenant API. The route is `sensitive` and `platform`. An idempotency conflict that is still unresolved after the reread is `CONCURRENCY_CONFLICT`.

## Consequences

- Callers can rely on `next_step` and on 409 for `CONCURRENCY_CONFLICT`.
- A new error code or a new reason is a contract change in `packages/contracts`.
- The kernel HTTP adapter is a `Request`/`Response` function. It does not import a framework. The spec's framework adapter, when it arrives, stays behind that function.

## Flip conditions

- A public API major can rename `message` or reassign a status. The breaking-change check must see that major, or the change does not land.
- Sharing one HTTP status across two codes needs a new record. The current document cannot express it.
