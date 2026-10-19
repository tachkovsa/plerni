# Spike rerun evidence (2026-10-18)

Backing lines for `2026-10-18-spike-a-report.md` and `2026-10-18-spike-b-report.md`. The A1–A4 suite and the B3 total-buffer figures are parent `281f9d3a6e29fd57f6ece14fd255abd4667b41be` (that tree's parent `60a233ac31ddd812a13e7d4f6d08fa54677f3877`). The partial high-water is this commit. B1, B4, B5, and B6 stay dev `1b1f536c6fa874369ce1d30e9337f4224961be93`. Node v24.22.0. PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`. JSONL stays gitignored. Passwords are not recorded.

Review receipt: REV-T6-2026-10-19-9cf9740 covers the `1b1f536` lines and the A5 citation. The lines from the parent and from this commit are pending (δ).

## Suite commands

From a clean worktree of the parent commit named above, after the four harness passwords are exported. The A command was run three times. Each invocation followed `reset.sh` and `seed.mjs`, exited 0, and wrote 39 JSONL rows with 0 failing cases.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/db-invariant spike
```

An earlier invocation on dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766` exited 1 with `client_login_timeout (server down)` before any pooled case. That run is the invalid-run record in the A report. It is not a verdict.

B3's scored command takes the frozen contract (warmup 5000 ms, window 60000 ms, 3 reps) and accepts no override:

```bash
pnpm --filter @plerni-spike/ipc-harness spike:b3
```

Three invocations. Each printed `frozen warmupMs=5000 windowMs=60000 reps=3` and exited 1.

On this commit the two commands are separate, because `spike:b3` exits 1:

```bash
pnpm --filter @plerni-spike/ipc-harness test
```

Exit 0. 114 pass, 0 fail, 0 skipped, duration_ms 23631.451671.

```bash
pnpm --filter @plerni-spike/ipc-harness test:races
```

Exit 0. 26 pass, 0 fail, duration_ms 92184.704125, then the B6 vacuity control 1 pass, duration_ms 1662.383168.

The dev `1b1f536` full suite, which the receipt covers, was a different command and a different `test` count (108 pass, duration_ms 23310.678471). That count is not this commit.

## A1–A4 and the battery

Three invocations. A1 pooled and A3 are PASS only because every invocation passed. Each pooled raw-pg row is a `pg.Client` on the pooled DSN. Each of its eight transactions keeps one backend pid.

Run 1, `tools/spikes/db-invariant/evidence/run-2026-10-18T22-36-37-072Z.jsonl`:

```text
[PASS] A1 @ pooled (raw-pg control) — {"via":"raw-pg","runs":[[53102,53102,53102],[53116,53116,53116],[53104,53104,53104],[53107,53107,53107],[53103,53103,53103],[53106,53106,53106],[53101,53101,53101],[53105,53105,53105]]}
[PASS] A3 contamination lifecycle @ pooled — {"retries":1,"boundedRetry":true,"cleanupMs":22,"backendGoneMs":5,"deadPid":53135,"replacementPid":53137}
[PASS] A4 unnamed-vs-named overhead @ direct — {"spread":{"min":13.9,"median":30.8,"p95":47.1,"mean":30.4,"meanUnrounded":30.419216753486232,"ci95Low":21.1,"ci95High":39.7},"decision":"mean-exceeds-20","a4bRequired":true}
[PASS] battery terminations == injected @ pooled(1) — {"injected":8,"terminated":8,"warmTailTerminations":0}
```

Run 2, `tools/spikes/db-invariant/evidence/run-2026-10-18T22-36-49-328Z.jsonl`:

```text
[PASS] A1 @ pooled (raw-pg control) — {"via":"raw-pg","runs":[[53259,53259,53259],[53260,53260,53260],[53269,53269,53269],[53270,53270,53270],[53255,53255,53255],[53256,53256,53256],[53257,53257,53257],[53258,53258,53258]]}
[PASS] A3 contamination lifecycle @ pooled — {"retries":1,"boundedRetry":true,"cleanupMs":26,"backendGoneMs":7,"deadPid":53289,"replacementPid":53291}
[PASS] A4 unnamed-vs-named overhead @ direct — {"spread":{"min":10.8,"median":29.5,"p95":48.1,"mean":27.3,"meanUnrounded":27.251529718183736,"ci95Low":18,"ci95High":36.5},"decision":"mean-exceeds-20","a4bRequired":true}
[PASS] battery terminations == injected @ pooled(1) — {"injected":8,"terminated":8,"warmTailTerminations":0}
```

Run 3, `tools/spikes/db-invariant/evidence/run-2026-10-18T22-37-01-938Z.jsonl`:

```text
[PASS] A1 @ pooled (raw-pg control) — {"via":"raw-pg","runs":[[53411,53411,53411],[53412,53412,53412],[53414,53414,53414],[53425,53425,53425],[53424,53424,53424],[53410,53410,53410],[53413,53413,53413],[53415,53415,53415]]}
[PASS] A3 contamination lifecycle @ pooled — {"retries":1,"boundedRetry":true,"cleanupMs":22,"backendGoneMs":5,"deadPid":53444,"replacementPid":53446}
[PASS] A4 unnamed-vs-named overhead @ direct — {"spread":{"min":-5.9,"median":28,"p95":39.2,"mean":25.7,"meanUnrounded":25.67475801681577,"ci95Low":16.7,"ci95High":34.6},"decision":"mean-exceeds-20","a4bRequired":true}
[PASS] battery terminations == injected @ pooled(1) — {"injected":8,"terminated":8,"warmTailTerminations":0}
```

A3's rollback was `22012` with context absent afterward in all three. A4 observed 75 statements and 0 non-empty names in all three.

## B3 total-buffer measurement on the parent

```bash
pnpm --filter @plerni-spike/ipc-harness spike:b3
```

Each invocation: `[run-b3] frozen warmupMs=5000 windowMs=60000 reps=3`, then exit 1. The allowed total is 49152 + 4096 = 53248. `pipeCapacity` is the measured `SO_RCVBUF` of the child stdout socket. These three accounted totals are the total-buffer verdict. This commit does not replace them.

```text
[FAIL] b3-backpressure total — {"buffered":98304,"inFlightTailBytes":45056,"pipeUnread":8192,"pipeCapacity":131072,"accounted":106496,"afterCleanup":0,"bound":false,"vacuity":true}
[FAIL] b3-backpressure total — {"buffered":53248,"inFlightTailBytes":0,"pipeUnread":4096,"pipeCapacity":131072,"accounted":57344,"afterCleanup":0,"bound":false,"vacuity":true}
[FAIL] b3-backpressure total — {"buffered":110592,"inFlightTailBytes":57344,"pipeUnread":45056,"pipeCapacity":131072,"accounted":155648,"afterCleanup":0,"bound":false,"vacuity":true}
```

Partial, under the oracle that scored `pendingBytes` only: 36864, `partial-cap`, `bound` true. RSS growth stayed ≤ 67108864. Largest sample 17641472. Preflight `valid` true on all three. The holds do not make the total bound true.

## Partial high-water on this commit

The same command, three more invocations, each exit 1. The scored high-water is `pendingBytes + inFlightTailBytes`. The allowed partial sum is 32768 + 4096 = 36864. Each preflight was `valid` true (loads 0.05, 0.87, and 1).

```text
[FAIL] b3-backpressure partial — {"pendingBytes":36864,"inFlightTailBytes":32768,"highWater":69632,"code":"partial-cap","bound":false}
[FAIL] b3-backpressure partial — {"pendingBytes":36864,"inFlightTailBytes":32768,"highWater":69632,"code":"partial-cap","bound":false}
[FAIL] b3-backpressure partial — {"pendingBytes":36864,"inFlightTailBytes":32768,"highWater":69632,"code":"partial-cap","bound":false}
```

## B1–B6 scored spike at dev 1b1f536

These lines are the earlier full suite, including that suite's `test` result of 108 passes. REV-T6-2026-10-19-9cf9740 covers them. They are not this commit's `test` output and they are not the B3 verdict. The total object here is the post-cleanup 0 that the section above replaces.

```text
[PASS] b2-fencing — {"lost":"lost","lostStatus":"COMMITTED","ack":"cancelled","ackStatus":"CANCELLED","fenceAck":"cancelled","fenced":true,"fenceStatus":"CANCELLED","ignoreResult":"ignore","ignoreCancelCode":"timeout"}
[PASS] b1-throughput — {"achieved":[7999.516666666666,8000,8000],"p99s":[0.7175700000079814,0.37075100000947714,0.3581959999864921],"offered":[480000,480000,480000],"issued":[479971,480000,480000],"drops":[29,0,0]}
[PASS] b3-backpressure — {"limit":67108864,"caps":{"pending":{"tripped":true,"admitted":4,"rejected":4},"partial":{"tripped":true,"pendingBytes":36864,"code":"partial-cap","bound":true},"total":{"tripped":true,"buffered":0,"bound":true},"kernel":{"tripped":true,"occupied":1,"buffered":270,"bound":true},"kernelBytes":{"tripped":true,"buffered":0,"bound":true}},"growth":[507904,466944,1605632]}
[PASS] b4-bounds — {"malformed":{"code":"NdjsonFramingError","processAlive":true,"siblingRoundTrip":true},"neverTerminated":{"code":"NdjsonOversizeError","pendingBytes":1049600,"pastFramer":true,"bounded":true,"siblingRoundTrip":true},"oversize":{"code":"MuxOversizeError","limit":1048576,"processAlive":true,"reachable":false}}
[PASS] b5-crash — {"crash":{"code":"child-exited","exitCode":1},"token":{"refused":true,"newTokenFenced":true,"status":"ACTIVE","distinct":true}}
[PASS] b6-mux-identity — {"hostile":{"pass":true,"checks":{"routing":true,"forged":true,"mismatch":true,"collision":true,"stale":true}},"flood":{"p99s":[87.58096900000237,66.58624699999928,73.85078700000304],"floodRate":[172983.35,176199.96666666667,178253.2]}}
[PASS] smoke — {"mainPath":"pooled","authority":"PASS"}
```

Evidence path: `tools/spikes/ipc-harness/evidence/run-2026-10-18T20-39-40-686Z.jsonl`.

## Race battery

`pnpm --filter @plerni-spike/ipc-harness test:races` on this commit, exit 0. `commit-vs-revoke` is the concurrent B2 clause. The case asserts the commit wins and the cancel loses after a `Lock` / `transactionid` wait. The next case is the overlap vacuity: the oracle fails because the cancel finishes first. REV-T6-2026-10-19-9cf9740 covers the earlier battery at `1b1f536`. This block is the rerun.

```text
✔ death-before-commit (88.654006ms)
✔ lost-reply (63.682985ms)
✔ recovery-vs-live-commit (158.97433ms)
✔ healthy-long (46377.124466ms)
✔ stalled shutdown fails the renewal-to-lock oracle (11071.902349ms)
✔ heartbeat-behind-commit (5067.53743ms)
✔ saturated-pool (21450.786093ms)
✔ queued-past-lease (57.403808ms)
✔ second-executor-takeover (145.370408ms)
✔ commit-vs-revoke (28.792679ms)
✔ commit-vs-revoke overlap oracle fails when the revoker does not wait (22.726356ms)
✔ vacuity-authority fails when the ACTIVE predicate is removed (285.250509ms)
ℹ pass 26
ℹ fail 0
ℹ duration_ms 92184.704125
```

The B6 vacuity control that follows the battery: 1 pass, duration_ms 1662.383168.

## Original B3 FAIL, dev 3de0b5b

Kept so the §3.0 record has its lines. This is not the verdict. The scored partial object on that SHA, and three later `tripCaps()` calls, were:

```text
{"pass":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","tripped":true,"bound":true,"cap":32768}
```

`bound` was true only because the predicate was `< 2 MiB`. The fix is pull request #47. The partial rerun at 36864 bytes replaces this object. It is not the total-buffer verdict.

## A5

A5 is the 2026-10-17 CI measurement cited in the A report: bench-dispatch run 39044052211, commit `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. This T6 session did not repeat that curve.
