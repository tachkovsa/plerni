# ADR-0008 — Per-plugin capability grants and schema role

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §4.3 (host-constructed context, no plugin connection), §4.4 (trust tiers), §4.6 (per-plugin schema), §5 (brokered grants), §17 risk 2 (trusted-code runtime mislabeled as a sandbox)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D07**, **D08**, **D11**. This record does not reopen them.
- **Depends on:** [ADR-0002](0002-orm-data-layer.md) decisions 6 and 9, [ADR-0004](0004-plugin-isolation-topology.md) decisions 1–4, [ADR-0007](0007-pooled-contamination-recovery.md)
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §2 and §3
- **Number:** Listing `docs/adr/` at drafting shows 0001–0007. 0008 is the next free integer.

## Context

Draft B of the P1 kernel design takes the isolation reading of the accepted records. A plugin owns its tables and its SQL. Installing one does not edit the kernel. Plugins reach each other through public contracts and the event log. The operator-approved tier is one supervised child process per plugin.

ADR-0004 already draws the line spec §17 risk 2 cares about. That process contains a fault and a confused plugin. It does not contain a hostile plugin that shares the runner user. The untrusted tier (OS or container isolation, or remote-integration-only) stays deferred to measured demand. This record does not move that tier into P1, and it does not rename the child process into a sandbox.

What P1 still has to decide is the **capability wall** inside the tier ADR-0004 already accepted: which operations an admitted plugin may attempt, and which database role the broker uses when it runs that plugin's SQL. Without a closed grant set, "the plugin holds no connection" is only true of the honest plugin. Without a per-plugin role, a broker bug that runs the wrong statement still runs it as a role that can see every plugin schema.

The maintainer brief for draft B calls this wall capability sandboxing. In this record that phrase means the grant set and the schema role below. It does not mean an OS sandbox, a seccomp policy, or a second trust tier.

## Decision

1. **Grants are a closed vocabulary owned by the kernel.** A plugin manifest requests a subset. The operator approves that subset at install. The spawn-time capability credential carries the approved subset. Every port call checks the credential the supervisor stamped. A child-supplied grant bit is ignored. P2 enforces the stamp (ADR-0004). P1 stores the approved set and enforces it on every kernel port the kernel itself serves (Directory, settings, storage, secrets references, notify, outbox publish). Adding a grant name is an ADR.

   The P1 vocabulary is:

   | Grant | What it allows |
   |---|---|
   | `db.own_schema` | Broker runs this plugin's admitted SQL inside its schema role. Implied by a migrations directory. |
   | `events.publish:<type>` | Append that event type at a declared version. |
   | `events.subscribe:<type>` | One subscription filter for that type. |
   | `jobs.handle:<name>` | One job handler name in this plugin. |
   | `directory.read` | Directory port, still filtered by the caller's authorization. |
   | `directory.register_edge_type` | Insert an edge-type row. The type is data. The kernel schema does not change. |
   | `storage.prefix` | Objects under the prefix the broker derives from the plugin id. |
   | `notify.send` | Notification plumbing. Copy stays in the plugin. |
   | `secrets.use:<purpose>` | Broker resolves a reference at execution. The value is not returned to the plugin. |
   | `http.egress:<host>` | Operator allowlist entry, brokered. Absent means no external HTTP. |
   | `config.own` | Read and write this plugin's tenant settings keys. |
   | `audit.append` | Audit row in the same transaction as the mutation. |
   | `plane.installation` | Installation-operator actions (fan-out across tenant ids). Tenant admins cannot approve this grant. |

   `clock` is ambient. `ai.complete` is reserved for the P3 gateway and is not issued in P1.

2. **Each plugin has one PostgreSQL role.** Name `plerni_plugin_<id>`, with `<id>` restricted to the manifest id grammar in the design. The role is `NOSUPERUSER` `NOBYPASSRLS` `NOCREATEDB` `NOCREATEROLE`. It has `USAGE` on its schema and DML on its tables. It has no `CREATE`, no grants on any other plugin schema, and no `GRANT ALL`. The migration role remains a different role: `CREATE` on that schema only, used by the journal on an unpooled connection, never by request traffic (spec §4.6, ADR-0002 decision 6).

