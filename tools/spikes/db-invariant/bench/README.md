# Spike A typecheck benchmark

Plan §3.1 A5. This directory generates a schema band, a Kysely query corpus, and a raw-`sql` baseline, then measures `tsc --noEmit` wall time and peak RSS. The acceptance point is band 75 (375 queries): at most 4 GB RSS (3,906,250 KiB, the plan's decimal 4 GB) and 120 s on the CI runner class. Bands 50, 200, and 400 are the rest of the curve; an overrun there is recorded, and it is not an automatic ORM fallback.

N counts **every** table in the band, including `plugin_lrs_statement`. The harness fixture tables `plerni_tenant` and `fencing_authority` live in the `plerni` database and are not part of N.

| Band | S | M | L | Queries | Ceiling |
|---|---:|---:|---:|---:|---|
| 50 | 150 | 75 | 25 | 250 | stress |
| 75 | 225 | 112 | 38 | 375 | 4 GB RSS (3,906,250 KiB), 120 s |
| 200 | 600 | 300 | 100 | 1000 | stress |
| 400 | 1200 | 600 | 200 | 2000 | stress |

`S = 3N`, `M = floor(1.5N)`, `L = 5N − S − M`. S is one select, one insert, and one update per table. M alternates two and three `JOIN` clauses (three and four tables), with a declared optional predicate and a `(seq, id)` keyset page. L is split round-robin across a select CTE, a data-modifying CTE, conditional composition, and a generic helper (`withKeyset` / `withOptionalLimit`). Every fifth M and L query reads or writes `plugin_lrs_statement`.

`plugin_lrs_statement.payload` is JSONB. Annex L's class is 0.5–4 KiB typical, p99 ≤ 32 KiB; the check constraint is the p99 cap. A trigger rejects `UPDATE` and `DELETE`. The corpus still typechecks an update against that table so the S count stays 3N. Nothing in the corpus is executed.

Queries are grouped 100 per function. A single function of the band-400 corpus exceeds the compiler's control-flow depth and the callbacks collapse to implicit `any`; the exported entry points only call the parts. Each Kysely query carries `Expect<Equal<Inferred, …>>` on `executeTakeFirstOrThrow`. `corpus-lint.mjs` walks the TypeScript AST and rejects fragments of Kysely's `sql` export, including a renamed import such as `sql as raw` (except `select set_config('plerni.<guc>', …, true)`), `as` / angle type assertions, explicit `any`, explicit call type arguments, and `$castTo` / `$narrowType` / `$assertType`. A call `.as('alias')` is not a type assertion. The lint runs before any timing. The baseline is the same query shapes as one `sql<Row>` template each (the same joins, the M `status` predicate and `(seq, id)` keyset page, and the L CTE or conditional composition) and is not linted; that generic is the cost the corpus is compared with. A nonzero `tsc` exit keeps a bounded slice of stdout and stderr in the evidence row even when the timing line parsed.

## Regenerate committed artifacts

Artifacts are `bench/.artifacts/band-<N>/schema.sql` and `database-types.ts`. Generation applies the SQL to database `spike_bench_<N>` on the direct Postgres port (dropped and recreated first; bands do not share a database) and runs `kysely-codegen` 0.20.0.

```bash
export BENCH_PG_PASSWORD=…   # or POSTGRES_PASSWORD from the harness
# optional: BENCH_PG_HOST (default 127.0.0.1) BENCH_PG_PORT (default 54320) BENCH_PG_USER (default postgres)
pnpm --filter @plerni-spike/db-invariant bench:schema 50
pnpm --filter @plerni-spike/db-invariant bench:schema 75
pnpm --filter @plerni-spike/db-invariant bench:schema 200
pnpm --filter @plerni-spike/db-invariant bench:schema 400
```

Pinned codegen flags: `--dialect postgres --date-parser timestamp --numeric-parser string --default-schema public --type-only-imports`. `kysely-codegen` 0.20.0 depends on `micromatch`, which depends on `braces`. `braces` through 3.0.3 has no patched release (GHSA-vfj7-8cjw-p6xm), so the root manifest overrides `braces` with `bench/brace-expand`, a depth-capped stand-in. The benchmark does not pass brace patterns. `matcher()` uses `picomatch` and does not call the stand-in.

## Corpus, lint, compiler

From `tools/spikes/db-invariant`:

```bash
node bench/gen-corpus.mjs 75
node bench/corpus-lint.mjs bench/out/band-75/corpus.ts
/usr/bin/time -v ./node_modules/.bin/tsc --noEmit -p bench/out/band-75/tsconfig.corpus.json
/usr/bin/time -v ./node_modules/.bin/tsc --noEmit -p bench/out/band-75/tsconfig.baseline.json
```

The same pair of `tsc` invocations, with `75` replaced, is the measurement for bands 50, 200, and 400. Compiler flags are frozen in `tsconfig.bench.json` (the package's strict flags, `noEmit`, `types` empty so `@types` packages are not part of the program). `bench/out/` is generated and gitignored.

## Measurement

```bash
node bench/measure.mjs 75
```

`/usr/bin/time -v` supplies wall clock and peak RSS (`--extendedDiagnostics` is heap, not RSS). Three repetitions, sequential. The recorded environment includes available memory, CPU quota, and whether this is a GitHub-hosted runner. Pre-flight requires `/usr/bin/time`, at least 6 GiB available, at least two CPUs, and a CPU quota of at least 1.5 cores when a quota is set. When `BENCH_REQUIRE_DB=1` it also requires a direct connection to Postgres. A failed pre-flight is retried once. A timing report that cannot be parsed is retried once. If it is still invalid, the outcome is `invalid` and is not compared with the ceiling.

Band 75 is `within-ceiling` or `over-ceiling` from the **maximum** wall time and peak RSS of the three corpus reps, and the same for the baseline. Other bands are `stress`; `over_ceiling` is informational. Evidence is appended to `tools/spikes/db-invariant/evidence/bench.jsonl` (gitignored).

The dispatch workflow `.github/workflows/bench-dispatch.yml` installs dependencies, starts the dev harness, runs `measure.mjs` for 50, 75, 200, and 400, and uploads that JSONL. It is `workflow_dispatch` only. Dispatch it against a ref whose workflow file contains these steps:

```bash
gh workflow run bench-dispatch.yml --ref <branch>
```

Laptop timings are not the acceptance evidence. The ceiling is the CI runner class.
