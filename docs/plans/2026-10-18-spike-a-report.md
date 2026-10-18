# Spike A report

Verdicts for plan §3.1 A1–A5 and the §3.2 battery. The scored A1–A4 evidence is three separate suite invocations on 2026-10-18, on parent `281f9d3a6e29fd57f6ece14fd255abd4667b41be` (that tree's parent `60a233ac31ddd812a13e7d4f6d08fa54677f3877`). This commit does not repeat them. The A5 curve and drift gate stay the 2026-10-17 measurement cited below. This file is the T4b skeleton with the T6 verdicts added.

## Rerun

One command, from a clean worktree of that SHA. Export `POSTGRES_PASSWORD`, `PLERNI_APP_PASSWORD`, `PLERNI_MIGRATE_PASSWORD`, and `PLERNI_ADMIN_PASSWORD` first. Node is the major in `.nvmrc` (this run: v24.22.0). `tools/harness/reset.sh` needs Docker Compose v2 and `psql`.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/db-invariant spike
```

The same command was run three times. Each invocation followed `reset.sh` and `seed.mjs`, exited 0, and wrote 39 JSONL rows with `0 failing case(s)`. JSONL stays gitignored (`tools/spikes/*/evidence/`). The lines that back these verdicts are in `docs/plans/2026-10-18-spike-rerun-evidence.md`.

Review receipt: REV-T6-2026-10-19-9cf9740 covers the A5 curve and the drift-gate citation. The A1–A4 numbers and the battery count in this file are these three runs and are pending (δ).

## Environment

| Item | Value |
|---|---|
| dev SHA | this commit (parent `60a233ac31ddd812a13e7d4f6d08fa54677f3877`) |
| Node | v24.22.0 |
| PostgreSQL | 18.6 (Debian 18.6-1.pgdg13+2), image `postgres:18` digest `sha256:74935e72…fc4336` |
| PgBouncer | 1.26.0, image `edoburu/pgbouncer:v1.26.0-p0` digest `sha256:b17551c7…95b711` |
| Admin `SHOW` | `pool_mode=transaction`, `max_prepared_statements=0`, `default_pool_size=10`, `server_reset_query=DISCARD ALL`, `server_reset_query_always=0` |
| Host | 4 CPUs, quota unlimited |

## Invalid run

The first `spike` after `reset.sh` is not a verdict. A1 on the direct datasource passed. The pooled checkout then threw `client_login_timeout (server down)` at 60158 ms. Exit 1. The JSONL has that one direct row and no hypothesis FAIL.

§3.0 record:

1. **Raw-`pg` control.** Direct `psql` as `plerni_app` returned a row. Pooled `psql` as the same role failed before a query, with the same `client_login_timeout (server down)`. Kysely had not sent a statement on that path.
2. **Effective config.** The admin console still answered. The values are the table above. `SHOW VERSION` reported PgBouncer 1.26.0. Direct `SELECT version()` reported PostgreSQL 18.6. The pooler log recorded `connect failed` and `connect timeout` toward the compose Postgres service. The host packet filter was dropping forwarded traffic on the compose bridge.
3. **Runs.** The original spike and one pooled `psql` in that window failed `client_login_timeout (server down)`. After the scored suites, the dropping filter was restored. Three probes against the pooler that still held the scored run's server state failed `query_wait_timeout`. A pooler restart, then three more pooled raw-`pg` probes, each exited 2 with `client_login_timeout (server down)`. The direct control beside that trio succeeded. The login timeout and the queue timeout are both environmental, and they are different errors.
4. **Oracle.** The pooled oracle did not run. Destination: invalid run. No A1–A5 label is taken from it.

The filter was then set to accept compose-bridge forwarding. Three pooled probes succeeded. That episode is on dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766`. The verdicts below are the three later `spike` invocations on this commit.

## Verdicts

| ID | Verdict | Where it leaves the plan |
|---|---|---|
| A1 direct | PASS | Kysely and the raw-`pg` control, both on the direct app DSN: `pg_backend_pid()` constant across 3 statements in each of 8 concurrent transactions. The two result sets match. |
| A1 pooled | PASS | Three separate invocations. Kysely and `rawAppPooled()`, both through PgBouncer: `pg_backend_pid()` constant across 3 statements in each of 8 concurrent transactions, in every invocation. |
| A2 | PASS | All three invocations. Clean-deny reads 0 rows and the app guard raises. Tenant B's positive control returns B's three labels. After commit, context is absent and the context-less follow-up reads 0 rows. Both datasources. |
| A3 | PASS | All three invocations. A1 and A2 are green via PgBouncer, including the pooled raw-`pg` control. The Kysely probes add `22012` rollback and the contamination lifecycle. |
| A4 | PASS on unnamed discipline. A4b stays open. | All three invocations: every observed statement name was empty (75 statements, 0 non-empty). Unnamed-vs-named means 30.4%, 27.3%, and 25.7%, each `mean-exceeds-20`. Issue #34 stays the named-statement experiment. `max_prepared_statements` stayed 0. |
| A5 | PASS at the acceptance point | Band 75 is within the ceiling on the 2026-10-17 CI run. Stress bands did not overrun. No ergonomics fallback. |
| Battery | PASS | All three invocations. Terminations equal injected contaminations (8 and 8). Warm-tail terminations 0. |

The vacuity control passed: skipping the context install reads 0 rows and raises `MissingTenantContextError`. The `ALTER ROLE` default injection ends in the designed loud failure after 2 retries (3 terminations, 3 injected logins) and is recorded as a pass.

A3's pooled pinning rows are that case's own Kysely run. The pooled raw-`pg` control is the A1 row labeled `pooled (raw-pg control)`. `recordProbe` still attaches its failure-path raw script through `rawApp()`, the direct DSN, and that script did not run because the Kysely probes passed.

## A1 pooled raw control

A1 pooled is PASS. Three separate suite invocations each opened `rawAppPooled()`, a `pg.Client` on the pooled DSN, began a transaction, and read `pg_backend_pid()` three times. In every invocation, each of the 8 concurrent transactions kept one pid. The direct raw-`pg` result stays PASS on the same three invocations. A3 is PASS because that control is green in all three and the A3 probes passed in all three. These two clauses do not open the replacement-validation track. The partial-cap clause in the Spike B report is FAIL on this commit. The B3 total-buffer clause is FAIL.

## A3 contamination lifecycle

On the pooled datasource, all three invocations detected the executing backend before tenant access, `pg_terminate_backend` removed it (`backendGoneMs` 5, 7, and 5), and the absence check ran on the replacement session. The positive control passed. Retries were 1 in each invocation. Cleanup was 22 ms, 26 ms, and 22 ms. The rival checkout was held off and did not time out.

## A4 overhead

Ten reps, ABBA then BAAB, 2500 iterations per block, 4 blocks per rep, direct connection, Node v24.22.0. Three invocations. Means 30.4% (unrounded 30.419, 95% interval 21.1–39.7), 27.3% (unrounded 27.252, interval 18.0–36.5), and 25.7% (unrounded 25.675, interval 16.7–34.6). Each decision is `mean-exceeds-20` and `a4bRequired` is true. Issue #34 already tracks `test(spike): A4b named-statement branch` (`max_prepared_statements > 0`, then A1–A3 again on the pool). This report does not run that experiment.

## Battery

Pool-abort leaves context absent on direct and pooled, with zero extra terminations. Interleave on a pool of size 1 returns each tenant's own rows, both positive controls, on one backend. Contamination classes GUC, `SET ROLE`, `search_path` (direct and pooled), first-use, and `ALTER ROLE` default all matched their login budgets. The GUC-forgery classifier is prototype evidence scoped to classifier shape: lexical `set_config` smuggling is rejected, the three known lexical bypasses are recorded, plugin SQL does not execute raw, and a hostile session `SET` is contained by the hygiene protocol. Session-GUC denial is unavailable. The admission parser remains P2 work.

## A5 curve

Measurement run: 2026-10-17, [bench-dispatch 39044052211](https://github.com/tachkovsa/plerni/actions/runs/39044052211), commit `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. The numbers are the `typecheck-benchmark` artifact (`bench.jsonl`), checked against the job log. Each wall and RSS figure is the maximum of three repetitions, taken independently.

T4b does not change `measure.mjs`, the generators, the corpus, the compiler flags, or `bench-dispatch.yml`. That dispatch already measured bands 50, 75, 200, and 400. This T6 rerun does not repeat the curve. The ceiling is the CI runner class. Laptop timings are not the acceptance evidence.

The ceiling binds the acceptance point only: band 75, 375 queries, at most 120000 ms and 3906250 KiB (4 GB decimal, the bound in `measure.mjs`). Bands 200 and 400 are stress points. Band 50 is the low end of the curve. The runner labels every non-acceptance band `stress`. `over_ceiling` on a stress target is informational.

| Band | Plan role | Target | Wall max (ms) | RSS max (KiB) | Runner outcome | Over ceiling |
|---:|---|---|---:|---:|---|---|
| 50 | curve | corpus | 2420 | 396212 | stress | false |
| 50 | curve | baseline | 610 | 228384 | stress | false |
| 75 | acceptance | corpus | 3410 | 429960 | within-ceiling | — |
| 75 | acceptance | baseline | 760 | 236704 | within-ceiling | — |
| 200 | stress | corpus | 18130 | 769568 | stress | false |
| 200 | stress | baseline | 750 | 296792 | stress | false |
| 400 | stress | corpus | 97440 | 1356892 | stress | false |
| 400 | stress | baseline | 900 | 338320 | stress | false |

Every summary in the artifact reports `payload_p99_bytes` 32768. N includes `plugin_lrs_statement` and excludes the harness fixture tables.

### Stress points and §3.0

An overrun at band 200 or 400 opens a §3.0 diagnosis record and is input to the budget ADR. It does not select an ORM fallback. The ceiling that can decide ergonomics is the band-75 acceptance point.

No stress target in this run has `over_ceiling: true`. The largest stress sample is band 400 corpus: 97440 ms and 1356892 KiB, both under 120000 ms and 3906250 KiB. §3.0 is not opened for A5. No fallback is taken.

### Ergonomics verdict

Band 75 corpus and baseline are `within-ceiling`. That is the A5 pass. The ergonomics destination stays Kysely at the acceptance point.

### Drift gate (R1#5)

`pnpm --filter @plerni-spike/db-invariant bench:drift-gate` runs `bench/drift-gate.sh`. For each band the script applies the committed `schema.sql` to the live database `spike_bench_<N>`, regenerates `database-types.ts` with the pinned kysely-codegen 0.20.0 flags, and runs `git diff --exit-code` on that interface. A difference exits 1. A missing tool, a missing artifact, a refused database, or a codegen failure exits non-zero. The script does not skip a band.

The gate is not a required check. It is not wired into `.github/workflows/` or branch protection.

Two fixtures prove the failure on band 50, then restore the committed files:

- `bench/drift-fixtures/rename-unused-column.sh` renames `ent_0001.created_at` to `opened_at` in `schema.sql` and does not regenerate the interface. `created_at` is not referenced by `gen-corpus.mjs`. The gate must fail, and the diff must show `opened_at` on the interface.
- `bench/drift-fixtures/stale-after-sql-change.sh` adds `drift_marker` to the same table in `schema.sql` and does not regenerate the interface. The gate must fail on that stale interface.

The clean tree passed the gate on bands 50, 75, 200, and 400 in the T4b run (exit 0, `drift-gate: ok`). Both fixtures exited 0 after the gate exited 1 and the diff showed the drifted column. A staged extra line on the band-50 interface exited 1 before migrate. Those transcripts are in the T4b pull request. This T6 session did not repeat the gate.

## Replacement-validation track

Plan §8 opens the replacement-validation track when a verdict replaces the shipped substrate, and the track carries a revised capacity estimate. A1, A2, A3, A4's unnamed discipline, and A5 stay on the results the suite demonstrated. A4b stays issue #34. The partial-cap re-spike in the Spike B report was opened by the original FAIL. The framer residual at dev `1b1f536c6fa874369ce1d30e9337f4224961be93` closed the oversize defect. This commit's partial high-water is 69632 bytes, so that clause is FAIL. The B3 total-buffer clause is FAIL. Per plan §8 the B3 FAIL opens the replacement-validation track, and the maintainer's decision is pending between (a) accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer) and (b) a flow-control redesign. This round starts neither. The capacity annex remains T7.
