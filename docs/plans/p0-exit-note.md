# P0 exit note

**Date:** 2026-10-28 · **Issue:** [#23](https://github.com/tachkovsa/plerni/issues/23) · **Task:** T15 in [`2026-10-13-p0-detailed-implementation-plan.md`](2026-10-13-p0-detailed-implementation-plan.md)

This note records the required-check proof, the six closed fixture pull requests, the spec §15 P0 checklist, and the issues for T1–T14. Fixture branches are deleted. None of the fixture pull requests were merged. The milestone stays open until every checklist row below has evidence.

## Required checks

`GET /repos/tachkovsa/plerni/branches/dev/protection` returned 403 (`Resource not accessible by integration`). The same contexts are on the public branch resource, read with:

```
gh api repos/tachkovsa/plerni/branches/dev --jq '.protection.required_status_checks.checks[].context'
```

```
secrets
private-markers
gates
sca / osv-scan
osv-scanner
approval-artifact
```

`commit-policy` runs on pull requests. It is absent from this list. License audit and kernel purity are steps inside the required `gates` job. Branch protection was not changed.

## Fixture pull requests

Each fixture followed the plan §7 safety rule: closed pull requests keep `refs/pull/N/head` world-readable, so the content is a random synthetic or a repo-tracked governed pattern. No maintainer-local pattern was used. Each diff stays outside `.github/workflows/`, `scripts/gates/`, and `tools/harness/sql/`, so none of them carried an approval artifact. Each pull request was closed unmerged and its branch was deleted before the next fixture opened.

### 1. secrets — required check `secrets`

[Pull request #75](https://github.com/tachkovsa/plerni/pull/75), head `7021eeec4f9983c76b3ccc733805ed1d95d0dea8`. Closed, not merged. Its branch was deleted immediately after close.

Failing step: `gitleaks history scan (pinned v8.30.1)` in [job 122593540329](https://github.com/tachkovsa/plerni/actions/runs/40620638992/job/122593540329). The earlier step `Run actions/checkout@v4` succeeded. The negative-proof step was skipped.

```
49 commits scanned.
scanned ~2658652 bytes (2.66 MB) in 544ms
WRN leaks found: 1
##[error]Process completed with exit code 1.
```

The step does not print a rule id. A local scan of that head with gitleaks v8.30.1 reported one finding: rule `generic-api-key`, file `docs/plans/t15-secrets-fixture.txt`. The allowlisted planted fixture was not in that report.

Green on that head: `private-markers`, `gates`, `sca / osv-scan`, `osv-scanner`, `approval-artifact`, `commit-policy`.

### 2. private-markers — required check `private-markers`

[Pull request #76](https://github.com/tachkovsa/plerni/pull/76), head `e0facb024918d588140bc10c6c3bf58f72930e49`. Closed, not merged. Branch deleted.

Failing step: `forbidden patterns in the repo` in [job 122594658835](https://github.com/tachkovsa/plerni/actions/runs/40620978878/job/122594658835). The earlier step `Run actions/checkout@v4` succeeded.

The step reported `private-markers: FAIL` for `docs/plans/t15-private-markers-fixture.md` with the governed label `machine-local macOS path`, then exited 1. The matched text is left in that job log and is not repeated here.

Green on that head: `secrets`, `gates`, `sca / osv-scan`, `osv-scanner`, `approval-artifact`, `commit-policy`.

### 3. license-audit — required check `gates`

[Pull request #77](https://github.com/tachkovsa/plerni/pull/77), head `e9e6d3c206bdac1c9789dcb8f1fc97cd6e73d57f`. Closed, not merged. Branch deleted.

The root workspace manifest gained `bezier-boolean@1.0.6` and `pnpm-lock.yaml` was regenerated. The registry record read on 2026-10-28 from `https://registry.npmjs.org/bezier-boolean/1.0.6` has license `GPL-3.0-only` and no runtime dependencies. The OSV query for that version returned no advisories.

Failing step: `Run node scripts/gates/license-audit.mjs` in [job 122595374085](https://github.com/tachkovsa/plerni/actions/runs/40621192770/job/122595374085). These earlier steps succeeded: checkout, pnpm setup, Node setup, `Run pnpm install --frozen-lockfile`, both brand steps.

```
license-audit: FAIL
  bezier-boolean: forbidden license "GPL-3.0-only"
##[error]Process completed with exit code 1.
```

Green on that head: `secrets`, `private-markers`, `sca / osv-scan`, `osv-scanner`, `approval-artifact`, `commit-policy`.

### 4. kernel-purity — required check `gates`

[Pull request #78](https://github.com/tachkovsa/plerni/pull/78), head `3f1cdaaf01277a8e62da86784739b654b416269e`. Closed, not merged. Branch deleted.

`apps/kernel/src/t15-fixture.ts` contains the governed noun `course` from `docs/gates/domain-nouns.txt`. That directory is absent on `dev`.

Failing step: `Run node scripts/gates/kernel-purity.mjs` in [job 122595869686](https://github.com/tachkovsa/plerni/actions/runs/40621347301/job/122595869686). `Run node scripts/gates/license-audit.mjs` and the install and brand steps before it succeeded.

```
kernel-purity: domain logic in kernel — forbidden (spec §3):
  apps/kernel/src/t15-fixture.ts: domain noun "course"
##[error]Process completed with exit code 1.
```

Green on that head: `secrets`, `private-markers`, `sca / osv-scan`, `osv-scanner`, `approval-artifact`, `commit-policy`.

### 5. commit-policy — check runs, and it is not required

[Pull request #79](https://github.com/tachkovsa/plerni/pull/79), head `07454379887a11f33fefbdfcfa8c35855b1eae2f`. Closed, not merged. Branch deleted.

The commit subject is `non conventional subject for the commit policy fixture`. It has no type prefix and no tool footer. The message ends with `AI-assisted: yes`.

Failing step: `commit policy` in [job 122596303753](https://github.com/tachkovsa/plerni/actions/runs/40621479474/job/122596303753). `check out the base revision` and `fetch pull request commits` succeeded.

```
commit-policy: FAIL
  0745437: non-conventional subject "non conventional subject for the commit policy fixture"
##[error]Process completed with exit code 1.
```

The six required checks on that head stayed green. This check going red does not, by the list above, block a merge.

### 6. sca — required check `sca / osv-scan`

[Pull request #80](https://github.com/tachkovsa/plerni/pull/80), head `f14b36aed680f929fb0403e813c3ab670086123b`. Closed, not merged. Branch deleted.

`docs/plans/t15-sca-fixture/package-lock.json` pins `lodash@4.17.20`. The integrity is the public registry value, the same value recorded in `scripts/gates/fixtures/sca/gen-vuln-lockfile.mjs`. `pnpm-lock.yaml` was not changed.

Failing step: `Run osv-scanner-reporter` in [job 122596841490](https://github.com/tachkovsa/plerni/actions/runs/40621644390/job/122596841490). Checkout, `Run scanner`, and `Check that the scan completed` succeeded. The scanner found 1 package in the fixture lockfile. The reporter printed:

```
Total 1 package affected by 5 known vulnerabilities (0 Critical, 2 High, 3 Medium, 0 Low, 0 Unknown) from 1 ecosystem.
| https://osv.dev/GHSA-35jh-r3h4-6jhm | 7.2 | npm | lodash | 4.17.20 | 4.17.21 | docs/plans/t15-sca-fixture/package-lock.json |
```

The in-repo generator cites GHSA-35jh-r3h4-6jhm as CVE-2021-23337. The same table also lists GHSA-29mw-wpgm-hmr9, GHSA-f23m-r3pf-42rh, GHSA-r5fr-rjxr-66jc, and GHSA-xxjr-mmjv-4gpg for that pin.

The other required check named `osv-scanner` stayed green. The check that failed is `sca / osv-scan`. Also green: `secrets`, `private-markers`, `gates`, `approval-artifact`, `commit-policy`.

## Spec §15 P0 checklist

Source: [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §15, P0 Foundations row.

### Contents

| Item | Evidence |
|---|---|
| Repository | [tachkovsa/plerni](https://github.com/tachkovsa/plerni), [`../../README.md`](../../README.md) |
| Apache-2.0 | [`../../LICENSE`](../../LICENSE) |
| DCO | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) (Legal). A `Signed-off-by` line is not required at the current stage, and commit-policy does not check for one. |
| CONTRIBUTING | [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) |
| SECURITY | [`../../SECURITY.md`](../../SECURITY.md) |
| Trademark | [Pull request #82](https://github.com/tachkovsa/plerni/pull/82) adds `TRADEMARKS.md` and links it from NOTICE and README. Merge is still pending. |
| Dependency policy | Spec §14 (bounded freshness). Mechanical checks: `scripts/gates/license-audit.mjs` and the `sca / osv-scan` job in [`.github/workflows/p0-gates.yml`](../../.github/workflows/p0-gates.yml). |
| Contract conventions | [`../specs/contract-conventions.md`](../specs/contract-conventions.md), accepted at P0. Issue [#20](https://github.com/tachkovsa/plerni/issues/20). |
| ADR-0001 | [`../adr/0001-kernel-and-equal-citizen-plugins.md`](../adr/0001-kernel-and-equal-citizen-plugins.md), Accepted |
| ADR-0002 | [`../adr/0002-orm-data-layer.md`](../adr/0002-orm-data-layer.md), Accepted. Issue [#16](https://github.com/tachkovsa/plerni/issues/16). |
| ADR-0003 | [`../adr/0003-outbox-pgboss.md`](../adr/0003-outbox-pgboss.md), Accepted. Issue [#17](https://github.com/tachkovsa/plerni/issues/17). |
| ADR-0004 | [`../adr/0004-plugin-isolation-topology.md`](../adr/0004-plugin-isolation-topology.md), Accepted. Issue [#18](https://github.com/tachkovsa/plerni/issues/18). |
| ADR-0005 | [`../adr/0005-ui-kit-token-compiler.md`](../adr/0005-ui-kit-token-compiler.md), Accepted. Issue [#19](https://github.com/tachkovsa/plerni/issues/19). |
| Spike A (DB invariant, typecheck) | [`2026-10-18-spike-a-report.md`](2026-10-18-spike-a-report.md). A1 direct PASS, A1 pooled PASS, A2 PASS, A3 PASS, A4 PASS on unnamed discipline (A4b stays open, issue [#34](https://github.com/tachkovsa/plerni/issues/34)), A5 PASS at the acceptance point, battery PASS. |
| Spike B (IPC harness) | [`2026-10-18-spike-b-report.md`](2026-10-18-spike-b-report.md). B1 PASS, B2 sequential PASS, B2 concurrent PASS, B3 FAIL (partial cap and total buffer), B4 PASS, B5 PASS, B6 PASS, races PASS. The B3 FAIL leaves the replacement-validation track open. |
| Contributor roadmap | [`../ROADMAP.md`](../ROADMAP.md). Issue [#15](https://github.com/tachkovsa/plerni/issues/15). |

### Exit criteria

| Criterion | Evidence | Row |
|---|---|---|
| Each P0 gate blocks its deliberately bad fixture pull request | Secrets, private-markers, license-audit, kernel-purity, and SCA failed a required check, at the steps quoted above. The commit-policy check failed at `commit policy` and is not in the required-check list, so that failure does not block merge. | Five required gates have blocking evidence. commit-policy has a red check and no required-check evidence. |
| Spike reports filed with pass/fail verdicts | The two reports linked above. | Filed, including the B3 FAIL and the open A4b item. |
| Contributor roadmap published | [`../ROADMAP.md`](../ROADMAP.md) | Published. No dates. |
| Protected set stays intact (contract layer, tenancy floor, blocking CI core) | Contract conventions are accepted at P0. Spike A A2 is PASS for tenant isolation on the direct and pooled datasources. The blocking CI core is the required-check list in this note. | Present as recorded. Product tenancy is still P1; `apps/kernel/src` is absent on `dev`. |
| No nine-month arithmetic bar | Issue [#15](https://github.com/tachkovsa/plerni/issues/15) withdrew the capacity annex. [`../ROADMAP.md`](../ROADMAP.md) states there is no delivery deadline. The amendment at the top of the detailed plan records the same withdrawal. | Withdrawn. The bar is not in force. |

## Issues for T1–T14

Spike work was split across more than one issue. Each issue below is the closed task that landed that part of the plan.

| Task | Issue |
|---|---|
| T1 P0 implementation plan | [#4](https://github.com/tachkovsa/plerni/issues/4) |
| T2 dev harness | [#5](https://github.com/tachkovsa/plerni/issues/5) |
| T3a DB invariant, client and A1–A2 | [#6](https://github.com/tachkovsa/plerni/issues/6) |
| T3b DB invariant, A3–A4 and the battery | [#7](https://github.com/tachkovsa/plerni/issues/7) |
| T4a-0 bench-dispatch workflow | [#8](https://github.com/tachkovsa/plerni/issues/8) |
| T4a typecheck benchmark, acceptance band | [#9](https://github.com/tachkovsa/plerni/issues/9) |
| T4a typecheck benchmark, stress bands and drift | [#10](https://github.com/tachkovsa/plerni/issues/10) |
| T5 IPC harness, framing | [#11](https://github.com/tachkovsa/plerni/issues/11) |
| T5 IPC harness, supervisor and B1–B6 | [#12](https://github.com/tachkovsa/plerni/issues/12) |
| T5 IPC harness, race battery | [#13](https://github.com/tachkovsa/plerni/issues/13) |
| T6 spike verdict reports | [#14](https://github.com/tachkovsa/plerni/issues/14) |
| T7 contributor roadmap | [#15](https://github.com/tachkovsa/plerni/issues/15) |
| T8 ADR-0002 | [#16](https://github.com/tachkovsa/plerni/issues/16) |
| T9 ADR-0003 | [#17](https://github.com/tachkovsa/plerni/issues/17) |
| T10 ADR-0004 | [#18](https://github.com/tachkovsa/plerni/issues/18) |
| T11 ADR-0005 | [#19](https://github.com/tachkovsa/plerni/issues/19) |
| T12 contract conventions | [#20](https://github.com/tachkovsa/plerni/issues/20) |
| T13 secrets-gate negative check | [#21](https://github.com/tachkovsa/plerni/issues/21) |
| T14 SCA fixture | [#22](https://github.com/tachkovsa/plerni/issues/22) |
| T15 this note | [#23](https://github.com/tachkovsa/plerni/issues/23) |
