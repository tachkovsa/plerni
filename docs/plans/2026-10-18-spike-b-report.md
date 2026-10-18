# Spike B report

Verdicts for plan §4 B1–B6 and the T5c race battery. Scored run: 2026-10-18, dev `1b1f536c6fa874369ce1d30e9337f4224961be93` (the partial-cap fix, pull request #47). The invalid pooled login from earlier that day is recorded in the Spike A report and is not a B verdict.

Evidence label, verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance".

## Rerun

The scored suites are one command, from a clean worktree of that SHA. Export the four harness passwords first. Node is the major in `.nvmrc` (this run: v24.22.0). `reset.sh` needs Docker Compose v2 and `psql`.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/ipc-harness spike && pnpm --filter @plerni-spike/ipc-harness test && pnpm --filter @plerni-spike/ipc-harness test:races
```

`spike` is in that command because the performance windows live there. `test` scores the deterministic B2–B6 checks and does not apply the 60 s contract. `test:races` is the race battery plus the B6 identity-stamping vacuity control.

This run: `spike` exit 0; `test` 108 pass, 0 fail, 0 skipped, 23311 ms; `test:races` 26 pass, 0 fail, 0 skipped, 92167 ms, then the B6 vacuity control 1 pass, 1663 ms. JSONL stays gitignored. The lines that back these verdicts are in `docs/plans/2026-10-18-spike-rerun-evidence.md`.

`test:races` includes `commit-vs-revoke`. That case is the concurrent clause.

Review receipt: pending (δ, cross-family).

## Environment

Same pinned harness as the Spike A report: PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`, `default_pool_size=10`. The first preflight printed by the scored spike is the B6 flood environment: 4 CPUs, quota unlimited, load 0.14, not throttled, not overloaded, `valid: true`. Smoke recorded `mainPath: pooled`. Renewals use the reserved direct connection. Each scored performance repetition below has `envAfter.valid: true`. No performance case returned `invalid`.

## Verdicts

| ID | Verdict | Measured result |
|---|---|---|
| B1 | PASS | Per-rep rate 7999.52, 8000, 8000 /s. Per-rep p99 0.718, 0.371, 0.358 ms. Corrupt 0, errors 0. Target ≥5000 /s and p99 ≤10 ms. |
| B2 sequential | PASS | Lost cancel stays `COMMITTED` and is reported `lost`. Live cancel is `cancelled` / `CANCELLED`. Commit after cancel is fenced. Ignore-cancel returns `ignore` and the cancel times out. |
| B2 concurrent | PASS | `test:races` case `commit-vs-revoke`, 35.05 ms. The case requires the executor to hold the row first, the revoker to wait on `Lock` / `transactionid`, the commit to win, the cancel to lose, and the row to stay `COMMITTED`. |
| B3 | PASS | The partial cap is 32768 bytes. The scored fault is `partial-cap` at 36864 bytes, and `bound` is true because that count is the cap plus one 4096-byte read chunk. Pending, total, kernel, and RSS checks in the same case stayed inside their own bounds. |
| B4 | PASS | Oversize and never-terminated frames are typed errors. A malformed child does not kill its sibling. |
| B5 | PASS | Mid-call exit is `child-exited` (code 1). The retired token is refused. The respawn token is distinct and fenced. Status stays `ACTIVE`. |
| B6 | PASS | Hostile checks all true. Flood cancel p99 87.58, 66.59, 73.85 ms, each ≤ 500 ms. |
| Races | PASS | Every battery case passed. The designed-failure oracles (stalled shutdown, commit-vs-revoke vacuity, vacuity-authority) and the B6 identity-stamping vacuity fail in the way each oracle requires. |

## B1

Frozen shape: 2 children, in-flight 128, offered rate 8000/s, 1024-byte payload, warmup 5 s, window 60 s, 3 reps. Offered 480000 per rep. Issued 479971, 480000, 480000. Drops 29, 0, 0, counted as the call timeout inside p99. p99 stayed under 10 ms. Endpoints: kernel send → supervisor ingress → child egress → kernel return. Topology: in-process kernel stub, one socket pair, spawned children. Rep loads after the window: 1.16, 1.05, 1.02.

## B2

The four suite outcomes run one after another. Commit finishes before the lost revocation. Revocation finishes before the fenced commit. The ignore-cancel child times out. The race battery's recovery-vs-live-commit case is the sweeper's `ABANDONED` update against commit.

The concurrent clause is `commit-vs-revoke` in `test:races`. The executor holds `SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE` inside the effects transaction, and `cancelExecution` issues the `CANCELLED` update on a second pooled connection. The case waits until that update is on `Lock` / `transactionid`, then requires the commit to win and the cancel to lose. This run passed in 35.05 ms. The following case finishes the cancel first: the overlap oracle fails, the row is `CANCELLED`, and the executor is fenced. That case passed in 29.17 ms.

## B3

§3.0 history, then this rerun. The verdict is the rerun.

1. **Original FAIL.** On dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766`, the scored partial object was `pendingBytes` 1052672, `NdjsonOversizeError`, `bound` true, cap configured as `32 * 1024`. Three later `tripCaps()` calls on that same harness returned the same byte count, the same code, `tripped` true, and `bound` true.
2. **Root cause.** `tripCaps()` passes `partial: 32 * 1024` and does not set a separate high-water, so the high-water is 32768. On that SHA, `Supervisor.#accountCaps` set `caps.partial` when `pendingBytes` reached that mark and then kept reading. `NdjsonFramer` throws once an unfinished line passes 1 MiB + 1 byte. The fault stored `pendingBytes` after the chunk that crossed the limit. 1052672 = 1048576 + 4096. `bound` was `pendingBytes < 2 * 1024 * 1024`, so the suite printed a pass at about 32 times the named cap.
3. **Not noise.** Those three diagnostic runs and that scored spike agreed on 1052672. No database setting is on this path.
4. **Fix.** Pull request #47, now dev `1b1f536c6fa874369ce1d30e9337f4224961be93`, faults when an unfinished frame passes the configured partial cap. The only overshoot is one read chunk, 4096 bytes. The B3 bound is `pendingBytes` against that cap plus the chunk, and the fault code is `partial-cap`. The framer still throws `NdjsonOversizeError` once the residual is greater than 1 MiB + 1 byte.
5. **This rerun.** The scored partial object is `pendingBytes` 36864, `partial-cap`, `bound` true. 36864 = 32768 + 4096. That is the cap plus one read chunk.

The other measurements in this same case: pending admitted 4 and rejected 4; total cap tripped with buffered 0; the kernel socket pause admitted one call (270 buffered bytes) and rejected a frame above the kernel byte cap before a waiter was installed. RSS growth was 507904, 466944, and 1605632 bytes, each at or under 67108864.

This PASS closes the replacement-validation track in the section below. The plan §8 re-spike track was opened by the original FAIL and closed by this rerun.

Each hold warmed 5005 ms, 5005 ms, and 5004 ms, then offered 300 slots (issued 300, skipped 0). Pending, partial, total, lo, and hi flags tripped on every hold, and the near-cap checks stayed true. The sibling answered. Growth for the three holds is in the B3 row. Each hold remains under 64 MiB. The environment stayed valid (loads 0.98, 1.17, 1.07).

## B4, B5, B6

B4: malformed child `NdjsonFramingError`, sibling process alive and round-tripped. Never-terminated frame `NdjsonOversizeError`, pending bytes 1049600, `pastFramer` true, bounded, sibling round-tripped. That case sets the partial cap to 1 MiB + 1 byte, so the framer's typed error is the fault. Mux length above 1 MiB: `MuxOversizeError`, limit 1048576, sibling process alive, reachable false.

B5 does not claim the sweeper. The crash leaves the row `ACTIVE`, and the respawned child cannot reuse the token.

B6 hostile checks: routing, forged, mismatch, collision, stale, all true. Starvation: 2 rejects on the silent child; the sibling completed before and after the deadline reclaimed the slot (`timeout`). Forged-result flood faulted at the hi cap (8) and the sibling still answered. Flood contract: 2 children, cancel rate 20/s, warmup 5 s, window 60 s, 3 reps. Per rep: 1200 samples, 0 timeouts, 0 skipped (offered = issued = 1200). Flood rates over the scored window: 172983/s, 176200/s, 178253/s, each above the 10000/s minimum. Rep loads after the window: 0.71, 0.90, 1.18.

The identity-stamping vacuity control is a pass of the runner because the exploit lands: `stampIdentity: false`, forged payload delivered, `exploit: true`, and the variant's own pass bit is false. Routing, mismatch, and stale stay true. Forged and collision are false. `test:races` repeats that control once, and it passed.

## Recovery story

ADR-0004 cites this section. The label above applies to all of it: the authority row is the minimal real authority, and the full broker proof remains P2 acceptance.

Cadence is 5 s and the lease is 20 s. Renewal traffic for the capacity annex is about `active executions / cadence` UPDATE transactions per second. Smoke, on the pooled main path, recorded 2 renewals in a 12 s effects phase (last renewal-to-lock 2003 ms) and 3 renewals in a 16 s phase (1006 ms). A slow renewal that held the row lock measured last renewal-to-lock 2 ms and lock wait 2010 ms, inside the 5000 ms bound.

| Case | Suite result | What the passing oracle required |
|---|---|---|
| death-before-commit | PASS (99 ms) | Expired `ACTIVE` becomes `ABANDONED` with zero effects. |
| lost-reply | PASS (66 ms) | A retry reads `COMMITTED`. |
| recovery-vs-live-commit | PASS (172 ms) | Sweeper and executor: exactly one transition wins. |
| healthy-long | PASS (46288 ms) | Effects wall is between 25 s and 30 s, above the 20 s lease, with the sweeper active. The renewal-suppressed variant is abandoned at or after the lease. |
| stalled shutdown | Designed failure of the renewal-to-lock oracle (11134 ms) | The case's pass bit is false, the row still commits, and last renewal-to-lock exceeds the 5 s cadence. |
| heartbeat-behind-commit | PASS (5051 ms) | Completion stays inside the bound. |
| saturated-pool | PASS (21423 ms) | 10 executors, each held past the lease, no bound violation, renewal-to-lock at or under the cadence. This is the reserved-path proof at concurrency equal to `default_pool_size`. |
| queued-past-lease | PASS (54 ms) | A `QUEUED` row older than the lease stays `QUEUED` and is not swept. An `ACTIVE` row expired the same way is swept to `ABANDONED`. |
| second-executor-takeover | PASS (146 ms) | After `COMMITTED`, `CANCELLED`, and `ABANDONED`, a second executor with the stale token loses the conditional update: fenced, status unchanged, takeover effects 0. The `COMMITTED` row keeps its one settled effect. |
| commit-vs-revoke | PASS (35 ms) | The executor holds the row first. The revoker waits on `Lock` / `transactionid`. The commit wins, the cancel loses, and the row stays `COMMITTED`. |
| commit-vs-revoke vacuity | Designed failure of the overlap oracle (29 ms) | The cancel finishes before the executor starts. The overlap oracle fails. The row is `CANCELLED` and the executor is fenced. |
| vacuity-authority | Designed failure (266 ms) | With the `status='ACTIVE'` predicate removed, the open variant loses the race (`ABANDONED` on the executor, `COMMITTED` on the sweeper, effects present). The real predicate still commits. |

## Replacement-validation track

The original B3 FAIL opened the plan §8 re-spike track: enforce the partial cap, then rerun B3. Pull request #47 is that enforcement. This rerun is the re-spike, and B3 passes, so the track is closed. The flow-control hypothesis is accepted on this run. A substrate redesign is not required by this result.

B1, B2, B4, B5, B6, and the race battery stay on framed NDJSON, the supervisor-stamped credential, and the conditional authority row. A1 pooled and A3 stay NOT DEMONSTRATED for the same missing pooled raw-`pg` control. Issue #14 owns that control and the A1 and A3 rerun, and this pull request does not close #14. ADR-0002 does not treat those two clauses as complete. That gap does not open a second track. A4b stays issue #34.

### Revised capacity note

T7 still writes the annex. This note is what the closed re-spike attaches.

The enforced partial cap in the passing B3 case is 32768 bytes per child. This run faulted at 36864 bytes, the cap plus one 4096-byte read chunk. The per-host partial-buffer bound is `32768 × children` bytes, plus at most `4096 × children` for that read chunk. The scored `tripCaps` partial child is one child, so the bound for that child is 32768 bytes and the fault landed at 36864.

Renewal traffic stays `active executions / cadence` UPDATE transactions per second. RSS growth on the three holds was 507904, 466944, and 1605632 bytes, each ≤ 67108864, after the partial fault had already fired. This note does not compute the rest of the T7 annex.
