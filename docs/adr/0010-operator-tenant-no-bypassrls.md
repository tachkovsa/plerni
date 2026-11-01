# ADR-0010 — The platform operator is a tenant, and runtime roles have no bypass

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §4.6 (one canonical tenant policy), §5 (shared database, RLS, no standing bypass), §6 (bootstrap)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D05**, **D08**
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §5.4 and §9.7
- **Tightens:** [ADR-0008](0008-capability-grants-and-schema-role.md), which does not include an installation-plane grant
- **Number:** 0008 and 0009 are the other draft-B proposals. 0010 is the next integer.

## Context

Maintenance, package install, and an announcement addressed to every tenant need an actor outside a single customer. A role with `BYPASSRLS`, or a tenantless user row, would make that actor easy and would also make a bug in it a cross-tenant read. D05 requires `tenant_id NOT NULL`, `FORCE RLS`, and exactly one canonical tenant policy on every tenant-domain table.

The tenant registry is not tenant-domain data. It is the list of tenants. Putting it behind the customer policy would hide the list from the broker that expands a fan-out.

This record replaces the earlier `plane.installation` grant. That grant was a capability bit on an otherwise ordinary session. The bit was easy to confuse with a bypass. The operator is a real tenant instead.

## Decision

1. **Bootstrap creates one operator tenant** (`tenants.kind = operator`) and its first admin. Customer tenants are `kind = customer`. The operator tenant cannot be deleted. A partial unique index keeps the count at one.
2. **Every tenant-domain table, including users in the operator tenant, keeps `tenant_id NOT NULL` and the one canonical policy.** The operator admin's session sets `plerni.tenant_id` to the operator tenant. That session sees operator-tenant rows only.
3. **`kernel.tenants` is kernel-internal.** It has no tenant policy. `SELECT` is granted to the broker service role. Plugin roles have no grant on it. A customer session learns its own tenant id from the host-built context.
4. **No runtime role has `SUPERUSER` or `BYPASSRLS`.** The migration role is not a runtime role and has neither attribute. Catalog checks use ordinary catalog visibility.
5. **Platform routes require the session's tenant kind to be `operator`.** A customer admin's grant does not satisfy them. The manifest marks those routes `scope: platform`.
6. **Cross-tenant work is host fan-out, one transaction per target tenant.** The operator transaction writes only kernel-internal claim rows. Each child runs after the hygiene protocol and `set_config('plerni.tenant_id', target, true)`. The plugin handler on that path is ordinary tenant-scoped code. No statement reads plugin rows from two tenants.
7. **A platform route that edits one customer tenant** takes the target tenant from the path, checks the operator, and opens one transaction whose GUC is that tenant. The audit row records the operator and the target.

## Consequences

- Announcements to every tenant, to one tenant, or to one group use this primitive. The announcements plugin does not gain a query that reads another tenant's rows.
- The two-tenant isolation suite includes an operator session: it can list tenant ids through the platform route, and a direct query as a plugin role returns no customer rows.
- A future dedicated-database placement annex may move a customer tenant. The operator tenant stays on the control database. This record does not design that annex.

## Flip conditions

- The no-bypass rule does not flip. A feature that seems to need `BYPASSRLS` is redesigned as fan-out or as a kernel-internal table with an explicit grant.
- More than one operator tenant is a product change and needs its own record.
