# ADR-0011 — Plugins sign digests; the secret store keeps the keys

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §6 (kernel secret store), §4.3 (Secrets port returns references, never values)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D05** for tenant-scoped key material, spec §6 for KEK custody
- **Plan:** [`../plans/p1-kernel-design-a.md`](../plans/p1-kernel-design-a.md) (draft A). The roadmap's signing hook is the same port.
- **Number:** Next integer after 0010.

## Context

A certificate plugin has to produce a signature a verifier can check later. The key material belongs in the kernel secret store: envelope-encrypted, per-tenant data keys under a kernel key-encryption key, with the key-encryption key coming from the environment or a key file. The Secrets port in spec §4.3 resolves references at the broker and does not hand values to plugins. Signing is the operation that uses the private key without changing that rule.

Issue #62 tracks backup and rotation of the maintainer signing key used for approval artifacts. That key is a different key, for a different purpose. This record does not decide its backup procedure.

## Decision

1. **The broker exposes `secrets.sign` and `secrets.verify`.** `sign` takes a tenant-scoped key reference and a digest, and returns the signature and the public key id. `verify` takes the public key id, the digest, and the signature. Neither operation returns private key bytes, the data key, or the key-encryption key.
2. **The plugin declares the grant.** A manifest that does not request `secrets.sign` is rejected at the call. The grant is per plugin and per tenant enablement.
3. **Keys are per tenant.** Creating a signing key is a sensitive route. The key row carries `tenant_id NOT NULL` and the canonical policy. The operator tenant can hold a key for operator-scoped documents. A customer certificate uses the customer tenant's key.
4. **Custody matches spec §6.** The key-encryption key comes from the environment or a key file. P1 does not depend on a network key service. Rotation is re-wrap of data keys, then re-encryption, as a broker procedure.
5. **Logs and audit store the key reference and the digest.** They do not store the signature's input document, the private key, or the key-encryption key. The audit of a sign call records actor, key reference, and digest.

## Consequences

- The certificate proof plugin calls this port. Adding that plugin does not add a kernel branch for certificates. The kernel never sees the document type.
- Backup of the secret store is part of the P1 backup/restore drill. Restoring an old database without the matching key-encryption key leaves ciphertext unreadable, which the drill records.
- `secrets.resolve`, when a plugin is granted it, still returns references. P1 grants `resolve` only to kernel services (notification channel credentials, OIDC client secrets). Plugins that only need signatures use `sign` and `verify`.

## Flip conditions

- A verifier that must check signatures without calling the broker needs the public key exported. `verify` already returns no private material; a later record may add a public-key read. Private-key export is not a flip this record allows.
- Moving the key-encryption key to an external module is an operations record. It stays out of P1, where air-gap installs have to boot with a local key.
