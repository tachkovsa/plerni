# ADR-0015 — Object keys use a derived tenant and plugin prefix

- **Status:** Proposed · **Date:** 2026-11-11
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §3, §5, §14
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §1.1, §9.6, and the K11 row
- **Depends on:** [ADR-0008](0008-capability-grants-and-schema-role.md) (`storage.prefix`), [ADR-0014](0014-error-envelope.md)

## Context

K11 stores plugin bytes under a derived prefix. ADR-0008 says the broker derives that prefix from the plugin id. The acceptance also says tenant B cannot read tenant A's key. The plan does not name the key grammar, the bucket layout, or the missing-object envelope. A later task would otherwise guess those rules from the first implementation.

There is no kernel table for objects. Backup and erasure of stored bytes are K24, not this record.

## Decision

1. **One configured bucket.** The caller does not name a bucket. The gateway does not create buckets.
2. **The stored key is `t/<tenant-uuid>/p/<plugin-id>/<relative-key>`.** The tenant uuid is lowercased. The plugin id is the manifest id. The caller supplies only the relative key. The gateway does not accept a prefix, a bucket, or another tenant.
3. **A relative key is fail-closed.** It is one or more segments of letters, digits, `.`, `_`, and `-`, separated by a single `/`. `.`, `..`, an empty segment, a leading or trailing slash, a backslash, and any other character are rejected. The stored key must be at most 1024 bytes. A rejected key does not touch the store. The error is `VALIDATION`.
4. **`storage.prefix` is required.** Without that exact grant the call is `FORBIDDEN` and does not touch the store. Another plugin id is a different prefix, so the grant is not a bucket-wide credential.
5. **A missing object is `NOT_FOUND` with `next_step`.** That includes a key that exists only under another tenant or another plugin. The gateway does not look outside the derived key. Other store failures are `INTERNAL`. The store's message is not copied into the envelope.
6. **Put replaces the object at that derived key.** There is no conditional write in this task.
7. **A body is bytes, at most 32 MiB.** That cap is a provisional bound on one call so the request path cannot buffer an unbounded body. It is not the K26 envelope note. A larger body, or a body that is not bytes, is `VALIDATION` and does not touch the store.
8. **The store is S3-compatible.** The client is the AWS SDK for JavaScript S3 client, path-style, with checksums only when the operation requires them. The client does not retry. Credentials and the endpoint come from the caller. This record does not add a SQL migration.
9. **No HTTP route in this task.** A later upload route stays REST and calls this port. It registers in the zod registry when it exists.

## Consequences

- Tenant isolation for objects is the derived key. There is no row policy to stand in for it.
- Two plugins in one tenant do not share objects.
- Erasure can delete `t/<tenant-uuid>/` without a kernel index. That deletion is not this task.
- A new grant name is still an ADR. This record does not add one.

## Flip conditions

- A store that cannot honor path-style keys of this shape: stop and record the replacement. Do not let the caller supply the prefix.
- A measured need for conditional writes or a larger body: a new record. Do not special-case one plugin.

## Sources

Retrieved 2026-11-11.

- AWS SDK for JavaScript v3, [S3 checksums](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html): from 3.729.0 the client sends a CRC32 checksum unless calculation is limited to when the operation requires it.
- AWS SDK for JavaScript v3, [client constructors](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html): path-style addressing is `forcePathStyle`.
- AWS SDK for JavaScript v3, [`NoSuchKey`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Class/NoSuchKey/): the missing-object error.
- [ADR-0008](0008-capability-grants-and-schema-role.md), [ADR-0014](0014-error-envelope.md).