3. **The broker switches role inside the tenant transaction, after hygiene.** Order, on the one connection ADR-0002 pins: begin; hygiene inspect before any local override (plan §2 / ADR-0002 decision 2), which includes `current_user = session_user`; on a clean session, `set_config('plerni.tenant_id', …, true)` and read-back; then `SET LOCAL ROLE plerni_plugin_<id>`; then `set_config('search_path', '<schema>, pg_catalog', true)`. Only then run the plugin's statements. `SET LOCAL` lasts until the transaction ends, committed or not (PostgreSQL 18 `SET`). `SET ROLE` `LOCAL` follows that rule (PostgreSQL 18 `SET ROLE`). `session_user` stays the pooled app role, which is what the next transaction's hygiene check compares. A session-level `SET ROLE` still fails hygiene and still takes the ADR-0007 recovery.

4. **Admitted SQL is schema-qualified.** Every table reference in plugin SQL names `plugin_<id>`. Unqualified names fail admission. The search_path pin is defense in depth. Correctness does not depend on it. K17 in the design measures whether `SET LOCAL ROLE` emits a client-visible `search_path` that PgBouncer 1.26.0 replays. A replay is an ADR-0007 event: discard the pooler client session. It is not a reason to hand the plugin a connection.

5. **The kernel `Database` type stays kernel-only.** Plugin schemas stay outside `kysely-codegen` (ADR-0002 decision 5). The fixture package in the design is the proof: a second schema appears in PostgreSQL and in zero kernel source files.

6. **This wall is not the untrusted tier.** Same-UID file access, dumpable memory, and plugin-to-plugin tampering inside the runner user remain the residuals ADR-0004 decision 4 accepts. Grants stop a plugin from asking the broker for another plugin's tables or for an egress host it was not given. They do not stop a hostile process that never asks.

## Consequences

- Tenant enablement cannot widen grants. Only the operator install step can.
- A plugin that needs a new port adds a grant name by ADR, then a manifest line. It does not add a kernel conditional for that plugin id.
- Cross-plugin foreign keys stay forbidden. Identity references stay the declared read-only `REFERENCES` on `users(id, tenant_id)` for the migration role.
- Functions, triggers, and `DO` blocks stay forbidden. They are the indirect `set_config` path D08 closes.
- P2's admission parser is still the component that classifies arbitrary author SQL. Until that parser lands, the broker runs kernel SQL and in-repo fixture SQL reviewed in the same change. This record does not pull the parser forward.

## Flip conditions

- A measured `SET LOCAL ROLE` or schema-qualified execution that cannot be made safe on the PgBouncer transaction-mode pool, under the ADR-0002 hygiene protocol: stop and redesign the role switch. Do not give plugins connections (D07).
- Demand for untrusted third-party code, under ADR-0004's flip: build the deferred tier. Do not satisfy that demand by widening this grant list.
- A grant check that has to special-case a plugin id: the vocabulary is wrong. Fix the vocabulary by a new ADR, or move the behavior into the plugin.

## Sources

Retrieved 2026-11-01.

- PostgreSQL 18 [`SET`](https://www.postgresql.org/docs/18/sql-set.html): `SET LOCAL` lasts until the end of the current transaction, whether committed or not.
- PostgreSQL 18 [`SET ROLE`](https://www.postgresql.org/docs/18/sql-set-role.html): the `SESSION` and `LOCAL` modifiers act as they do for `SET`. Permission checks for `SET ROLE` use the current session user. `SET ROLE NONE` returns `current_user` to `session_user`.
- [ADR-0002](0002-orm-data-layer.md), [ADR-0004](0004-plugin-isolation-topology.md), [ADR-0007](0007-pooled-contamination-recovery.md), spec §4.4 and §4.6.
