# packages/contracts

Zod schemas for the public API. REST routes and the OpenAPI document are generated from this registry (spec §10, convention R1.1). Plugin-private routes stay on the registry and are left out of the document. MCP tool descriptors for the read inventory are a later task; the error helper already builds the tool result those tools will return.

## Error envelope

Frozen by K19 (plan §6, convention R3, [ADR-0014](../../docs/adr/0014-error-envelope.md)).

| Field | Required | Values |
|---|---|---|
| `code` | yes | `VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONCURRENCY_CONFLICT`, `RATE_LIMITED`, `INTERNAL`, `UNAVAILABLE`, `UNKNOWN_EVENT_VERSION` |
| `message` | yes | Human message. The plan names the field only as "human message"; the JSON key is `message`. |
| `next_step` | yes | What the caller does next. |
| `reason` | no | `maintenance`, `dependency_disabled`, `cache_unavailable`, `parked`, `quota` |

HTTP status comes from the code. Each code has one status: `VALIDATION` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONCURRENCY_CONFLICT` 409, `RATE_LIMITED` 429, `UNKNOWN_EVENT_VERSION` 422, `INTERNAL` 500, `UNAVAILABLE` 503. The plan assigns only 409. The rest are the map in ADR-0014. Changing one is an error-code meaning change.

`toMcpToolResult` puts that envelope on a tool result with `isError: true`. It does not build a JSON-RPC error.

## Kernel routes

`POST /kernel/tenants` (`kernel.tenant.create`) creates a customer tenant. The body is `{ "idempotencyKey": "..." }` with 1–200 characters from letters, digits, and `. _ : -`. The success body is the customer id, kind, and `createdAt`. The same key returns the same tenant.

## OpenAPI and the breaking-change check

`generateKernelOpenApi()` builds an OpenAPI 3.1 document from the registry. `openapi/kernel.openapi.json` is that document. The contract test fails when the file drifts, and when a document contains a path the registry did not declare.

`unversionedRouteBreaks` fails a document that, without a public-API major bump, removes or renames an operation id, tightens a request, loosens a response, or changes an error code's HTTP status (convention R2.2). An absent `type`, enum, `format`, `pattern`, or array `items` schema is unrestricted: adding one tightens a request, and removing one loosens a response. Nested schema `$ref`s are resolved before those constraints are compared. A repeated pair of schemas stops the walk, so a property that points at its own component does not recurse. `allOf`, `anyOf`, and `oneOf` are compared branch by branch when the keyword and length match, and any other composition change fails closed. The contract test compares the generated document with the OpenAPI blob on the merge base of the reviewed head and `origin/dev`. A pull-request checkout is a merge commit, so the reviewed head is that commit's second parent. Until the blob exists, the test uses the previous commit on the reviewed head. Regenerating `openapi/kernel.openapi.json` does not replace either blob. The `gates` job runs this test on every pull request.

```bash
pnpm --filter @plerni/contracts test
```

## Libraries

Checked against the npm registry on 2026-11-11:

- `zod` 4.6.7, MIT, <https://www.npmjs.com/package/zod>. JSON Schema conversion defaults to draft 2020-12, which OpenAPI 3.1 uses (<https://zod.dev/json-schema>).
- `@asteasolutions/zod-to-openapi` 9.1.0, MIT, peer `zod` `^4.0.0`, <https://www.npmjs.com/package/@asteasolutions/zod-to-openapi>. `OpenApiGeneratorV31` emits OpenAPI 3.1 (<https://github.com/asteasolutions/zod-to-openapi>).

The spec asks for OpenAPI 3.1, so the generator is V31 rather than the 3.2 generator in that same release. `openapi3-ts` is the locked transitive dependency and is MIT.
