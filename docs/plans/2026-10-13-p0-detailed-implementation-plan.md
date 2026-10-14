# P0 Detailed Implementation Plan v7 — executable task specs

**Status:** v7 — final; incorporates γ's disposition check on v6 (2 MAJOR + 5 MINOR, all one-clause edits, applied verbatim). Chain complete per γ: this pass + the maintainer's sign-off. · **Date:** 2026-10-13
**Source of truth:** the P0 plan — **after T1 merges it lives at `docs/plans/2026-10-13-p0-implementation-plan.md`** (v12 content). Every task cites it as **"the plan §X"**. Where documents disagree, the plan wins — report the conflict, don't improvise.

**Audience contract (binding):** every task states Goal · Read-first · Exact files · Steps · Acceptance (commands + expected observations) · NOT-list · Risk class · PR split. An executor without conversational context must be able to finish the task. Contradiction with a referenced doc → STOP and file a question.

**Global rules for every task:**
1. Branch off `dev`. Commit subjects: type from the commit-policy allowlist **exactly** — `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert` (spike work uses `test(spike): …`). The PR title becomes the squash subject and obeys the same rule; the PR body IS the squash message (ends with `AI-assisted: yes` as the last line). **DCO sign-off is the human maintainer's act and the commit-policy gate checks every commit in the PR range *before* merge** (β-B1, reproduced): the executor prepares the branch; before marking readiness, the maintainer signs the offered commits (`git rebase origin/dev --signoff` + force-push by the maintainer, preserving contributor attribution — `origin/dev`, not the possibly-stale local `dev`, δ-N7). **Every pushed commit needs the sign-off, including temporary proof commits (T13/T14) and T15's fixture commits** — an unsigned temporary commit fails commit-policy before the new steps run, so the expected diagnostic never appears (δ-N2). Unsigned commits cannot go green — there is no squash-time shortcut. **The PR body (= the squash message) carries the maintainer's `Signed-off-by` line directly above the final `AI-assisted: yes`** (γ-E: the post-merge push run checks the squash commit via commit-policy; an unsigned squash message turns `dev` red after every merge — GitHub's web sign-off only covers web-UI commits, not API merges).
2. `pnpm install && pnpm run gates` green locally before pushing. Local gates cover license-audit, kernel-purity, private-markers, commit-policy, gate-health — **not** secrets/SCA (CI-only); touch a scanner-sensitive path → verify CI on the PR before claiming green. **Scoped exception (β-M10):** T15's six designated negative-fixture PRs are exempt *by construction* — the executor observes the expected target failure (failing step + diagnostic) and the unaffected checks' green, records both in the PR, closes unmerged. The exception covers only T15's six PRs.
3. Never disable/skip/weaken a gate. A gate blocking correct work is a bug — file it (principle 20).
4. No secrets or tool/model identities in tracked files, commits, or PR bodies (AGENTS.md §0). Fixture secrets: **random synthetics** (gitleaks stopwords ignore canonical example values). Pattern: `scripts/gates/fixtures/gitleaks/secret.txt`.
5. PR budget (CONTRIBUTING.md): ≤400 handwritten changed lines; >800 requires a maintainer-approved explanation in the PR.
6. Versions pinned as written (verified against live sources 2026-10-13/14). No upgrades while implementing.
7. `.mjs` for zero-build scripts; `.ts` for typed spike code (Node 22 type stripping: imports use `.ts` specifiers; spike package.json sets `"type": "module"`; tsconfig sets `allowImportingTsExtensions` **and** `noEmit: true` — required combination under `NodeNext` + `verbatimModuleSyntax`, β-M4). New `package.json` files: `"private": true`.
8. Review receipts: the revision-bound receipt lives in the **PR record** (PR body = the future squash message), written against the branch's final head after all content lands (β-B2: a committed receipt file cannot bind its own head — committing it changes HEAD). **Order is binding (δ-N1):** the executor writes the receipt into the PR body *first*; only then does the maintainer enable auto-merge (editing a PR body does not re-run checks — auto-merge enabled earlier would fire without the receipt, and the squash message would lack it). The executor opens PRs; the maintainer enables auto-merge after review, last.

---

## T1 · `docs: P0 implementation plan` (risk: low · one PR)

