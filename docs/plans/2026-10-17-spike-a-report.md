# Spike A report — A5 skeleton

T4b skeleton for plan §3.1 A5 and the R1#5 drift gate. T6 files the remaining hypotheses and the verdicts. This section records the typecheck curve and the drift-gate contract. It does not issue an ergonomics verdict.

Measurement run: 2026-10-17, [bench-dispatch 39044052211](https://github.com/tachkovsa/plerni/actions/runs/39044052211), commit `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. The numbers are the `typecheck-benchmark` artifact (`bench.jsonl`), checked against the job log. Each wall and RSS figure is the maximum of three repetitions, taken independently.

T4b does not change `measure.mjs`, the generators, the corpus, the compiler flags, or `bench-dispatch.yml`. That dispatch already measured bands 50, 75, 200, and 400. A second dispatch is not required to fill this table.

## A5 curve

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

## Stress points and §3.0

An overrun at band 200 or 400 opens a §3.0 diagnosis record and is input to the budget ADR. It does not select an ORM fallback, and it does not decide the ergonomics verdict. The ceiling that can decide ergonomics is the band-75 acceptance point.

No stress target in this run has `over_ceiling: true`. The largest stress sample is band 400 corpus: 97440 ms and 1356892 KiB, both under 120000 ms and 3906250 KiB. §3.0 is not opened. There is no diagnosis record because there is no overrun to diagnose. No fallback is taken.

## Acceptance point

Band 75 corpus and baseline are `within-ceiling` on the cited run. That is the acceptance measurement. The ergonomics verdict waits for the T6 report. Stress bands do not supply it.

## Drift gate (R1#5)

`pnpm --filter @plerni-spike/db-invariant bench:drift-gate` runs `bench/drift-gate.sh`. For each band the script applies the committed `schema.sql` to the live database `spike_bench_<N>`, regenerates `database-types.ts` with the pinned kysely-codegen 0.20.0 flags, and runs `git diff --exit-code` on that interface. A difference exits 1. A missing tool, a missing artifact, a refused database, or a codegen failure exits non-zero. The script does not skip a band.

The gate is not a required check. It is not wired into `.github/workflows/` or branch protection.

Two fixtures prove the failure on band 50, then restore the committed files:

- `bench/drift-fixtures/rename-unused-column.sh` renames `ent_0001.created_at` to `opened_at` in `schema.sql` and does not regenerate the interface. `created_at` is not referenced by `gen-corpus.mjs`. The gate must fail, and the diff must show `opened_at` on the interface.
- `bench/drift-fixtures/stale-after-sql-change.sh` adds `drift_marker` to the same table in `schema.sql` and does not regenerate the interface. The gate must fail on that stale interface.

The clean tree must pass the gate on bands 50, 75, 200, and 400. The fixture transcripts live in the T4b pull request.
