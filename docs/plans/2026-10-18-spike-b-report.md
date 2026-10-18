# Spike B report

Verdicts for plan §4 B1–B6 and the T5c race battery. Scored run: 2026-10-18, dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766`, after the host packet filter accepted compose-bridge forwarding. The invalid pooled login from earlier that day is recorded in the Spike A report and is not a B verdict.

Evidence label, verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance".

## Rerun

One command, from a clean worktree of that SHA. Export the four harness passwords first. Node is the major in `.nvmrc` (this run: v24.22.0). `reset.sh` needs Docker Compose v2 and `psql`.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/ipc-harness spike && pnpm --filter @plerni-spike/ipc-harness test && pnpm --filter @plerni-spike/ipc-harness test:races
```

`spike` is in that command because the performance windows live there. `test` scores the deterministic B2–B6 checks and does not apply the 60 s contract. `test:races` is the race battery plus the B6 identity-stamping vacuity control.

This run: `spike` exit 0; `test` 107 pass, 0 fail, 0 skipped, 23004 ms; `test:races` 24 pass then the vacuity test 1 pass, 0 fail, 0 skipped, race file 92139 ms. JSONL stays gitignored. The lines that back these verdicts, including the later partial-cap and commit/revoke overlap runs, are in `docs/plans/2026-10-18-spike-rerun-evidence.md`.

Review receipt: pending (δ, cross-family).

## Environment

Same pinned harness as the Spike A report: PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`, `default_pool_size=10`. Measurement-contract preflight at the start of the suites: 4 CPUs, quota unlimited, load 0.12, not throttled, not overloaded, `valid: true`. Smoke recorded `mainPath: pooled`. Renewals use the reserved direct connection. Each scored performance repetition below has `envAfter.valid: true`. No performance case returned `invalid`.

## Verdicts

| ID | Verdict | Measured result |
|---|---|---|
| B1 | PASS | Per-rep rate 7998.23, 8000, 7999.88 /s. Per-rep p99 0.488, 0.365, 0.386 ms. Corrupt 0, errors 0. Target ≥5000 /s and p99 ≤10 ms. |
| B2 sequential | PASS | Lost cancel stays `COMMITTED` and is reported `lost`. Live cancel is `cancelled` / `CANCELLED`. Commit after cancel is fenced. Ignore-cancel returns `ignore` and the cancel times out. |
| B2 concurrent | PASS | Three overlap runs on the existing `commitExecution` and `cancelExecution` exports. The executor held the row with `SELECT … FOR UPDATE` inside the effects transaction. The revoker waited (`Lock` / `transactionid`). The commit won, the cancel lost, and the row stayed `COMMITTED`. 36–41 ms, no deadlock. |
| B3 | FAIL | The partial cap is 32768 bytes. Three `tripCaps()` runs buffered 1052672 bytes, faulted `NdjsonOversizeError`, and the runner still set `bound: true` because that count is under 2 MiB. Pending, total, kernel, and RSS checks in the same case stayed inside their own bounds. The hypothesis requires every named cap, including the partial-frame buffer. |
| B4 | PASS | Oversize and never-terminated frames are typed errors. A malformed child does not kill its sibling. |
| B5 | PASS | Mid-call exit is `child-exited` (code 1). The retired token is refused. The respawn token is distinct and fenced. Status stays `ACTIVE`. |
| B6 | PASS | Hostile checks all true. Flood cancel p99 84.61, 69.99, 86.13 ms, each ≤ 500 ms. |
| Races | PASS | Every battery case passed. Both vacuity controls fail in the way the oracle requires. |

## B1

Frozen shape: 2 children, in-flight 128, offered rate 8000/s, 1024-byte payload, warmup 5 s, window 60 s, 3 reps. Offered 480000 per rep. Issued 479894, 480000, 479993. Drops 106, 0, 7, counted as the call timeout inside p99. p99 stayed under 10 ms. Endpoints: kernel send → supervisor ingress → child egress → kernel return. Topology: in-process kernel stub, one socket pair, spawned children. Rep loads after the window: 1.06, 1.17, 1.14.

## B2

The four suite outcomes run one after another. Commit finishes before the lost revocation. Revocation finishes before the fenced commit. The ignore-cancel child times out. The race battery's recovery-vs-live-commit case is the sweeper's `ABANDONED` update against commit.

The concurrent clause is a later run of the existing exports, not a new harness file. `commitExecution` holds `SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE` inside the effects transaction, and `cancelExecution` issues the `CANCELLED` update on a second pooled connection. `pg_stat_activity` showed that update waiting on `Lock` / `transactionid` before the executor committed. Three runs: commit won, `cancelWon` false, status `COMMITTED`, 41 ms, 39 ms, 36 ms. The suite command does not invoke this overlap. Follow-up: register it in the race battery so that command reruns it.

## B3

§3.0 record for the FAIL:

1. **What the runs show.** The scored spike's partial object is `pendingBytes` 1052672, `NdjsonOversizeError`, `bound` true, cap configured as `32 * 1024`. Three later `tripCaps()` calls on the same harness and the same dev SHA returned that same byte count, the same code, `tripped` true, and `bound` true.
2. **Root cause.** `tripCaps()` passes `partial: 32 * 1024` and does not set a separate high-water, so the high-water is 32768. `Supervisor.#accountCaps` sets `caps.partial` when `pendingBytes` reaches that mark and then keeps reading. The comment on that branch says a pause would stall an unfinished frame short of the framer's typed error. `NdjsonFramer` throws once an unfinished line passes 1 MiB + 1 byte. The fault stores `pendingBytes` after the chunk that crossed the limit. 1052672 = 1048576 + 4096. `bound` is `pendingBytes < 2 * 1024 * 1024`, so the suite prints a pass at about 32 times the named cap.
3. **Not noise.** The three diagnostic runs and the scored spike agree on 1052672. No database setting is on this path. The effective cap is the object above, and the framer ceiling is 1 MiB.
4. **What a fix looks like.** Fault or stop when the unfinished frame passes the configured partial cap, with only a defined read-chunk overshoot allowed, and assert `pendingBytes` against that cap. Rerun B3. That is a harness change. This docs PR does not make it.

