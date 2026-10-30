# Spike B report

Verdicts for plan §4 B1–B6 and the T5c race battery. The B3 verdict is the replacement validation on 2026-10-29: three `spike:b3` invocations on Node v24.22.2, the major in `.nvmrc`, under the frozen contract. Both buffer caps hold. The 2026-10-18 section is the failed substrate (partial high-water 69632; accounted totals 106496, 57344, and 155648) on the tree of that commit (parent `281f9d3a6e29fd57f6ece14fd255abd4667b41be`). B1, B4, and B6 were rerun on that substrate and passed. B2, B5, and the race battery were rerun on 2026-10-30 on revision `38949baebd8e28690d90c5c3d2fb56e706e80e8a` (pull request #85, the shipped substrate) and passed. The invalid pooled login from 2026-10-18 is recorded in the Spike A report and is not a B verdict.

Evidence label, verbatim: "transport + minimal-real-authority; full broker proof remains P2 acceptance".

## Rerun

### Replacement validation (2026-10-29)

Node v24.22.2. These four commands do not open the database. Each performance case uses the frozen contract inside the case. `spike:b3` was invoked three times. Each printed `frozen warmupMs=5000 windowMs=60000 reps=3` and exited 0.

```bash
pnpm --filter @plerni-spike/ipc-harness spike:b3
pnpm --filter @plerni-spike/ipc-harness spike:b1
pnpm --filter @plerni-spike/ipc-harness spike:b4
pnpm --filter @plerni-spike/ipc-harness spike:b6
```

`spike:b1` and `spike:b6` each printed that same frozen line and exited 0. `spike:b4` exited 0. The harness test `both buffer-cap failures reproduce without enforcement and hold with it` passed on this runtime. It replays the recorded partial high-water 69632 and the recorded totals 106496, 57344, and 155648, and they still miss both caps. The live unenforced trip misses both clauses. The enforced trip holds both.

### Authority rerun (2026-10-30)

Revision `38949baebd8e28690d90c5c3d2fb56e706e80e8a`. Node v24.22.2. The four harness passwords were exported and are not recorded. The schema is `tools/harness/sql/001`–`003`. `spike:b2` and `spike:b5` are the package scripts, which take no window, repetition, or preflight override. `test:races` is the package script, concurrency 1, including the B6 identity-stamping vacuity control.

```bash
pnpm --filter @plerni-spike/ipc-harness spike:b2
pnpm --filter @plerni-spike/ipc-harness spike:b5
pnpm --filter @plerni-spike/ipc-harness test:races
```

`spike:b2` exited 0:

```text
[PASS] b2-fencing — {"lost":"lost","lostStatus":"COMMITTED","ack":"cancelled","ackStatus":"CANCELLED","fenceAck":"cancelled","fenced":true,"fenceStatus":"CANCELLED","ignoreResult":"ignore","ignoreCancelCode":"timeout"}
```

`spike:b5` exited 0:

```text
[PASS] b5-crash — {"crash":{"code":"child-exited","exitCode":1},"token":{"refused":true,"newTokenFenced":true,"status":"ACTIVE","distinct":true}}
```

`test:races` exited 0. 26 pass, 0 fail, 0 skipped, duration_ms 92037.198245, then the B6 vacuity control 1 pass, duration_ms 1832.037559. `commit-vs-revoke` passed in 22.75 ms. The overlap case passed in 19.53 ms. No case was skipped, so each one opened the harness database.

### 2026-10-18

The scored commands are separate. Export the four harness passwords first. Node is the major in `.nvmrc` (that run: v24.22.0). `reset.sh` needs Docker Compose v2 and `psql`. `spike:b3` exits 1 on that tree, so joining it to the other two with `&&` would not run them.

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

The 2026-10-29 replacement runs are Linux, 4 CPUs, quota unlimited, not throttled, not overloaded. Every preflight and every `envAfter` was `valid: true`. B3 starting loads were 0.01, 0.87, and 0.97. B1 started at 0.88. B6 started at 1.06. No performance case returned `invalid`.

The 2026-10-30 authority rerun is Linux, 4 CPUs. Load was 0.10 at `spike:b2`, 0.09 before `test:races`, and 0.14 after it. PostgreSQL 18.6 and PgBouncer 1.26.0, the versions the harness pins, on the harness ports. `SHOW VERSION` reported PgBouncer 1.26.0. `current_setting('server_version')` reported 18.6. `SHOW CONFIG` reported `pool_mode=transaction`, `max_prepared_statements=200`, `default_pool_size=10`, `server_reset_query=DISCARD ALL`, `server_reset_query_always=0`, and an empty `track_extra_parameters`. This run did not start those services from the compose file. B2 and B5 are not windowed performance cases. The race battery's `healthy-long` wall was 46398.54 ms, inside 25 s to 30 s.

The 2026-10-18 harness was PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`, `default_pool_size=10`. The first preflight printed by the `1b1f536` spike is the B6 flood environment: 4 CPUs, quota unlimited, load 0.14, not throttled, not overloaded, `valid: true`. Smoke recorded `mainPath: pooled`. Renewals use the reserved direct connection. Each scored performance repetition from that suite has `envAfter.valid: true`. The parent's three total-buffer invocations had preflight `valid: true`, with starting loads 0.30, 0.95, and 1.01. That commit's three partial invocations also had preflight `valid: true`, with starting loads 0.05, 0.87, and 1.

## Verdicts

| ID | Verdict | Measured result |
|---|---|---|
| B1 | PASS | Replacement rerun. Per-rep rate 7999.98, 8000, 7998.12 /s. Per-rep p99 4.048, 4.392, 4.990 ms. Corrupt 0, errors 0. Target ≥5000 /s and p99 ≤10 ms. |
| B2 sequential | PASS | Authority rerun on `38949baebd8e28690d90c5c3d2fb56e706e80e8a`. Lost cancel stays `COMMITTED` and is reported `lost`. Live cancel is `cancelled` / `CANCELLED`. Commit after cancel is fenced. Ignore-cancel returns `ignore` and the cancel times out. |
| B2 concurrent | PASS | This rerun's `test:races` case `commit-vs-revoke`, 22.75 ms. The executor holds the row first, the revoker waits on `Lock` / `transactionid`, the commit wins, the cancel loses, and the row stays `COMMITTED`. |
| B3 | PASS | Enforced partial high-waters 23488, 25728, and 23488, each ≤ 32768, code `partial-cap`. Enforced accounted totals 32480, 34336, and 33184, each ≤ 49152. `stdoutUnread` 384 ≤ `K_in` 6848. The same-host unenforced control fails both clauses. RSS growth ≤ 67108864 (largest 14475264). |
| B4 | PASS | Replacement rerun. Malformed child `NdjsonFramingError`, sibling alive. Never-terminated frame `NdjsonOversizeError`, pending bytes 1048590, `pastFramer` true. Mux `MuxOversizeError`. |
| B5 | PASS | Authority rerun. Mid-call exit is `child-exited` (code 1). The retired token is refused. The respawn token is distinct and fenced. Status stays `ACTIVE`. |
| B6 | PASS | Replacement rerun. Hostile checks all true. Flood cancel p99 44.54, 1.56, 1.74 ms, each ≤ 500 ms. |
| Races | PASS | Authority rerun. 26 pass, 0 fail, 0 skipped, duration_ms 92037.198245, then the B6 vacuity control 1 pass, duration_ms 1832.037559. The designed-failure oracles (stalled shutdown, commit-vs-revoke vacuity, vacuity-authority) and the B6 identity-stamping vacuity fail in the way each oracle requires. |

## B1

The replacement rerun is the verdict. Same frozen shape: 2 children, in-flight 128, offered rate 8000/s, 1024-byte payload, warmup 5 s, window 60 s, 3 reps. Completions 479999, 480000, 479887. Rates 7999.98, 8000, 7998.12 /s. p99 4.048, 4.392, 4.990 ms. Corrupt 0, errors 0. Endpoints: kernel send → supervisor ingress → child egress → kernel return. Topology: in-process kernel stub, one socket pair, spawned children. Rep loads after the window: 1.32, 1.10, 1.15, each `valid: true`.

The 2026-10-18 run on dev `1b1f536` was the same shape. Offered 480000 per rep. Issued 479971, 480000, 480000. Drops 29, 0, 0. p99 0.718, 0.371, 0.358 ms. Rep loads after the window: 1.16, 1.05, 1.02. That run is not the verdict.

## B2

The 2026-10-30 rerun is the verdict. The four suite outcomes run one after another. Commit finishes before the lost revocation. Revocation finishes before the fenced commit. The ignore-cancel child times out. The race battery's recovery-vs-live-commit case is the sweeper's `ABANDONED` update against commit.

The concurrent clause is `commit-vs-revoke` in `test:races`. The executor holds `SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE` inside the effects transaction, and `cancelExecution` issues the `CANCELLED` update on a second pooled connection. The case waits until that update is on `Lock` / `transactionid`, then requires the commit to win and the cancel to lose. This rerun passed in 22.75 ms. The following case finishes the cancel first: the overlap oracle fails, the row is `CANCELLED`, and the executor is fenced. That case passed in 19.53 ms. The 2026-10-18 figures for those two cases were 28.79 ms and 22.73 ms. Those figures are not this verdict.

## B3

§3.0 history of the failed substrate. The verdict is the replacement validation below.

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

Those two clauses were FAIL on that substrate. The high-water, `pendingBytes` plus `inFlightTailBytes`, was 69632 in all three runs, above 36864. The total-buffer clause was FAIL. The 36864-byte framer fault closed the earlier oversize defect and does not cover the tail. Per plan §8 that FAIL opened the replacement-validation track. The maintainer's choice, recorded in ADR-0006, is the flow-control redesign. The measured per-child bound (caps + one read chunk + kernel socket receive buffer) was not accepted. The replacement validation below records the B3 replacement evidence as PASS. The 2026-10-30 authority rerun is also PASS. ADR-0006 is Accepted on that pair.

On the parent measurement, each invocation's three holds warmed about 5003–5006 ms, then offered 300 slots (issued 300, skipped 0). Pending, partial, total, lo, and hi flags tripped on every hold, and the near-cap checks stayed true. The sibling answered. RSS growth stayed at or under 67108864 (largest sample 17641472). The environment stayed valid. Those holds do not repair the total-cap bound on that substrate.

## B4, B5, B6

The replacement rerun is the B4 and B6 verdict. The 2026-10-30 authority rerun is the B5 verdict.

B4: malformed child `NdjsonFramingError`, sibling process alive and round-tripped. Never-terminated frame `NdjsonOversizeError`, pending bytes 1048590, `pastFramer` true, bounded, sibling round-tripped. The fault is the framer's typed error, not `partial-cap`. Mux length above 1 MiB: `MuxOversizeError`, limit 1048576, sibling process alive, reachable false.

The 2026-10-18 B4 never-terminated pending bytes were 1049600, with the partial cap set to 1 MiB + 1 byte. That figure is not this rerun.

B5 does not claim the sweeper. The 2026-10-30 run left the row `ACTIVE`. The crash code is `child-exited` with exit code 1. The retired token is refused, the respawn token is distinct, and a commit with that new token is fenced. The 2026-10-18 run reported the same outcomes. That run is not the verdict.

B6 hostile checks: routing, forged, mismatch, collision, stale, all true. Starvation: 2 rejects on the silent child; the sibling completed before and after the deadline reclaimed the slot (`timeout`). Forged-result flood faulted at the hi cap (8), depth 0, and the sibling still answered. Flood contract: 2 children, cancel rate 20/s, warmup 5 s, window 60 s, 3 reps. Per rep: 1200 samples, 0 timeouts, 0 skipped (offered = issued = 1200). Cancel p99 44.54, 1.56, 1.74 ms. Scored flood rates 99813, 107785, 108312 /s. Bulk rates 220767, 237729, 238347 /s. Each pair is above the 10000/s minimum. Rep loads after the window: 1.25, 1.08, 1.03, each `valid: true`.

The 2026-10-18 flood cancel p99 was 87.58, 66.59, 73.85 ms, and the flood rates over that window were 172983/s, 176200/s, 178253/s. Rep loads after that window were 0.71, 0.90, 1.18. That run is not the verdict.

The identity-stamping vacuity control is a pass of the runner because the exploit lands: `stampIdentity: false`, forged payload delivered, `exploit: true`, and the variant's own pass bit is false. Routing, mismatch, and stale stay true. Forged and collision are false. `test:races` repeats that control once. The 2026-10-30 repeat passed in 1758.68 ms.

## Recovery story

ADR-0004 cites this section. The label above applies to all of it: the authority row is the minimal real authority, and the full broker proof remains P2 acceptance.

Cadence is 5 s and the lease is 20 s. Renewal traffic is about `active executions / cadence` UPDATE transactions per second. Issue #15 withdrew the schedule annex that would have consumed this figure. Smoke, on the pooled main path, recorded 2 renewals in a 12 s effects phase (last renewal-to-lock 2003 ms) and 3 renewals in a 16 s phase (1006 ms). A slow renewal that held the row lock measured last renewal-to-lock 2 ms and lock wait 2010 ms, inside the 5000 ms bound. Those smoke figures are the 2026-10-18 run. This rerun did not repeat smoke.

The durations below are the 2026-10-30 `test:races` reporter. The 2026-10-18 durations for the same cases were 89, 64, 159, 46377, 11072, 5068, 21451, 57, 145, 29, 23, and 285 ms. Those figures are not this verdict.

| Case | Suite result | What the passing oracle required |
|---|---|---|
| death-before-commit | PASS (71.90 ms) | Expired `ACTIVE` becomes `ABANDONED` with zero effects. |
| lost-reply | PASS (54.56 ms) | A retry reads `COMMITTED`. |
| recovery-vs-live-commit | PASS (146.39 ms) | Sweeper and executor: exactly one transition wins. |
| healthy-long | PASS (46398.54 ms) | Effects wall is between 25 s and 30 s, above the 20 s lease, with the sweeper active. The renewal-suppressed variant is abandoned at or after the lease. |
| stalled shutdown | Designed failure of the renewal-to-lock oracle (11218.52 ms) | The case's pass bit is false, the row still commits, and last renewal-to-lock exceeds the 5 s cadence. |
| heartbeat-behind-commit | PASS (5049.35 ms) | Completion stays inside the bound. |
| saturated-pool | PASS (21310.30 ms) | 10 executors, each held past the lease, no bound violation, renewal-to-lock at or under the cadence. This is the reserved-path proof at concurrency equal to `default_pool_size`. |
| queued-past-lease | PASS (49.98 ms) | A `QUEUED` row older than the lease stays `QUEUED` and is not swept. An `ACTIVE` row expired the same way is swept to `ABANDONED`. |
| second-executor-takeover | PASS (128.75 ms) | After `COMMITTED`, `CANCELLED`, and `ABANDONED`, a second executor with the stale token loses the conditional update: fenced, status unchanged, takeover effects 0. The `COMMITTED` row keeps its one settled effect. |
| commit-vs-revoke | PASS (22.75 ms) | The executor holds the row first. The revoker waits on `Lock` / `transactionid`. The commit wins, the cancel loses, and the row stays `COMMITTED`. |
| commit-vs-revoke vacuity | Designed failure of the overlap oracle (19.53 ms) | The cancel finishes before the executor starts. The overlap oracle fails. The row is `CANCELLED` and the executor is fenced. |
| vacuity-authority | Designed failure (223.29 ms) | With the `status='ACTIVE'` predicate removed, the open variant loses the race (`ABANDONED` on the executor, `COMMITTED` on the sweeper, effects present). The real predicate still commits. |

## Replacement validation

The original B3 FAIL opened the plan §8 track. Pull request #47 faulted the framer residual at 36864 bytes and left the tail outside the cap. The partial high-water on that substrate was 69632. The accounted totals were 106496, 57344, and 155648. ADR-0006 rejects those figures as the cap and reserves the writer-end ceiling plus one read inside each cap. This section is that re-spike on the shipped harness. It is not a schedule. Issue #15 withdrew the capacity annex. T7 stays the contributor roadmap (`docs/ROADMAP.md`).

Command `pnpm --filter @plerni-spike/ipc-harness spike:b3`, three invocations, each exit 0. Frozen warmup 5000 ms, window 60000 ms, 3 reps. Preflights: 4 CPUs, quota unlimited, not throttled, not overloaded, `valid: true`, starting loads 0.01, 0.87, and 0.97.

The enforced trip, one child, caps 32768 and 49152:

| Run | Partial high-water | `pendingBytes` | `stdoutUnread` | Accounted total | `afterCleanup` | Vacuity |
|---|---:|---:|---:|---:|---:|---|
| 1 | 23488 | 23104 | 384 | 32480 | 0 | true |
| 2 | 25728 | 25344 | 384 | 34336 | 0 | true |
| 3 | 23488 | 23104 | 384 | 33184 | 0 | true |

Each partial fault is `partial-cap` with `bound` true and in-flight tail 0. 23488 and 25728 are ≤ 32768. Each accounted total is ≤ 49152. `stdoutUnread` 384 is ≤ `K_in` 6848. `stdinQueued` was 32, ≤ `K_out` 6848. The post-cleanup count is 0 and does not satisfy the bound.

Same host, enforcement removed (default socket, libuv reads). Both clauses miss. Socket capacity 131072 on every run:

| Run | Partial high-water | Accounted total |
|---|---:|---:|
| 1 | 180224 | 110592 |
| 2 | 114688 | 143360 |
| 3 | 180224 | 167936 |

Each is above its cap. The control is a scored FAIL, not `invalid` and not `unsatisfiable`.

Each invocation's three holds warmed 4999–5001 ms, then offered 300 slots (issued 300, skipped 0). Pending, partial, total, lo, and hi flags tripped on every hold, and the near-cap checks stayed true. The sibling answered. RSS growth on the nine holds was 7258112, 14475264, 385024, 7307264, 13000704, 401408, 5869568, 13418496, and 651264. The largest is 14475264, under 67108864. Every `envAfter` was valid.

`getsockopt(SO_SNDBUF)` on both writer ends was 4608. `K_in` and `K_out` were 6848, which is `4608 + (4608 >> 1) - 64`. `C` was 4096. `K_mux_in` was 4096 and `K_mux_out` was 4608, the read-back before connect. `B_p` was 21824 and `B_t` was 31360, both ≥ 0. At `totalGlobal` 1048576, `S` is 1035776. One runner, so `R` is 1. The per-process bound is `min(N × T + S + K_mux_in + K_mux_out + C, totalGlobal)`, which is 1048576 for both the default caps and the trip caps.

B1 on the frozen shape passed (about 8000/s, p99 under 5 ms). That is not the flip. B4's never-terminated frame was `NdjsonOversizeError`, not `partial-cap`. B6 sibling cancel p99 stayed under 500 ms. B2, B5, and the race battery passed on the 2026-10-30 rerun of this revision. A4b PASS (#58, #34 closed). ADR-0006 is Accepted.

The recorded snapshots still fail the bound: partial 69632 at cap 32768, and totals 106496, 57344, and 155648 at cap 49152. The enforced runs above are what hold.
