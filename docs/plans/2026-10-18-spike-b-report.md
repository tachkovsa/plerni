# Spike B report

Verdicts for plan §4 B1–B6 and the T5c race battery. The partial high-water was rerun on 2026-10-18 as three `spike:b3` invocations on the tree of this commit (parent `281f9d3a6e29fd57f6ece14fd255abd4667b41be`). The total-buffer figures stay the three accounted totals measured on that parent. B1, B4, B5, and B6 stay the 2026-10-18 run at dev `1b1f536c6fa874369ce1d30e9337f4224961be93` (pull request #47). `test` and `test:races` were rerun on this commit. The invalid pooled login from earlier that day is recorded in the Spike A report and is not a B verdict.

Evidence label, verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance".

## Rerun

The scored commands are separate. Export the four harness passwords first. Node is the major in `.nvmrc` (this run: v24.22.0). `reset.sh` needs Docker Compose v2 and `psql`. `spike:b3` exits 1, so joining it to the other two with `&&` would not run them.

```bash
pnpm --filter @plerni-spike/ipc-harness spike:b3
```

Exit 1 on each of three invocations. That script calls `b3()` with no window, repetition, or preflight override. The frozen contract is warmup 5000 ms, window 60000 ms, 3 reps. JSONL stays gitignored. The lines that back these verdicts are in `docs/plans/2026-10-18-spike-rerun-evidence.md`.

```bash
pnpm --filter @plerni-spike/ipc-harness test
```

Exit 0. 114 pass, 0 fail, 0 skipped, duration_ms 23631.451671. `test` scores the deterministic B2–B6 checks and does not apply the 60 s contract.

```bash
pnpm --filter @plerni-spike/ipc-harness test:races
```

Exit 0. 26 pass, 0 fail, 0 skipped, duration_ms 92184.704125, then the B6 vacuity control 1 pass, duration_ms 1662.383168. `test:races` includes `commit-vs-revoke`. That case is the concurrent clause.

The dev `1b1f536` suite, covered by the receipt below, was a different tree: `spike` exit 0, then `test` 108 pass, 0 fail, 0 skipped, 23311 ms, then `test:races` 26 pass, 0 fail, 0 skipped, 92167 ms, then the B6 vacuity control 1 pass, 1663 ms. That 108-test figure is not this commit.

Review receipt: REV-T6-2026-10-19-9cf9740 covers B1, B2, B4, B5, B6, the race battery, and the partial-cap history through the framer-residual rerun. The B3 total-buffer measurement and this commit's partial high-water are pending (δ).

## Environment

Same pinned harness as the Spike A report: PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`, `default_pool_size=10`. The first preflight printed by the `1b1f536` spike is the B6 flood environment: 4 CPUs, quota unlimited, load 0.14, not throttled, not overloaded, `valid: true`. Smoke recorded `mainPath: pooled`. Renewals use the reserved direct connection. Each scored performance repetition from that suite has `envAfter.valid: true`. The parent's three total-buffer invocations had preflight `valid: true`, with starting loads 0.30, 0.95, and 1.01. This commit's three partial invocations also had preflight `valid: true`, with starting loads 0.05, 0.87, and 1. No performance case returned `invalid`.

## Verdicts

| ID | Verdict | Measured result |
|---|---|---|
| B1 | PASS | Per-rep rate 7999.52, 8000, 8000 /s. Per-rep p99 0.718, 0.371, 0.358 ms. Corrupt 0, errors 0. Target ≥5000 /s and p99 ≤10 ms. |
| B2 sequential | PASS | Lost cancel stays `COMMITTED` and is reported `lost`. Live cancel is `cancelled` / `CANCELLED`. Commit after cancel is fenced. Ignore-cancel returns `ignore` and the cancel times out. |
| B2 concurrent | PASS | This commit's `test:races` case `commit-vs-revoke`, 28.79 ms. The case requires the executor to hold the row first, the revoker to wait on `Lock` / `transactionid`, the commit to win, the cancel to lose, and the row to stay `COMMITTED`. |
| B3 | FAIL | Partial cap does not hold. Code `partial-cap`. Framer residual `pendingBytes` 36864, in-flight tail 32768, high-water 69632 in all three invocations, above the 32768-byte cap plus one 4096-byte read chunk (36864). Total cap 49152 bytes does not. Accounted bytes (high-water, including the chunk tail, plus FIONREAD) were 106496, 57344, and 155648. The allowed overshoot is one 4096-byte read chunk (53248). All three are above it. |
| B4 | PASS | Oversize and never-terminated frames are typed errors. A malformed child does not kill its sibling. |
| B5 | PASS | Mid-call exit is `child-exited` (code 1). The retired token is refused. The respawn token is distinct and fenced. Status stays `ACTIVE`. |
| B6 | PASS | Hostile checks all true. Flood cancel p99 87.58, 66.59, 73.85 ms, each ≤ 500 ms. |
| Races | PASS | Every battery case passed. The designed-failure oracles (stalled shutdown, commit-vs-revoke vacuity, vacuity-authority) and the B6 identity-stamping vacuity fail in the way each oracle requires. |

## B1

Frozen shape: 2 children, in-flight 128, offered rate 8000/s, 1024-byte payload, warmup 5 s, window 60 s, 3 reps. Offered 480000 per rep. Issued 479971, 480000, 480000. Drops 29, 0, 0, counted as the call timeout inside p99. p99 stayed under 10 ms. Endpoints: kernel send → supervisor ingress → child egress → kernel return. Topology: in-process kernel stub, one socket pair, spawned children. Rep loads after the window: 1.16, 1.05, 1.02.

## B2

The four suite outcomes run one after another. Commit finishes before the lost revocation. Revocation finishes before the fenced commit. The ignore-cancel child times out. The race battery's recovery-vs-live-commit case is the sweeper's `ABANDONED` update against commit.

The concurrent clause is `commit-vs-revoke` in `test:races`. The executor holds `SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE` inside the effects transaction, and `cancelExecution` issues the `CANCELLED` update on a second pooled connection. The case waits until that update is on `Lock` / `transactionid`, then requires the commit to win and the cancel to lose. This commit's rerun passed in 28.79 ms. The following case finishes the cancel first: the overlap oracle fails, the row is `CANCELLED`, and the executor is fenced. That case passed in 22.73 ms.

## B3

§3.0 history, then this rerun. The verdict is the rerun.

1. **Original FAIL.** On dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766`, the scored partial object was `pendingBytes` 1052672, `NdjsonOversizeError`, `bound` true, cap configured as `32 * 1024`. Three later `tripCaps()` calls on that same harness returned the same byte count, the same code, `tripped` true, and `bound` true.
2. **Root cause.** `tripCaps()` passes `partial: 32 * 1024` and does not set a separate high-water, so the high-water is 32768. On that SHA, `Supervisor.#accountCaps` set `caps.partial` when `pendingBytes` reached that mark and then kept reading. `NdjsonFramer` throws once an unfinished line passes 1 MiB + 1 byte. The fault stored `pendingBytes` after the chunk that crossed the limit. 1052672 = 1048576 + 4096. `bound` was `pendingBytes < 2 * 1024 * 1024`, so the suite printed a pass at about 32 times the named cap.
3. **Not noise.** Those three diagnostic runs and that scored spike agreed on 1052672. No database setting is on this path.
4. **Fix.** Pull request #47, now dev `1b1f536c6fa874369ce1d30e9337f4224961be93`, faults when an unfinished frame passes the configured partial cap. The only overshoot is one read chunk, 4096 bytes. The B3 bound is `pendingBytes` against that cap plus the chunk, and the fault code is `partial-cap`. The framer still throws `NdjsonOversizeError` once the residual is greater than 1 MiB + 1 byte.
5. **This rerun.** The scored partial object is `pendingBytes` 36864, `partial-cap`, `bound` true. 36864 = 32768 + 4096. That is the cap plus one read chunk.

6. **Total-buffer oracle.** On dev `1b1f536` the scored total object was `buffered` 0 and `bound` true. `tripCaps` waited for `caps.total`, then called `bufferedBytes()`. `#fault` had already marked the child dead and replaced the framer, and `bufferedBytes()` skips dead children. The old bound was `buffered <= 48 * 1024 + 192 * 1024`, which is true of 0. That was an oracle defect, not a measured high-water.
7. **High-water, still short.** The next measurement read `bufferedBytes()` before marking the child dead. That count was 53248, the 49152-byte cap plus one 4096-byte read chunk, and the post-cleanup count was 0. The allowance also added an assumed 64 KiB. The unprocessed rest of the current stdout chunk was still a local buffer, and `#retainTail` drops that buffer once the child is dead. Bytes still sitting in the kernel socket were not in the count either.
8. **This measurement.** `#fault` adds that chunk tail to the high-water before the cleanup. It also reads FIONREAD on the child stdout fd. Child stdio on this runtime is a socket, so `F_GETPIPE_SZ` does not apply. The capacity beside the unread count is `SO_RCVBUF` on that same fd, measured per run, not a constant. The bound is `totalCapHolds`: the sum is above the 49152-byte cap and at most that cap plus one 4096-byte read chunk. The post-cleanup count remains the vacuity control.
9. **Three runs.** Command `pnpm --filter @plerni-spike/ipc-harness spike:b3`. Frozen warmup 5000 ms, window 60000 ms, 3 reps. Each exited 1. Accounted totals were 106496, 57344, and 155648. Each is above 53248. The smallest is the cap plus one read chunk of userspace (53248, tail 0) plus FIONREAD 4096. Socket capacity was 131072 on every run, and each unread count was within it (8192, 4096, 45056). `afterCleanup` was 0 and `vacuity` was true in every run. Partial stayed `partial-cap` at 36864 with `bound` true.
10. **Not noise.** All three preflights were valid (4 CPUs, quota unlimited, not throttled, not overloaded). The three accounted totals agree on the direction. No database setting is on this path.
11. **Oracle.** The hypothesis that the configured cap plus one read chunk covers the buffered bytes is false. Per plan §8 the B3 FAIL opens the replacement-validation track, and the maintainer's decision is pending between (a) accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer) and (b) a flow-control redesign. This round starts neither.

12. **Partial high-water.** Items 5 and 9 scored `pendingBytes` only. The fault already stored `inFlightTailBytes`, the unprocessed rest of the current stdout chunk. On this commit the scored high-water is the sum. `partialCapHolds` requires that sum to be above the 32768-byte cap and at most that cap plus one 4096-byte read chunk (36864).
13. **Three runs.** Command `pnpm --filter @plerni-spike/ipc-harness spike:b3`, recorded separately from `test` and `test:races`. Frozen warmup 5000 ms, window 60000 ms, 3 reps. Each exited 1. Each partial object was `pendingBytes` 36864, `inFlightTailBytes` 32768, `highWater` 69632, code `partial-cap`, `bound` false. 69632 = 36864 + 32768. The framer residual is the cap plus one read chunk. The tail is another 32768 bytes of the same unterminated frame. 69632 is above 36864.
14. **Not noise.** All three preflights were valid (4 CPUs, quota unlimited, not throttled, not overloaded; starting loads 0.05, 0.87, and 1). The three high-waters agree. No database setting is on this path.
15. **Oracle.** The hypothesis that the partial cap plus one read chunk covers the buffered partial frame is false once the tail is counted. Per plan §8 the B3 FAIL opens the replacement-validation track, and the maintainer's decision is pending between (a) accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer) and (b) a flow-control redesign. This round starts neither.

The partial-cap clause is FAIL. The high-water, `pendingBytes` plus `inFlightTailBytes`, is 69632 in all three runs, above 36864. The total-buffer clause is FAIL. The plan §8 re-spike for the partial cap was opened by the original FAIL. The 36864-byte framer fault closed the earlier oversize defect and does not cover the tail. The partial-cap track stays open. Per plan §8 the B3 FAIL opens the replacement-validation track, and the maintainer's decision is pending between (a) accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer) and (b) a flow-control redesign. This round starts neither.

On the parent measurement, each invocation's three holds warmed about 5003–5006 ms, then offered 300 slots (issued 300, skipped 0). Pending, partial, total, lo, and hi flags tripped on every hold, and the near-cap checks stayed true. The sibling answered. RSS growth stayed at or under 67108864 (largest sample 17641472). The environment stayed valid. Those holds do not repair the total-cap bound.

## B4, B5, B6

B4: malformed child `NdjsonFramingError`, sibling process alive and round-tripped. Never-terminated frame `NdjsonOversizeError`, pending bytes 1049600, `pastFramer` true, bounded, sibling round-tripped. That case sets the partial cap to 1 MiB + 1 byte, so the framer's typed error is the fault. Mux length above 1 MiB: `MuxOversizeError`, limit 1048576, sibling process alive, reachable false.

B5 does not claim the sweeper. The crash leaves the row `ACTIVE`, and the respawned child cannot reuse the token.

B6 hostile checks: routing, forged, mismatch, collision, stale, all true. Starvation: 2 rejects on the silent child; the sibling completed before and after the deadline reclaimed the slot (`timeout`). Forged-result flood faulted at the hi cap (8) and the sibling still answered. Flood contract: 2 children, cancel rate 20/s, warmup 5 s, window 60 s, 3 reps. Per rep: 1200 samples, 0 timeouts, 0 skipped (offered = issued = 1200). Flood rates over the scored window: 172983/s, 176200/s, 178253/s, each above the 10000/s minimum. Rep loads after the window: 0.71, 0.90, 1.18.

The identity-stamping vacuity control is a pass of the runner because the exploit lands: `stampIdentity: false`, forged payload delivered, `exploit: true`, and the variant's own pass bit is false. Routing, mismatch, and stale stay true. Forged and collision are false. `test:races` repeats that control once, and it passed.

## Recovery story

ADR-0004 cites this section. The label above applies to all of it: the authority row is the minimal real authority, and the full broker proof remains P2 acceptance.

Cadence is 5 s and the lease is 20 s. Renewal traffic is about `active executions / cadence` UPDATE transactions per second. Issue #15 withdrew the schedule annex that would have consumed this figure. Smoke, on the pooled main path, recorded 2 renewals in a 12 s effects phase (last renewal-to-lock 2003 ms) and 3 renewals in a 16 s phase (1006 ms). A slow renewal that held the row lock measured last renewal-to-lock 2 ms and lock wait 2010 ms, inside the 5000 ms bound.

| Case | Suite result | What the passing oracle required |
|---|---|---|
| death-before-commit | PASS (89 ms) | Expired `ACTIVE` becomes `ABANDONED` with zero effects. |
| lost-reply | PASS (64 ms) | A retry reads `COMMITTED`. |
| recovery-vs-live-commit | PASS (159 ms) | Sweeper and executor: exactly one transition wins. |
| healthy-long | PASS (46377 ms) | Effects wall is between 25 s and 30 s, above the 20 s lease, with the sweeper active. The renewal-suppressed variant is abandoned at or after the lease. |
| stalled shutdown | Designed failure of the renewal-to-lock oracle (11072 ms) | The case's pass bit is false, the row still commits, and last renewal-to-lock exceeds the 5 s cadence. |
| heartbeat-behind-commit | PASS (5068 ms) | Completion stays inside the bound. |
| saturated-pool | PASS (21451 ms) | 10 executors, each held past the lease, no bound violation, renewal-to-lock at or under the cadence. This is the reserved-path proof at concurrency equal to `default_pool_size`. |
| queued-past-lease | PASS (57 ms) | A `QUEUED` row older than the lease stays `QUEUED` and is not swept. An `ACTIVE` row expired the same way is swept to `ABANDONED`. |
| second-executor-takeover | PASS (145 ms) | After `COMMITTED`, `CANCELLED`, and `ABANDONED`, a second executor with the stale token loses the conditional update: fenced, status unchanged, takeover effects 0. The `COMMITTED` row keeps its one settled effect. |
| commit-vs-revoke | PASS (29 ms) | The executor holds the row first. The revoker waits on `Lock` / `transactionid`. The commit wins, the cancel loses, and the row stays `COMMITTED`. |
| commit-vs-revoke vacuity | Designed failure of the overlap oracle (23 ms) | The cancel finishes before the executor starts. The overlap oracle fails. The row is `CANCELLED` and the executor is fenced. |
| vacuity-authority | Designed failure (285 ms) | With the `status='ACTIVE'` predicate removed, the open variant loses the race (`ABANDONED` on the executor, `COMMITTED` on the sweeper, effects present). The real predicate still commits. |

## Replacement-validation track

The original B3 FAIL opened the plan §8 re-spike track for the partial cap. Pull request #47 is that enforcement. The framer residual on that rerun was 36864 bytes with code `partial-cap`. That closed the defect of reading until `NdjsonOversizeError`. This commit's partial high-water is 69632 bytes, so the partial clause is FAIL and the partial-cap track stays open. The total-buffer clause is now FAIL. Per plan §8 the B3 FAIL opens the replacement-validation track, and the maintainer's decision is pending between (a) accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer) and (b) a flow-control redesign. This round starts neither.

B1, B2, B4, B5, B6, and the race battery stay on framed NDJSON, the supervisor-stamped credential, and the conditional authority row. A1 pooled and A3 pass on this commit. A4b stays issue #34.

### Revised capacity note

Issue #15 later withdrew the capacity annex; T7 is the contributor roadmap (`docs/ROADMAP.md`). The partial-cap track stays open. This note is what that open track and the failed total-buffer rerun attach. It is not a schedule.

The enforced partial cap is 32768 bytes per child. The framer residual is 36864 bytes. The scored high-water, including the in-flight tail, is 69632 bytes in all three runs, above the cap plus one 4096-byte read chunk. The scored total cap is 49152 bytes for that one child, plus one 4096-byte read chunk. The three accounted totals were 106496, 57344, and 155648. The stdout socket's measured receive buffer was 131072 bytes. The cap does not cover the chunk tail plus the unread socket bytes.

Renewal traffic stays `active executions / cadence` UPDATE transactions per second. RSS growth on the holds stayed at or under 67108864. The largest sample was 17641472. This note does not compute a schedule. The annex that would have used these figures was withdrawn (issue #15).