The other measurements in the same case stay as recorded: pending admitted 4 and rejected 4; total cap tripped with buffered 0; the kernel socket pause admitted one call (270 buffered bytes) and rejected a frame above the kernel byte cap before a waiter was installed. RSS growth was 778240, 290816, and 10981376 bytes, each at or under 67108864, on holds of about 5 s inside the 60 s window. Those bounds do not make the partial-frame clause pass.

Plan §8 opens the replacement-validation track when a verdict replaces the shipped substrate, and that track carries a revised capacity estimate. This FAIL is an unenforced harness cap. The consequence is the follow-up above, then a B3 rerun. The replacement track is not opened. No revised capacity estimate is attached here. The flow-control hypothesis is not accepted.

Each hold warmed 5002 ms, 5004 ms, and 5003 ms, then offered 300 slots (issued 300, skipped 0). Pending, partial, total, lo, and hi flags tripped on every hold, and the near-cap checks stayed true. The partial flag on those holds is the same high-water mark as the FAIL above. The sibling answered. Growth for the three holds is in the B3 row. The third hold is larger than the first two and remains under 64 MiB. The environment stayed valid (loads 1.02, 1.18, 1.14).

## B4, B5, B6

B4: malformed child `NdjsonFramingError`, sibling process alive and round-tripped. Never-terminated frame `NdjsonOversizeError`, pending bytes 1049600, bounded, sibling round-tripped. Mux length above 1 MiB: `MuxOversizeError`, limit 1048576, sibling process alive, reachable false.

B5 does not claim the sweeper. The crash leaves the row `ACTIVE`, and the respawned child cannot reuse the token.