**Goal:** land the accepted plan + review receipt + the approval-key genesis (plan §8: `maintainer.pub` exists from this PR on, before any gate-config PR).
**Read first:** the plan (working draft path in the session handoff) · `docs/ai/model-routing.md` · `.github/PULL_REQUEST_TEMPLATE.md` · CONTRIBUTING.md.
**Files:** `docs/plans/2026-10-13-p0-implementation-plan.md` (plan v12, byte-identical) · `docs/plans/p0-plan-review-receipt.md` · `docs/plans/README.md` · `scripts/gates/approvals/maintainer.pub` (the maintainer's signing public key — **committed by the maintainer personally**, the executor only leaves the path ready).
**Steps:**
1. `git checkout -b docs/p0-implementation-plan`.
2. Copy the plan **verbatim**; `shasum -a 256` on the target must equal the reviewed working-draft SHA from the session handoff. Any byte change invalidates the review chain.
3. Write `docs/plans/p0-plan-review-receipt.md` as the **committed review-chain document**: the full trail (β rounds 1–7 → ACCEPT on v7 · δ blind pass + regression catch → v8 · γ passes on v8–v11 → v12) · evidence ID `REV-P0-PLAN-2026-10-13` · family-separation assertions per plan §9 (incl.: β/γ/δ all have adopted text in the §5 method → the annex's reviewer is the human maintainer; the γ-originated fix lines in the plan are covered by **the maintainer's human genesis receipt on this PR** — δ-N8: no agent pass covers them, and naming one would be untrue) · **and a pointer to the revision-bound receipt in the PR body** (the plan §9 receipt binds the git head SHA; it cannot live in the branch — committing it would change HEAD, β-B2).
4. The maintainer adds `scripts/gates/approvals/maintainer.pub` personally (genesis — carries the maintainer's **human review receipt**, role `human`; an agent receipt with sponsorship is insufficient here, β-B2), **signs the branch's commits** (`git rebase origin/dev --signoff` + force-push — commit-policy checks every commit in the PR range before merge; unsigned commits cannot go green, β-B1), and reviews.
5. **Then** the executor writes the final revision-bound receipt into the PR body against the final head SHA, **the maintainer approves the receipt text** (γ-D: an attestation must not be machine-drafted unchecked — the maintainer's approval is an explicit act), and **only then** the maintainer enables auto-merge (δ-N1: body edits don't re-run checks; auto-merge enabled earlier fires without the receipt).
**Acceptance:** PR merges green; SHA check pasted; receipt-chain document + PR-body receipt both present; `maintainer.pub` on `dev` after merge.
**NOT:** no plan edits; no executor-added sign-off; no self-enabled auto-merge; no ADR renames; no committed receipt claiming to bind its own head.

## T2 · `chore: dev harness` (risk: high — CI/infra; receipt required · one PR)

**Goal:** the compose substrate both spikes run against, incl. the fencing-authority table (owned here — T5 consumes, never recreates).
**Read first:** the plan §2 (all); spec §4.6, §5.
**Files:**
```
tools/harness/
  docker-compose.yml
  pgbouncer/pgbouncer.ini
  sql/001_roles.sql              # roles + membership fixture + pinned search_path default
  sql/002_tenant_fixture.sql     # plerni_tenant + ENABLE + FORCE RLS + exactly one canonical policy
  sql/003_fencing_authority.sql  # status QUEUED|ACTIVE|COMMITTED|CANCELLED|ABANDONED, heartbeat_at, created_at + grants
  seed.mjs
  render-secrets.mjs
  reset.sh
  package.json                   # private; deps: pg@8.23.1
  README.md
pnpm-workspace.yaml             # EDIT: add "tools/spikes/*" glob here (T2 precedes both spikes — δ-N6; PR body notes the license-audit scope change)
pnpm-lock.yaml                   # EDIT — tools/harness is already a workspace member (tools/* glob); the lockfile must update
.gitignore                       # EDIT — add tools/harness/pgbouncer/userlist.txt
```
**Steps:**
1. `docker-compose.yml`: `postgres` (image `postgres:18`, digest-pinned at implementation time, digest recorded in README) + `pgbouncer` (image `edoburu/pgbouncer:v1.26.0-p0`, digest-pinned). Healthchecks both. Ports `5432` (direct), `6432` (PgBouncer). `POSTGRES_PASSWORD` passes from env (`${POSTGRES_PASSWORD:?unset}`) — no literal. No Valkey/S3.
2. `pgbouncer.ini`: `[databases]` mapping (`plerni = host=postgres …`, and the console is dbname `pgbouncer`); `pool_mode = transaction`; `max_prepared_statements = 0`; `auth_type = scram-sha-256`; `auth_file = /etc/pgbouncer/userlist.txt`; **`default_pool_size = 10` pinned** (T5c's saturated-pool case keys on it); **`stats_users = plerni_admin_ro`** (read-only console — `admin_users` would grant PAUSE/SHUTDOWN; the plan promises read-only). Comment every non-default line.
3. **Credentials (all named, env-only):** `POSTGRES_PASSWORD` (compose superuser; also reset.sh's admin credential and the `ALTER ROLE` injection path in T3b), `PLERNI_APP_PASSWORD`, `PLERNI_MIGRATE_PASSWORD`, `PLERNI_ADMIN_PASSWORD`. `render-secrets.mjs` → gitignored `userlist.txt`; unset var → non-zero exit naming it.
4. `sql/001_roles.sql`: `plerni_app` (NOBYPASSRLS, LOGIN) · `plerni_migrate` · `plerni_admin_ro`; passwords via psql `-v`; **plus** `ALTER ROLE plerni_app SET search_path TO <fixture schema>` (the pinned value T3a's protocol asserts — plan §2/γ-N3) **plus** a membership fixture: role `plerni_plugin_a` with `GRANT plerni_plugin_a TO plerni_app` (enables T3b's SET ROLE injection — without membership the injection can't be built and an executor would grant something broad, δ-M5).
5. `sql/002_tenant_fixture.sql`: as before (one canonical policy on `current_setting('plerni.tenant_id', true)`; grants to `plerni_app` SELECT/INSERT/UPDATE/DELETE only).
6. `sql/003_fencing_authority.sql`: five-state status enum, `heartbeat_at`, `created_at`; **grants**: `plerni_app` gets SELECT/INSERT/UPDATE on it (the spike's executor and sweeper act as this role). Comment: harness-owned; spikes consume, never redefine.
7. `reset.sh`: render-secrets → compose up → wait healthy → create `plerni` DB → apply sql/001–003 via the superuser credential from env. Idempotent, fail-loud.
8. `seed.mjs`: tenants A/B, overlapping `label`, prints counts.
9. README: quickstart; three connection strings; heartbeat-traffic note (renewals use a **dedicated direct connection on 5432**, never the main pooled datasource — plan §4 B2); honesty note on topology relaxation (spec §4.4). PR body notes the license-audit scope change (workspace member added).
**Acceptance (paste outputs):**
- `docker compose -f tools/harness/docker-compose.yml config --no-interpolate` renders (never paste interpolated output — that would publish the credential, §0); `up -d` → both healthy ≤60 s.
- `psql` via 5432 and 6432 → `select 1` answers.
- `psql "… port=6432 dbname=pgbouncer user=plerni_admin_ro" -c 'SHOW CONFIG'` → rows (read-only console via stats_users).
- `./reset.sh && node seed.mjs` → 2 tenants; no context → `select count(*) from plerni_tenant` = `0`; with `SET plerni.tenant_id='<A>'` → only A's rows.
- `\d fencing_authority` → five-state constraint; `SELECT rolname FROM pg_roles WHERE rolname LIKE 'plerni%'` → 4 roles incl. `plerni_plugin_a`.
- `pnpm install --frozen-lockfile` green (lockfile updated); `git status` → userlist.txt ignored.
**NOT:** no extra services; no committed passwords anywhere; do not enable named-statement tracking (`max_prepared_statements > 0`) in the baseline harness — the pinned `= 0` from step 2 stands until Spike A measures otherwise; no other tables (product schema is not P0).
**Approval coverage (β-M3):** this task introduces SQL schema fixtures — **if T13's verifier has already merged, this PR carries a signed artifact per T13 step 4** (its `sql/` diff is in verifier scope); **otherwise** the maintainer's approval is recorded manually as a human receipt in the PR body (scope: the `sql/` diff), and the mechanical rule applies to later changes (γ-A: the two tasks share a wave; this clause covers both orderings).

## T3a · `test(spike): DB invariant — client, hygiene protocol, A1–A2` (risk: high — tenancy; receipt required)

**Goal:** Kysely client factory + ordered hygiene protocol + cases A1–A2 (plan §3). Depends on T2.
**Read first:** the plan §2 (protocol), §3.0, §3.1 A1–A2, §3.2 items 1–2.
**Files:**
```
tools/spikes/db-invariant/
  package.json                  # private; name: "@plerni-spike/db-invariant"; "type": "module"; deps: pg@8.23.1, kysely@0.29.6; devDeps: typescript@5.9.3; scripts: "typecheck": "tsc --noEmit", "spike": "node src/run.ts"
  tsconfig.json                 # extends ../../../tsconfig.base.json; adds "allowImportingTsExtensions": true AND "noEmit": true (required combination under the base's NodeNext + verbatimModuleSyntax — without it conventional ESM .ts fails with TS1287, β-M4)
  src/client.ts                 # THREE datasources: direct (5432), pooled (6432/plerni), pgbouncer-admin (6432/pgbouncer, read-only SHOW)
  src/context.ts                # ordered hygiene protocol, verbatim from plan §2
  src/evidence.ts               # JSONL evidence writer
  src/cases/a1-pinning.ts
  src/cases/a2-oracle.ts
  src/run.ts
```
`pnpm-lock.yaml` # EDIT — follows the manifest (a new importer without a lockfile entry fails CI's `--frozen-lockfile`; γ MAJOR-1 — this edit belongs here even though the workspace glob is T2's)
**Steps:**
1. The workspace glob arrived with T2 — verify `node -e "require('kysely')"` resolves in the spike dir after `pnpm install`; `pnpm --filter @plerni-spike/db-invariant typecheck` runs. (If T2 hasn't merged yet, this task waits — the glob has one owner, T2.)
2. `context.ts` per plan §2 verbatim: ① BEGIN ② inspect **before any local override**: named `plerni.*` GUCs via `current_setting(name, true)` (normalize `''` as absent) **plus** `current_user = session_user` **plus** `search_path` equals the pinned value (installed as the app role's default by T2's 001_roles.sql) ③ contamination → `SELECT pg_terminate_backend(pg_backend_pid())` + security-alert evidence line + bounded retry ≤2 on a fresh connection, then loud failure ④ clean → `set_config('plerni.tenant_id', v, true)` + readback equals the authorized tenant ⑤ tenant access. Doc-comment quotes plan §2.
3. `a1-pinning.ts`: `pg_backend_pid()` constant across ≥3 statements under concurrent load; raw-`pg` control identical; both main datasources.
4. `a2-oracle.ts`: (a) clean-deny → zero rows + guard raises; (b) positive control: tenant-B reads exactly B's rows; (c) contaminated reuse → normalized absence + zero rows for a context-less follow-up. Both main datasources.
5. Vacuity control: a context variant skipping step ④ must FAIL A2 (both outcomes in evidence).
**Acceptance:** `pnpm --filter @plerni-spike/db-invariant spike` prints per-case PASS/FAIL × both datasources with evidence JSONL; vacuity fails as designed; outputs pasted.
**NOT:** no A3/A4 here; no schema beyond T2's; no named prepared statements; never weaken an oracle to pass — FAIL is valid (feeds §3.0).

## T3b · `test(spike): DB invariant — A3, A4, adversarial battery` (risk: high — tenancy; receipt required)

**Goal:** A3 + A4 + the battery. Depends on T3a.
**Read first:** the plan §3.0–3.2 (all); T3a's merged code.
**Files:** `tools/spikes/db-invariant/src/cases/{a3-pgbouncer.ts, a4-protocol.ts}` · `src/battery/{pool-abort.ts, interleave.ts, contaminated-session.ts, guc-forgery.ts}` · **`src/run.ts` (EDIT: register the new cases in the runner — authorized and required; unregistered files are unexecuted evidence, β-M5)**.
**Steps:**
1. `a3-pgbouncer.ts`: A1+A2 green pooled incl. mid-transaction error → rollback → context absent. Contamination lifecycle: (i) detection inside the pinned transaction on the executing backend, (ii) termination evicts the backend (`pg_stat_activity` shows the pid gone), (iii) A2(c) absence check on the replacement session, (iv) positive controls pass after recovery, (v) termination+retry ≤ bounded budget (≤2). Cleanup cost recorded.
2. `a4-protocol.ts`: driver instrumentation asserts every outbound statement name is empty (wrap `pg`'s query path — never `pg_prepared_statements` sampling); benchmark unnamed extended-protocol vs named on DIRECT; overhead % recorded. **A4b (plan §3.1):** overhead >20% opens follow-on `test(spike): A4b named-statement branch` — runs with `max_prepared_statements > 0` and reruns A1–A3 under that config; issue filed with measured numbers, linked in the report.
3. Battery: `pool-abort` · `interleave` (pool size 1, positive controls both ways) · `contaminated-session` (injected variants: tenant GUC, **`SET ROLE`** (works via T2's membership fixture), **`search_path`**, first-use connections, `ALTER ROLE … SET` default injection via the superuser credential; cleanup cost measured; **assert terminations == injected contaminations**) · `guc-forgery` ((a) smuggled `set_config` rejected by a **prototype** allowlist classifier — labeled prototype evidence scoped to "classifier shape"; phase attribution per plan §3.2.4: admission-parser machinery P2, tenancy-gate GUC-forgery suite §12/P1, §16.13 acceptance P3; (b) plugin SQL never executes raw; (c) hostile session-level SET harmless given the protocol; document that session-GUC denial is NOT available as a mechanism).
4. Every failure → §3.0: raw-`pg` control, effective-config evidence via the **admin-console datasource** (`SHOW CONFIG/DATABASES/USERS` tied to the tested endpoint/db/role), ≥3 runs, environmental-noise outcome allowed.
**Acceptance:** A3/A4 PASS/FAIL with evidence; battery results; A4b issue filed iff overhead >20%; all FAILs carry §3.0 diagnosis records.
**NOT:** no verdict-labeling without diagnosis; no T3a file changes except noted bug fixes.

## T4a · `test(spike): typecheck benchmark — generators + acceptance band` (risk: **high** — applies generated migrations / live schema changes; model-routing migration rule, β-M3 · receipt required · one PR)

**Goal:** schema/corpus generators + acceptance-band measurement (plan §3.1 A5). Depends on T3a.
**Read first:** the plan §3.1 A5 (bands 50/75/200/400 — **N counts ALL tables in the band including the Annex L statement table** (β-m11: a "75-table" band measures exactly 75, not 76); harness fixture tables (`plerni_tenant`, `fencing_authority`) live in a separate DB and are excluded — stated in the report); allocation S=3N, M=⌊1.5N⌋, L=5N−S−M; shapes; floors M≥20/L≥10; acceptance point 75/375, ceiling 4 GB RSS/120 s on the CI runner class; stress bands 200/400; escape-hatch ban); Annex L (owner: this generator).
**Files:** `tools/spikes/db-invariant/bench/{gen-schema.mjs, gen-corpus.mjs, corpus-lint.mjs, measure.mjs, README.md}` · `bench/.artifacts/band-<N>/{schema.sql, database-types.ts}` (committed) · `tools/spikes/db-invariant/package.json` (EDIT: devDep `kysely-codegen@0.20.0`) · `pnpm-lock.yaml` (EDIT — follows the manifest, β-M5). **The benchmark workflow is NOT in this PR** (δ-N3): `.github/workflows/bench-dispatch.yml` lands first in a separate `ci:` precursor PR (a `workflow_dispatch` skeleton with a trivial step) — a dispatch workflow can't be triggered from the PR that creates it.
**Steps:**
0. Precursor: `ci: add bench-dispatch workflow skeleton` — small PR, `workflow_dispatch` only, carries a signed approval artifact per T13 step 4 (workflows are in verifier scope — δ-N4). Maintainer reviews + signs + merges. (If T13's verifier isn't merged yet, the interim rule applies: human receipt in the PR body.)
1. `gen-schema.mjs N` emits SQL for N tables **including the Annex L `plugin_lrs_statement` table** (JSONB payload 0.5–4 KiB class, tenant_id, append-only), applies to a dedicated per-band database `spike_bench_<N>` (isolation + reset between bands, β-M6), runs `kysely-codegen`, writes committed artifacts. Bands: 50, 75, 200, 400.
2. `gen-corpus.mjs N` emits the corpus per the integer rule + shapes + a raw-`sql` baseline; M/L include queries against the Annex L table; **every generated query carries a compile-time assertion of its inferred row type** (`Expect<Equal<…>>`).
3. `corpus-lint.mjs` — **AST-based** (TypeScript compiler API; a regex banning `as` would break Kysely's legitimate `.as('x')` idiom): rejects `sql` fragments (except `set_config`), `as`/`any` type assertions, explicit result generics, `$castTo`, `$narrowType`, `$assertType`. Runs before any timing.
4. `bench-dispatch.yml` (from the precursor) gains its real steps in this PR: hosted `ubuntu-latest`; install; harness compose up; `measure.mjs` per band; evidence uploaded as workflow artifacts. Per-band compiler invocation and corpus/baseline commands are named in `bench/README.md`. **This PR carries a signed approval artifact** (it edits a workflow file — verifier scope, δ-N4).
5. `measure.mjs`: `tsc --noEmit` wall + **peak RSS via `/usr/bin/time -v`** (`--extendedDiagnostics` reports heap, not RSS — δ-M6), 3 repetitions, environment recorded; pre-flight resource check; invalid run → rerun.
6. Trigger the dispatch workflow against the branch (`gh workflow run bench-dispatch.yml --ref <branch>` — works because the skeleton is already on `dev`); paste the run link + numbers.
**Acceptance:** band-75 numbers vs the ceiling (corpus AND baseline) **from the CI dispatch run**; generator outputs verified at all four bands; corpus-lint rejects a deliberately escaped sample; committed artifacts present; approval artifact valid per the verifier.
**Approval coverage:** live schema changes via generated migrations + workflow edit — high-risk route per model-routing.md; receipt required; signed artifact per T13 step 4 (or the interim human receipt if T13 hasn't merged).
**NOT:** no single-band cherry-pick; no laptop numbers as the bar evidence; Annex L table not optional; no dispatch workflow created and triggered in the same PR.

## T4b · `test(spike): typecheck benchmark — stress bands + drift fixtures` (risk: **high** — live schema changes via drift fixtures, β-M3 · receipt required · one PR)

**Goal:** full curve + drift gate. Depends on T4a.
**Read first:** the plan §3.1 A5 (stress points → §3.0 diagnosis, never auto-fallback) + the R1#5 drift gate.
**Files:** `tools/spikes/db-invariant/bench/drift-gate.sh` · `bench/drift-fixtures/{rename-unused-column.sh, stale-after-sql-change.sh}` · `tools/spikes/db-invariant/package.json` (EDIT: add script `bench:drift-gate`, β-M5) · spike-report skeleton section.
**Steps:** 1. `measure.mjs` at 50/200/400 via the same dispatch workflow (T4a) → curve table. 2. `drift-gate.sh` = regenerate against the live migrated per-band DB + `git diff --exit-code` on the committed per-band interface; package script `bench:drift-gate` (no required-check wiring — noted in PR). 3. Drift fixtures proven both ways ((a) rename unused column → gate fails; (b) SQL change without regeneration → gate fails on stale committed output); paste both runs. 4. A5 report skeleton section.
**Acceptance:** curve complete at four bands; both drift fixtures fail closed; stress overruns (if any) carry §3.0 diagnosis records.
**NOT:** no ergonomics verdict from stress bands alone — the ceiling binds the 75/375 acceptance point only.

## T5a · `test(spike): IPC harness — framing + authority + echo child` (risk: high — plugin isolation; receipt required)

**Goal:** the framed transport + PG-backed authority state machine. Depends on T2.
**Read first:** the plan §4 B2 (five-state machine incl. QUEUED; heartbeat/lease with reserved-capacity path; shutdown ordering), §2 (authority schema via T2); spec §4.4.
**Files:**
```
tools/spikes/ipc-harness/
  package.json               # private; name "@plerni-spike/ipc-harness"; deps: pg@8.23.1; scripts: "spike": "node src/run.mjs", "test": "node --test src/framing.test.mjs"
  src/framing.mjs            # two framings, kept separate: newline-delimited NDJSON for child stdio; length-prefixed frames for the mux bridge
  src/framing.test.mjs       # the property tests (seeded PRNG, no new dependency)
  src/authority.mjs          # QUEUED→ACTIVE→COMMITTED|CANCELLED|ABANDONED + heartbeat (reserved path) + sweeper + shutdown ordering
  src/children/echo.mjs
  src/cases/smoke.mjs
  src/run.mjs
```
(and `pnpm-lock.yaml` — EDIT, follows the manifest; the workspace glob itself is T2's, δ-N6)
**Steps:**
1. `framing.mjs` first — **two distinct codecs, never conflated** (δ-m4): NDJSON-over-stdio (child link; the never-terminated-frame case lives here) and length-prefixed mux frames (bridge). Property tests use a **seeded PRNG** (hand-rolled, no new dependency): arbitrary byte streams never corrupt frames; oversize (>1 MiB), incremental-oversize, never-terminated, malformed → typed errors; per-connection partial-frame buffer cap enforced. No per-frame checksum (not in the plan — no new scope).
2. `authority.mjs` verbatim per plan B2: QUEUED at submission (sweeper never touches); `QUEUED→ACTIVE` stamps `heartbeat_at`; conditional transitions (`WHERE id=:x AND status='ACTIVE'`); renewal on the **reserved path** (dedicated direct connection on 5432); cadence **5 s** and lease **20 s** pinned for the spike (lease ≥ 3× cadence + scheduling delay — plan B2); sweeper `ACTIVE→ABANDONED` on expired lease; terminal retention; **shutdown: stop renewal scheduling immediately before issuing the conditional COMMITTED update → resolve the effects transaction → drain renewals** (bound and record last-renewal→row-lock interval).
3. `echo.mjs` + `smoke.mjs`: round-trip over stdio framing; authority transitions on harness PG.
**Acceptance:** property tests + smoke pass with evidence JSONL.
**NOT:** no IPC library; no TLS; no other children; no heartbeats inside the effects transaction; no unrequested features (checksums etc.).

## T5b · `test(spike): IPC harness — supervisor, mux bridge, adversarial children, B1–B6` (risk: high; receipt required)

**Goal:** supervisor + multiplexed kernel-stub channel + the case battery. Depends on T5a.
**Read first:** the plan §4 (B1–B6 incl. numbers: B1 ≥5,000 round-trip/s, 1 KiB, p99 ≤10 ms; B3 per-queue caps + RSS ≤64 MiB over ≥60 s; B6 flood bound: sibling cancel p99 ≤500 ms; measurement contract: open-loop, warm-up ≥5 s, window ≥60 s, ≥3 reps, pre-flight resource check, invalid-run outcome).
**Files:** `src/supervisor.mjs` · `src/kernel-stub.mjs` · `src/children/{ignore-cancel,flood,malformed,never-terminating,crash-mid-call,identity-forger}.mjs` · `src/cases/{b1-throughput,b2-fencing,b3-backpressure,b4-bounds,b5-crash,b6-mux-identity}.mjs` · **`src/run.mjs` (EDIT: register the new cases — authorized and required, β-M5)**.
**Steps:** 1. `supervisor.mjs`: spawns children, **stamps identity from the spawn-time credential before multiplexing**, per-plugin capability credential, sweeper loop. 2. `kernel-stub.mjs`: one shared socket pair; port-call handler; revocation endpoint. 3. Cases B1→B6 with the measurement contract; B6 hostile battery: forged sibling `plugin_id`, credential mismatch, cross-child correlation-ID collision, stale credential after respawn — all rejected; flood bound measured as sibling-cancel p99 ≤500 ms. 4. Vacuity control: a supervisor variant without identity stamping must FAIL B6.
**Acceptance:** per-case PASS/FAIL with evidence; honest B1 numbers either way; invalid runs marked and rerun.
**NOT:** never report a lost cancellation as "cancelled"; do not average away p99; no verdicts from invalid runs.

## T5c · `test(spike): IPC harness — race battery` (risk: high; receipt required)

**Goal:** the full race battery per plan B2. Depends on T5b.
**Read first:** the plan §4 B2 race battery (all cases, incl. the restored second-executor takeover, §11.11).
**Files:** `src/races/{death-before-commit, lost-reply, recovery-vs-live-commit, healthy-long, heartbeat-behind-commit, saturated-pool, queued-past-lease, second-executor-takeover}.mjs` · `src/races/vacuity-authority.mjs`.
**Steps:**
1. `death-before-commit`: executor dies between effects and COMMIT → rollback → sweeper settles ABANDONED after lease → zero effects (independent connection).
2. `lost-reply`: commit succeeded, reply lost → retry reads durable COMMITTED, never reports cancelled.
3. `recovery-vs-live-commit`: sweeper and executor race; exactly one transition wins (independent read).
4. `healthy-long`: effects phase **> 1× lease** (cadence 5 s / lease 20 s → duration 25–30 s), sweeper active; independent connection asserts multiple durable heartbeat advances during uncommitted effects; COMMITTED with effects intact; **renewal-suppressed variant must FAIL**.
5. `heartbeat-behind-commit`: heartbeat parked behind the uncommitted COMMITTED update → bounded completion.
6. `saturated-pool`: concurrency ≥ `default_pool_size` (10, pinned by T2); healthy executions still COMMIT (proves the reserved renewal path).
7. `queued-past-lease`: QUEUED work longer than the lease is never abandoned.
8. `second-executor-takeover` (plan §11.11): after an execution settles (any terminal state), a second executor holding the stale token attempts the conditional COMMITTED update → 0 rows → FENCED, zero effects, verified via independent connection.
9. `vacuity-authority`: an authority variant **without** the `status='ACTIVE'` predicate must FAIL a race (owned by this task).
**Acceptance:** all races pass with evidence; both vacuity controls (T5b's + this) demonstrated failing as designed.
**NOT:** no claiming broker-level proof — the evidence label (T6) is mandatory; no invented race semantics beyond the plan's definitions (actors, ordering, oracle as written).

## T6 · `docs: spike verdict reports` (risk: high — evidence; receipt: reviewer RERUNS)

**Goal:** both reports filed and independently reproduced.
**Read first:** the plan §3/§4 (verdict mapping, §3.0, replacement branch §8).
**Files:** `docs/plans/<ISO run date>-spike-a-report.md` + `…-spike-b-report.md` (real dates, never placeholders).
**Steps:** 1. Consolidate evidence JSONL (T3a–T5c) into per-hypothesis verdicts with §3.0 diagnosis records for any FAIL. 2. **The B report carries the evidence label verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance"** — and the queued-work/second-executor results are part of the recovery story ADR-0004 cites. 3. The cross-family reviewer checks out the pinned revision and reruns both suites from scratch; outputs attached. 4. Any flip verdict → the replacement-validation track (plan §8) with revised capacity estimate; P0 never closes on "green or flipped".
**Acceptance:** reports merged; reviewer rerun reproduced verdicts; receipt covers the rerun evidence (git head SHA).
**NOT:** no verdict without rerunnable evidence; no papering over environmental-noise; no dropping the evidence label.

## T7 · `docs: capacity annex` (risk: policy-high; **reviewer: the human maintainer** — plan §9: β/γ/δ all have material authorship in the method)

**Goal:** `docs/plans/capacity-annex.md` answering the ≤9-month bar arithmetically (plan §5).
**Read first:** the plan §5 (all eight points, incl. the stated team; the pinned telemetry sheet: per-PR cycle time, review round-trip hours, per-job CI durations, rework ratio; the P80 ≤ 9 months decision rule with Monte-Carlo joint distribution, 10,000 samples, stated independence assumption; the `calendar = feature / 0.85` formula) + Annex L (incl. the retention-sizing consumer) + spec §15–16.
**Files:** `docs/plans/capacity-annex.md`.
**Steps:** 1. Decompose P1/P2/P3 exit criteria into work packages (effort range in PRs + risk class). 2. State the team; mark priors vs measured P0 telemetry (the pinned four-item sheet). 3. Calendar + CI models (all invocations; public-repo concurrency honesty). 4. Renewal-traffic input (≈ active/cadence UPDATE tx/s) + Annex L volume class. 5. Cut ladder: Class A (honestly near-empty) vs Class B (spec amendments, maintainer sign-off, never counted by default). 6. Bar answer: P50 and P80; **met iff P80 ≤ 9 months**; else the gap is reported.
**Acceptance:** maintainer review receipt in the PR (git head SHA); bar answered with arithmetic shown; "doesn't fit" is a valid deliverable.
**NOT:** no spike→15-subsystems calibration claims; no deferred-scope savings; no point-estimate bar claims.

## T8–T11 · ADRs (one PR per ADR; T8/T10 gated on spike verdicts)

**Goal:** ADR-0002 (ORM/data layer, D06 — after T6's A verdict) · ADR-0003 (outbox+pg-boss, D10 — ungated) · ADR-0004 (plugin isolation topology, D11 — after T6's B verdict) · ADR-0005 (UI kit + token compiler, D13+D14 — ungated).
**Read first:** `docs/adr/0001-kernel-and-equal-citizen-plugins.md` (exact format); the register decision with flip conditions; for gated ADRs, the spike report.
**Files:** `docs/adr/0002-orm-data-layer.md` · `0003-outbox-pgboss.md` · `0004-plugin-isolation-topology.md` · `0005-ui-kit-token-compiler.md`.
**Risk classes (δ-M7 corrected):** **T8 and T10 are high-risk** (tenancy substrate / plugin isolation content — receipts required). **T11 is design-system work** — on the model-routing disqualifier list: no small-model executor; reviewer ≠ β (β authored the theme discovery); receipt required. T9 stays low-risk.
**Steps:** ADR-0001 template (Status · Date · Spec/Register links · Context · Decision · Consequences · Flip conditions). PR titles use `docs(adr): …` (commit-policy-safe). ADR-0005 cites the theme discovery (plan §12) as an **input**; if the maintainer hasn't chosen, Decision records "token architecture decided; default theme: maintainer selection pending among three validated directions, validation path named" — a complete state, not a blocker.
**Acceptance:** four self-contained files; flip conditions match the register; gated ADRs cite spike verdict evidence; receipts where required.
**NOT:** no ADR-0006+; no P1+ subject creep; no content beyond register + spike evidence; no `adr:` commit type (rejected by the gate).

## T12 · `docs: contract conventions` (risk: low · one PR)

**Goal:** `docs/specs/contract-conventions.md` per the plan §6.
**Read first:** the plan §6 + Annex L; spec §10, §8, §12.
**Files:** `docs/specs/contract-conventions.md`.
**Steps:** each convention as a checkable rule: one-registry layout (zod → REST/OpenAPI/MCP) · four version axes + per-artifact breaking definition · **transport-neutral error codes**: `CONCURRENCY_CONFLICT` — HTTP 409, MCP = tool result `isError: true` with the code in the structured payload (not a JSON-RPC protocol error) · mandatory `next_step` · action classification taxonomy **`routine | sensitive | destructive`** (the enum verbatim) · event taxonomy + semver namespacing reserved for interop adapters (no xAPI nouns in kernel contracts) · executable no-AI workflow inventory **with its gate**: machine-readable registry (JSON in `packages/contracts` at introduction time) + a CI check landing in P1 verifying every inventory entry references an existing no-AI acceptance-test ID. Annex L referenced, not redefined.
**Acceptance:** every rule checkably stated; a reviewer can say how CI would test each.
**NOT:** do not modify Annex L's frozen values; do not drop the action-classification enum.

## T13 · `ci: secrets-gate negative check asserts the specific finding` (risk: high — CI/gates; receipt + approval artifact)

**Goal:** fix the fail-open defect in `.github/workflows/p0-gates.yml` (secrets negative step accepts any nonzero exit).
**Read first:** `.github/workflows/p0-gates.yml` (secrets job) · `.gitleaks.toml` · `scripts/gates/fixtures/gitleaks/` · the plan §8 (approval artifact, incl. base-commit key rule).
**Files:** `.github/workflows/p0-gates.yml` (EDIT: secrets negative step + the artifact-verifier step in the `gates` job) · `scripts/gates/verify-approval.mjs` (the verifier implementation, exercised by the workflow step) · `scripts/gates/gate-health.test.mjs` (EDIT: the four permanent cases — artifact missing / digest mismatch / bad signature / head-key substitution) · `scripts/gates/approvals/<date>-secrets-gate-fix.json` + `.sig` (artifact).
**Steps:**
1. The negative step asserts the *specific* fixture finding: run gitleaks on the fixture path, parse the report, require the planted finding's rule/file identity present. **Two negative variants:** (a) scanner crash (bad flag) → step fails; (b) scanner runs cleanly but the expected rule ID is absent (fixture temporarily removed) → step fails (δ-m5: proves the assertion is specific, not just "any red").
2. Prove on the PR: fixture present → negative proof green with the asserted finding; deliberately-broken scanner invocation → workflow red (temporary commit, reverted). Link both runs.
3. Workflow comment documents the distinction.
4. **Approval artifact (plan §8; verifier pinned per β-M7 + δ-N4/N5/N7/N9):** the executor prepares the canonical artifact `scripts/gates/approvals/<date>-secrets-gate-fix.json` — canonical form: UTF-8, sorted keys, LF, no trailing newline — carrying `{approver: "maintainer", scope_sha256, timestamp}` where `scope_sha256 = sha256(git diff $(git merge-base origin/dev...HEAD) -- .github/workflows/ scripts/gates/ tools/harness/sql/ 'tools/spikes/*/bench/.artifacts/' ':(exclude)scripts/gates/approvals/*.json' ':(exclude)scripts/gates/approvals/*.json.sig')` — merge-base, not `origin/dev` tip (δ-N7); the exclusions are the artifact files only, **`*.pub` stays in scope** (δ-N5: a key swap is a non-empty diff → requires an artifact signed by the incumbent/base key + human receipt, per plan §8 rotation rule); on `push` runs the diff is against `github.event.before` **and the key is read from that same pre-push commit** (`git show "$GITHUB_EVENT_BEFORE":scripts/gates/approvals/maintainer.pub`) — never from the pushed head (γ MAJOR-2: on push runs `origin/dev` IS the pushed commit, so merge-base collapses to the head — the head-key fallback the NOT-list forbids) — **blocks**: the maintainer signs the canonical JSON with their SSH signing key (`ssh-keygen -Y sign -n plerni-gate-approval`), producing the detached signature file `<artifact>.sig`. The executor never generates keys, never signs. **Verifier (part of this task):** a new step in the required `gates` job with an explicit **trigger condition (δ-N5): an artifact is required iff the scoped diff is non-empty** (zero artifacts + non-empty diff ⇒ red); per artifact in the diff it verifies presence · digest coverage · signature via `ssh-keygen -Y verify` against `maintainer.pub` **read from the PR's merge-base** (`git show $(git merge-base origin/dev...HEAD):scripts/gates/approvals/maintainer.pub`); missing key at base ⇒ fail closed. Verifier negative cases proven on this PR and **kept permanently as gate-health cases (δ-N9)**: artifact missing / digest mismatch / bad signature / head-key substitution → each red (the two PR proofs are temporary commits, reverted, runs linked; the gate-health cases make the fail-closed property durable). **Key material for those cases is generated as throwaway pairs in a temp dir at test time** (`ssh-keygen` into `mktemp -d`, cleaned up after) — never committed: a committed private-key fixture would trip the `secrets` gate on this very PR (γ-C; same pattern as T14's temp fixture).
**Acceptance:** the linked CI runs (fixture-asserted green; scanner-failure red; verifier negative cases red); the new gate-health cases pass locally and are counted in the suite output; reviewer reruns the negative path locally; artifact + signature present and valid against the merge-base key.
**NOT:** no broadened positive scan; no fixture outside the gitleaks-allowlisted path; no executor signatures; no head-key fallback; no artifact covering its own directory.

## T14 · `ci: SCA fixture — generated at test time, never committed` (risk: high — CI/gates; receipt + approval artifact)

**Goal:** an SCA negative proof that cannot contaminate the real scan. Mechanism: the fixture lockfile is **generated into a temp dir at run time** (osv-scanner has no path-exclusion config; per-CVE ignores would mute real findings). **Placement correction (δ-B2):** the `sca` job is a reusable-workflow call (`uses:`) and cannot hold steps — the negative-proof step goes into the required **`gates` job**.
**Read first:** `scripts/gates/gate-health.test.mjs` · `.github/workflows/p0-gates.yml` (both jobs) · the plan §8.
**Files:** `scripts/gates/fixtures/sca/gen-vuln-lockfile.mjs` (pure generator: `package-lock.json` pinning **`lodash@4.17.20` / CVE-2021-23337** into a given temp dir) · `scripts/gates/fixtures/sca/sca-negative-proof.mjs` (the orchestrator: generate → scan → assert → cleanup in one process) · `.github/workflows/p0-gates.yml` (EDIT: `gates` job gains the step) · `scripts/gates/gate-health.test.mjs` (EDIT: structural case asserting the CI step exists and references the orchestrator) · `scripts/gates/approvals/<date>-sca-fixture.json` (artifact as in T13).
**Steps:** 1. The generator (one CVE, cited in a comment). 2. The `gates`-job step is one orchestrating process (`scripts/gates/fixtures/sca/sca-negative-proof.mjs` — **generate → scan → assert → cleanup in a single process**, β-M8: a generator that exits before scanning leaves a nonexistent lockfile): generate the temp `package-lock.json` (lodash@4.17.20) → scan with a **digest-pinned osv-scanner container** (pin + record the digest) → assert CVE-2021-23337 present → cleanup in `finally`. The reusable `sca` job's scope stays byte-identical (temp file never in the tree). 3. Prove on the PR: `gates` job green with the asserted finding visible in logs; the **specificity variant** — assert a *wrong* advisory ID (e.g. CVE-2020-0000) on the same fixture (temporary commit, reverted) — goes **red with the assertion's own diagnostic** (β-M9: removing the assertion would pass, proving nothing). Link both runs. 4. gate-health structural case passes locally. 5. Approval artifact flow exactly as T13 step 4 — digest scope `git diff <merge-base> -- .github/workflows/ scripts/gates/ ':(exclude)scripts/gates/approvals/'`. **Sequencing (β-M7):** T14 starts only after T13 merged — the verifier it relies on is T13's deliverable.
**Acceptance:** both linked CI runs; the negative proof asserts the CVE identifier; the wrong-advisory variant is red with the specific diagnostic; the real scan's scope unchanged; artifact present with valid signature.
**NOT:** no `osv-scanner.toml` (no path mechanism); no committed vulnerable lockfile in the tree; no per-CVE ignores as the fixture mechanism; no steps added to the reusable-workflow job (impossible by construction).

## T15 · `test: fixture PRs for all six gates` + `docs: P0 exit note` (risk: medium · after T13/T14)

**Goal:** spec §15 P0 exit — each gate blocks its deliberately-bad fixture PR through the real PR → required-check path, with proof the checks are required.
**Read first:** the plan §7 (fixture safety rule); the gate scripts under `scripts/gates/`.
**Fixture safety rule (binding):** closed PRs keep `refs/pull/N/head` world-readable forever — fixture content must be safe-permanent: random synthetics and governed (repo-tracked) patterns only; **never** `.private-markers.local`. Each fixture PR body states the rule was followed.
**Attribution discipline (δ-M3):** one fixture PR at a time; for each, link the failing **step** (not just the check), quote its diagnostic, and show the earlier steps green; the secrets fixture branch is deleted immediately after its PR closes (gitleaks scans `--full-history --all` — a lingering branch turns every other PR red and destroys attribution).
**Files:** six fixture branches/PRs (nothing lands except the exit note) · `docs/plans/p0-exit-note.md`.
**Steps:** 0. `gh api repos/tachkovsa/plerni/branches/dev/protection --jq '.required_status_checks.checks[].context'` — paste the list into the exit note. Then, one at a time:
1. `secrets`: a random synthetic secret-shaped string outside the allowlisted fixture path.
2. `private-markers`: a file with a **governed** (repo-tracked) forbidden pattern (read the list from `scripts/gates/`).
3. `license-audit`: add a GPL-only dependency to a **real workspace** `package.json` **and regenerate `pnpm-lock.yaml`** (otherwise `--frozen-lockfile` fails first and the red is misattributed).
4. `kernel-purity`: create `apps/kernel/src/<file>.ts` containing a governed domain noun (the gate walks `apps/kernel/src`, absent today — the fixture PR creates it; never merged).
5. `commit-policy`: a PR whose commit range includes a non-conventional subject.
6. `sca`: temporarily add a vulnerable lockfile inside the scanned tree (deliberate, closed unmerged — T14's own fixture never lives in-tree).
**Exit note:** `docs/plans/p0-exit-note.md` — six red-PR links with failing-step evidence, the required-checks proof, the §15 P0 exit checklist with evidence links, the issue links for T1–T14.
**Acceptance:** six red PRs linked, closed unmerged, branches deleted; exit note merged; milestone closes only when every row has evidence.
**NOT:** never merge a fixture PR; never request a gate bypass; never touch branch protection; never run two fixture branches concurrently.

---

## Sequencing, PR budget, and review routing

Order (plan §8): **T1 → {T2, T9, T11, T12, T13}** in parallel (T13 early — it installs the artifact verifier); then **T2 → {T3a ∥ T5a}** → T3b ∥ {T4a-0 (`ci:` precursor workflow PR, after T13) → T4a} → T4b ∥ T5b → T5c → T6 → T7 → {T8, T10 gated} → **T14 (after T13's verifier is merged)** → T15. (T5a depends only on T2 — δ-m1.)
High-risk tasks (T2, T3a, T3b, T4a, T4b, T5a, T5b, T5c, T6, T7, T8, T10, T11, T13, T14) require a revision-bound review receipt (PR-body receipt against the final head SHA) from a family different from every generator (plan §9). Small-model executors: only low/medium tasks (T1, T9, T12, T15), one task per session, one PR per task.
PR-size budget: >800 handwritten lines → split further, record the split in the issue.

## Review trail of this document

- γ round 1 (v1→v2): 20 findings — all resolved. γ round 2 (v2→v3): 10 findings (E2 carried: osv-scanner has no path exclusion → fixture generated at test time; N1 `spike:` commit type → `test(spike):`; N2/N3 T5-split regressions → restored/owned; N4 image tag `v1.26.0-p0`; N5 manifests; N6 lockfile; N7 kernel-purity root; R-E3 credentials; R-S1 completeness) — all resolved in v3.
- δ round (v3→v4): 2 BLOCKER (B1 approval artifact fail-open again → full mechanism: maintainer signs, verifier in the required gates job, base-commit key, digest scope defined; B2 T14's step can't live in a reusable-workflow job → moved to the `gates` job with pinned scanner/package/advisory) + 8 MAJOR (M1 v3 was based on v8 not v9 → rebased: search_path role default in T2, phase attribution, telemetry sheet, Monte Carlo P80; M2 phantom race cases → defined in T5c + restored in the plan §11.11; M3 secrets fixture turns every PR red → isolated runs + branch deletion + step-level attribution; M4 credential in compose config output → `--no-interpolate`; M5 T2 config gaps → `[databases]`, pinned pool size, membership fixture, fencing grants, superuser path, stats_users; M6 T4 guessing → pinned CI runner class, `/usr/bin/time -v` RSS, committed artifacts, AST-based lint + `$narrowType`/`$assertType`; M7 ADR risk classes corrected; M8 DCO sign-off is human + maintainer enables auto-merge) + 6 MINOR (m1 T5a dependency; m2 lockfile in T2; m3 type-stripping + package name; m4 two framings separated, checksum dropped, cadence/lease pinned, PRNG property tests; m5 clean-scanner-wrong-rule variant; m6 `docs(adr):` titles + classification enum restored) — all resolved in this v4.
- β round (v4→v5): 2 BLOCKER + 8 MAJOR + 2 MINOR — all resolved in v5.
- δ disposition check (v5→v6): 6 MAJOR + 3 MINOR — all resolved in v6.
- γ disposition check (v6→v7): 2 MAJOR (T3a's lockfile edit lost when the glob moved to T2 → restored; push-run key read collapsed to head-key → key read from `github.event.before`) + 5 MINOR (T2/T13 parallel-wave clause; gate-health case count aligned to four; throwaway key pairs at test time — never committed, the secrets gate would trip; maintainer approves the receipt text before auto-merge; squash message carries `Signed-off-by` above `AI-assisted: yes`) — all resolved in this v7. γ's note: this pass + the maintainer's sign-off completes the review chain for the document.
