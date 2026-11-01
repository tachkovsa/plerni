# ADR-0012 — Adding a plugin leaves the kernel tree unchanged

- **Status:** Proposed · **Date:** 2026-11-01
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §1 invariant 1 (equal citizenship), §3 (kernel purity), §4.8 (plugins meet through contracts)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D01**
- **Design:** [`../plans/p1-kernel-design-b.md`](../plans/p1-kernel-design-b.md) §1.3, tasks K28–K30
- **Number:** Next integer after 0011.

## Context

The kernel-purity gate fails a governed noun under `apps/kernel/src`. That does not by itself prove that adding a plugin left the kernel alone. A plugin PR can still edit the kernel to special-case an id, widen a grant, or import a plugin module, and stay noun-clean if the id is not on the noun list.

P1 needs a mechanical proof with neutral packages, before any learning plugin exists. The packages carry no product behavior. They exist so the empty-diff check has something to diff.

## Decision

1. **Three fixture packages, neutral ids.** `fixture_publisher` publishes `fixture_publisher.note.recorded`. `fixture_subscriber` requires that contract. `fixture_optional` names the same contract under `optionalRequires` and has a default when the port is absent. Tables are `note` and `label`. None of the ids are governed nouns.
2. **The host lands first.** The commit that adds the journal, the grant check, and the loader may touch `apps/kernel/`. Each fixture package is a later commit whose path set is `plugins/<id>/` plus tests that live beside the plugin.
3. **Each fixture commit is compared with its parent.** The command is `git diff --exit-code <fixture>^ <fixture> -- apps/kernel`, where `<fixture>` is that commit. Exit 0 is the pass. A work-tree `git diff` with no revisions is not this proof: that form compares the work tree with the index. `node scripts/gates/kernel-purity.mjs` exits 0 on `<fixture>`. An import check fails if `apps/kernel/src` imports `plugins/`, and fails if a plugin imports another plugin except through that plugin's public contract module. `fixture_subscriber` imports only `fixture_publisher`'s contract module.
4. **The same command must be able to fail.** Each of K28, K29, and K30 builds a scratch commit whose parent is `<fixture>^` and whose only added change is a file under `apps/kernel`. `git diff --exit-code <scratch>^ <scratch> -- apps/kernel` exits non-zero. The scratch commit is not pushed. A fixture task that does not run this negative case has not shown the check works.
5. **A non-empty kernel diff on a real fixture commit is a failed task.** The missing primitive is an ADR, not an edit slipped into the fixture. Domain plugins later meet the same parent-to-commit check. P1 does not implement those domain plugins.

## Consequences

- K28, K29, and K30 are the P1 tasks. Each runs `git diff --exit-code <fixture>^ <fixture> -- apps/kernel` and the scratch-commit negative case. K17 still proves the schema role and the codegen boundary. These three prove the tree boundary.
- The optional package's call returns `UNAVAILABLE` with reason `dependency_disabled` when the publisher is not enabled for that tenant, and the caller keeps its declared default.

## Flip conditions

- A host primitive that every plugin needs and that these fixtures cannot exercise is a new ADR before any domain plugin. It is not a reason to drop the empty-diff check.
- The check does not flip to "small kernel edits are fine."