B6 hostile checks: routing, forged, mismatch, collision, stale, all true. Starvation: 2 rejects on the silent child; the sibling completed before and after the deadline reclaimed the slot (`timeout`). Forged-result flood faulted at the hi cap (8) and the sibling still answered. Flood contract: 2 children, cancel rate 20/s, warmup 5 s, window 60 s, 3 reps. Per rep: 1200 samples, 0 timeouts, 0 skipped (offered = issued = 1200). Flood rates over the scored window: 179615/s, 181371/s, 179894/s, each above the 10000/s minimum. Rep loads after the window: 0.92, 0.97, 1.18.

The identity-stamping vacuity control is a pass of the runner because the exploit lands: `stampIdentity: false`, forged payload delivered, `exploit: true`, and the variant's own pass bit is false. Routing, mismatch, and stale stay true. Forged and collision are false. `test:races` repeats that control once, and it passed.

## Recovery story

ADR-0004 cites this section. The label above applies to all of it: the authority row is the minimal real authority, and the full broker proof remains P2 acceptance.

Cadence is 5 s and the lease is 20 s. Renewal traffic for the capacity annex is about `active executions / cadence` UPDATE transactions per second. Smoke, on the pooled main path, recorded 2 renewals in a 12 s effects phase (last renewal-to-lock 2004 ms) and 3 renewals in a 16 s phase (1006 ms). A slow renewal that held the row lock measured last renewal-to-lock 0 ms and lock wait 2013 ms, inside the 5000 ms bound.

| Case | Suite result | What the passing oracle required |
|---|---|---|
| death-before-commit | PASS (79 ms) | Expired `ACTIVE` becomes `ABANDONED` with zero effects. |
| lost-reply | PASS (54 ms) | A retry reads `COMMITTED`. |
| recovery-vs-live-commit | PASS (152 ms) | Sweeper and executor: exactly one transition wins. |
| healthy-long | PASS (46510 ms) | Effects wall is between 25 s and 30 s, above the 20 s lease, with the sweeper active. The renewal-suppressed variant is abandoned at or after the lease. |
| stalled shutdown | Designed failure of the renewal-to-lock oracle (11109 ms) | The case's pass bit is false, the row still commits, and last renewal-to-lock exceeds the 5 s cadence. |
| heartbeat-behind-commit | PASS (5056 ms) | Completion stays inside the bound. |
| saturated-pool | PASS (21394 ms) | 10 executors, each held past the lease, no bound violation, renewal-to-lock at or under the cadence. This is the reserved-path proof at concurrency equal to `default_pool_size`. |
| queued-past-lease | PASS (51 ms) | A `QUEUED` row older than the lease stays `QUEUED` and is not swept. An `ACTIVE` row expired the same way is swept to `ABANDONED`. |
| second-executor-takeover | PASS (125 ms) | After `COMMITTED`, `CANCELLED`, and `ABANDONED`, a second executor with the stale token loses the conditional update: fenced, status unchanged, takeover effects 0. The `COMMITTED` row keeps its one settled effect. |
| vacuity-authority | Designed failure (228 ms) | With the `status='ACTIVE'` predicate removed, the open variant loses the race (`ABANDONED` on the executor, `COMMITTED` on the sweeper, effects present). The real predicate still commits. |

A direct call of `queuedPastLease` and `secondExecutorTakeover` immediately after the suite, same SHA and same harness, returned the same row outcomes: queued status `QUEUED` and not swept; active control `ABANDONED` and swept; takeover rows fenced for all three terminal states with `takeoverEffects` 0 and the committed row's `settledEffects` 1. The suite run is the verdict. That call is only the field dump the test runner does not print.

## Replacement-validation track

Plan §8 opens that track when a verdict replaces the shipped substrate, and that track carries a revised capacity estimate. B1, B2's demonstrated clauses, B4, B5, B6, and the race battery stay on framed NDJSON, the supervisor-stamped credential, and the conditional authority row. B3 is the follow-up in the B3 section: a harness fix and a rerun, not this track. No revised capacity estimate is attached here.
