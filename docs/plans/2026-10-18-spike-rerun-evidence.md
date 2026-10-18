# Spike rerun evidence (2026-10-18)

Backing lines for `2026-10-18-spike-a-report.md` and `2026-10-18-spike-b-report.md`. The A1–A4 suite and the B3 rerun are `0ed56fad9a7bfae4ed054c71f23a08484ecccb77`. B1, B2, B4, B5, B6, and the race battery stay dev `1b1f536c6fa874369ce1d30e9337f4224961be93`. Node v24.22.0. PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`. JSONL stays gitignored. Passwords are not recorded.

Review receipt: REV-T6-2026-10-19-9cf9740 covers the `1b1f536` lines and the A5 citation. The `0ed56fa` lines are pending (δ).

## Suite commands

From a clean worktree of that SHA, after the four harness passwords are exported:

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/db-invariant spike
```

Scored result on `0ed56fad9a7bfae4ed054c71f23a08484ecccb77`: exit 0, 7973 ms, 0 failing cases, 39 JSONL rows. An earlier invocation on dev `3de0b5b28130960eb8a3df5bc7ea28c4164b9766` exited 1 with `client_login_timeout (server down)` before any pooled case. That run is the invalid-run record in the A report. It is not a verdict.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/ipc-harness spike && pnpm --filter @plerni-spike/ipc-harness test && pnpm --filter @plerni-spike/ipc-harness test:races
```

`spike` exit 0. `test` 108 pass, 0 fail, 0 skipped, duration_ms 23310.678471. `test:races` 26 pass, 0 fail, duration_ms 92166.823435, then the B6 vacuity control 1 pass, duration_ms 1662.960974.

## A1–A4 and the battery

```text
[PASS] A1 @ direct — {"via":"kysely","runs":[[43865,43865,43865],[43867,43867,43867],[43866,43866,43866],[43869,43869,43869],[43870,43870,43870],[43868,43868,43868],[43871,43871,43871],[43872,43872,43872]]}
[PASS] A1 @ pooled — {"via":"kysely","runs":[[43874,43874,43874],[43874,43874,43874],[43878,43878,43878],[43873,43873,43873],[43876,43876,43876],[43875,43875,43875],[43877,43877,43877],[43873,43873,43873]]}
[PASS] A1 @ direct (raw-pg control) — {"via":"raw-pg","runs":[[43880,43880,43880],[43881,43881,43881],[43883,43883,43883],[43879,43879,43879],[43885,43885,43885],[43882,43882,43882],[43886,43886,43886],[43884,43884,43884]]}
[PASS] A1 @ pooled (raw-pg control) — {"via":"raw-pg","runs":[[43876,43876,43876],[43874,43874,43874],[43877,43877,43877],[43887,43887,43887],[43888,43888,43888],[43873,43873,43873],[43875,43875,43875],[43878,43878,43878]]}
[PASS] A3 A1 pinning @ pooled — {"statementsPerTransaction":3,"concurrent":8,"runs":[[43875,43875,43875],[43877,43877,43877],[43878,43878,43878],[43875,43875,43875],[43874,43874,43874],[43873,43873,43873],[43877,43877,43877],[43876,43876,43876]]}
[PASS] A3 mid-transaction error rollback @ pooled — {"code":"22012","installedPid":43905,"after":{"pid":43905,"absent":true,"rows":0,"guard":true}}
[PASS] A3 contamination lifecycle @ pooled — {"detectedOnExecutingBackend":true,"terminatedAndGone":true,"absenceOnReplacement":true,"positiveControl":true,"retries":1,"boundedRetry":true,"cleanupMs":27,"deadPid":43907,"backendGoneMs":6,"replacementPid":43909}
[PASS] A4 unnamed statement names @ direct+pooled — {"observed":75,"extended":34,"simple":41,"nonempty":[],"loadError":null}
[PASS] A4 unnamed-vs-named overhead @ direct — {"overheadPct":[19.9,24.3,21.3,75.7,34.1,40.5,23.9,27,34.8,28.8],"spread":{"min":19.9,"median":27.9,"p95":75.7,"mean":33,"meanUnrounded":33.03735652482319,"ci95Low":21.4,"ci95High":44.7},"decision":"mean-exceeds-20","a4bRequired":true}
[PASS] battery terminations == injected @ pooled(1) — {"injected":8,"terminated":8,"warmTailTerminations":0}
evidence: tools/spikes/db-invariant/evidence/run-2026-10-18T21-47-41-864Z.jsonl (7973ms) — 0 failing case(s)
```

The pooled raw-pg row is a `pg.Client` on the pooled DSN. Each of its eight transactions keeps one backend pid. That is the A1 pooled PASS, and it is why A3 is PASS.

## B3 on 0ed56fa

`b3()` from `tools/spikes/ipc-harness`, same SHA as the A suite. Pass true. Partial `pendingBytes` 36864, `partial-cap`, `bound` true. Total cap 49152: `buffered` 53248, `afterCleanup` 0, `bound` true, `vacuity` true. 53248 = 49152 + 4096. RSS growth 995328, 10956800, 356352, each ≤ 67108864.

## B1–B6 scored spike at dev 1b1f536

These lines are the earlier full suite. REV-T6-2026-10-19-9cf9740 covers them. They are not the B3 verdict. The total object here is the post-cleanup 0 that the section above replaces.

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

`commit-vs-revoke` is the concurrent B2 clause. The case asserts the commit wins and the cancel loses after a `Lock` / `transactionid` wait. The next case is the overlap vacuity: the oracle fails because the cancel finishes first.

```text
✔ death-before-commit (99.310652ms)
✔ lost-reply (66.018986ms)
✔ recovery-vs-live-commit (172.117577ms)
✔ healthy-long (46288.08615ms)
✔ stalled shutdown fails the renewal-to-lock oracle (11133.887446ms)
✔ heartbeat-behind-commit (5051.222643ms)
✔ saturated-pool (21423.206649ms)
✔ queued-past-lease (53.6208ms)
✔ second-executor-takeover (145.70143ms)
✔ commit-vs-revoke (35.049864ms)
✔ commit-vs-revoke overlap oracle fails when the revoker does not wait (29.174572ms)
✔ vacuity-authority fails when the ACTIVE predicate is removed (266.156162ms)
ℹ pass 26
ℹ fail 0
ℹ duration_ms 92166.823435
```

## Original B3 FAIL, dev 3de0b5b

Kept so the §3.0 record has its lines. This is not the verdict. The scored partial object on that SHA, and three later `tripCaps()` calls, were:

```text
{"pass":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","tripped":true,"bound":true,"cap":32768}
```

`bound` was true only because the predicate was `< 2 MiB`. The fix is pull request #47. The rerun above replaces it.

## A5

A5 is the 2026-10-17 CI measurement cited in the A report: bench-dispatch run 39044052211, commit `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. This T6 session did not repeat that curve.
