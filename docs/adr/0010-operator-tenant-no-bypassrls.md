# ADR-0010 — The platform operator is a tenant, and runtime roles have no bypass

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §4.6 (one canonical tenant policy), §5 (shared database, RLS, no standing bypass), §6 (bootstrap admin)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D05**, **D08**
- **Plan:** [`../plans/p1-kernel-design-a.md`](../plans/p1-kernel-design-a.md) (draft A)
- **Number:** 0008 and 0009 are the other draft-A proposals. This is the next integer.

## Context

Two P1 features need an actor who can see more than one customer: the maintenance switch, and an announcement addressed to every tenant. A role with `BYPASSRLS` would make those features easy and would also make a bug in them a cross-tenant read. D05 requires `tenant_id NOT NULL`, `FORCE RLS`, and exactly one canonical tenant policy on every tenant-domain table. A tenantless user row, or a null `tenant_id` on a tenant-domain table, breaks that rule.

The tenant registry itself is not tenant-domain data. It is the list of tenants. Putting it behind the same policy would hide the list from the broker that has to expand a fan-out.

## Decision

1. **Bootstrap creates one operator tenant** (`tenants.kind = operator`) and its first admin. Customer tenants are `kind = customer`. The operator tenant cannot be deleted. There is exactly one.
2. **Every tenant-domain table, including users in the operator tenant, keeps `tenant_id NOT NULL` and the one canonical policy.** The operator admin's session sets `plerni.tenant_id` to the operator tenant. That session sees operator-tenant rows only.
3. **`kernel.tenants` is kernel-internal.** It has no tenant policy. `SELECT` is granted to the broker service role. Plugin roles have no grant on it. Customer sessions learn their own tenant id from the session the host already built.
4. **No runtime role has `SUPERUSER` or `BYPASSRLS`.** The migration role is not a runtime role, and it has neither attribute either. Catalog checks for the boundary checker use ordinary catalog visibility.
5. **Platform routes require the session's tenant kind to be `operator`.** A customer admin's grant does not satisfy them.
6. **Cross-tenant work is host fan-out.** A job manifest may declare `fanout: all_customer_tenants` or `fanout: named_tenants`. The host expands that into one child claim per target tenant, in the operator transaction that only writes kernel-internal claim rows. Each child runs in its own transaction after `set_config('plerni.tenant_id', target, true)` and the hygiene protocol. A plugin handler on that path is ordinary tenant-scoped code.
7. **A platform route that edits one customer tenant** (for example OIDC configuration) takes the target tenant from the path, checks the operator, and opens one transaction whose GUC is that tenant. The audit row records the operator and the target.

## Consequences

- Announcements to every tenant, to one tenant, or to one group use this primitive. The announcements plugin does not gain a query that reads another tenant's rows.
- The two-tenant isolation suite includes an operator session: it can list tenant ids through the platform route, and a direct query as the operator's plugin role returns no customer rows.
- A future dedicated-database placement annex may move a customer tenant. The operator tenant stays on the control database. This record does not design that annex.

## Flip conditions

- The no-bypass rule does not flip. A feature that seems to need `BYPASSRLS` is redesigned as fan-out or as a kernel-internal table with an explicit grant.
- More than one operator tenant is a product change (delegated operators) and needs its own record. This record's partial unique index stays until that record lands.
