# ADR-0006 — IPC flow control: caps that include the kernel buffer

- **Status:** Proposed · **Date:** 2026-10-19
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §4.4 (framed NDJSON over stdio, stream backpressure)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D11** (isolation). ADR-0004 remains the topology record; this record is only the flow-control mechanism under that spike.
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §3.0, §4 B3, §8 (replacement-validation branch)
- **Evidence:** [`../plans/2026-10-18-spike-b-report.md`](../plans/2026-10-18-spike-b-report.md) §B3 items 11–15; issue #49
- **Number:** 0002, 0004, and 0005 are the names plan §8 already assigns to the ORM, isolation-topology, and UI-kit records. 0003 is the outbox record. This record is the next integer that is neither a file in this directory nor one of those names.

## Context

Plan §4 B3 hypothesises that backpressure is real in both directions, at every queue. The pass criterion is three named caps — the pending-call map, the per-connection partial-frame buffer, and the total buffered bytes — tripped by a sustained open-loop overload, with RSS growth ≤ 64 MiB over ≥ 60 s. The fail action is "redesign flow control". Plan §8 then opens a replacement-validation track, and P0 closes only on green on the shipped substrate. Plan §3.0 requires the cause to be established before that mapping: the oracle is a hypothesis too, a verdict needs ≥ 3 runs with the environment recorded, and environmental noise is an invalid run rather than a redesign.

The pending-call map is enforced before the supervisor writes to the child. The partial-frame and total-byte caps are not. On the current substrate the supervisor reads child stdout, feeds the framer in 4096-byte slices, and pauses the stream once `pendingBytes` or the plugin's userspace total passes the cap. The scored B3 run (three `spike:b3` invocations, warmup 5000 ms, window 60000 ms, 3 reps, every preflight valid) falsifies both clauses:

- **Partial.** Cap 32768. The allowance in the current oracle is one 4096-byte slice, 36864. Every run faulted `partial-cap` with `pendingBytes` 36864, `inFlightTailBytes` 32768, `highWater` 69632, `bound` false. 69632 = 36864 + 32768. The framer residual is already the cap plus one slice; the tail is the rest of the same unread chunk.
- **Total.** Cap 49152. The allowance is one 4096-byte slice, 53248. Accounted bytes (userspace high-water, including the chunk tail, plus `FIONREAD`) were 106496, 57344, and 155648. The stdout socket's `SO_RCVBUF` was 131072 on every run. Unread counts were 8192, 4096, and 45056, each inside that capacity. `afterCleanup` was 0 and the vacuity control was true: the post-cleanup count is not a high-water.
- **RSS.** Growth on the holds stayed ≤ 67108864 (largest sample 17641472). B3 fails on cap enforcement. Issue #49 records a cross-family rerun of partial 69632 and total 98304 against 53248.

Item 11 and item 15 of the report state the oracle result: the hypothesis that the configured cap plus one read chunk covers the buffered bytes is false, for the total and for the partial frame. The maintainer chose the redesign track over accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer).

### Why this design cannot enforce the hypothesis

The bytes B3 counts are not the bytes the cap inspects.

1. **The read chunk is already in userspace when the cap runs.** Node 22's default `highWaterMark` for a non-object-mode stream is 65536, and the option is a threshold, not a limit: it stops further reads, and it does not bound a chunk already delivered ([stream](https://nodejs.org/docs/latest-v22.x/api/stream.html), `stream.getDefaultHighWaterMark`, bumped in v22.0.0). 69632 = 4096 bytes already in the framer + one 65536-byte delivery. Feeding that delivery in 4096-byte slices crosses the 32768 cap on the slice that takes the framer to 36864 and leaves the other 32768 bytes as `inFlightTailBytes`. `pause()` does not drop them.
2. **The kernel has already accepted more bytes than the cap.** Child stdio from `uv_spawn` with `UV_CREATE_PIPE` is a `socketpair(2)`, not a pipe ([libuv processes](https://docs.libuv.org/en/v1.x/guide/processes.html)). Node documents the same fact: spawn pipes "are not actual Unix pipes" and have a platform-specific capacity ([child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html)). The harness observes that capacity as `SO_RCVBUF` 131072. `FIONREAD` / `SIOCINQ` on that fd is the unread receive count ([unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html)). Those bytes sit outside `bufferedBytes()` until a later read. Pausing the stream stops the next read; it does not shrink the queue the child has already filled. The flood child writes until `stdout.write` returns false and then waits for `drain`, so it already honors kernel backpressure — and the queue it fills is larger than either cap.

Userspace high-water marks therefore cannot be the enforcement point. They observe a copy, after the kernel queue and after the current read.

## Decision

Compare the three live options, then adopt one formula.

### 1. Credit / window, on its own

HTTP/2 flow control is the credit model to copy ([RFC 9113 §5.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.2)). The receiver advertises how many octets it will accept. The sender must not exceed the window. The receiver adds credit with `WINDOW_UPDATE` after it consumes data. Control frames do not consume the window, so they stay deliverable when the data window is exhausted (§5.2.1 items 2, 3, and 5).

Applied here: the child may write stdout only up to a grant, and the supervisor returns grant only for bytes it has consumed (framer residual taken, tail dropped, kernel unread count reduced). A child that obeys satisfies

```
pendingBytes + inFlightTailBytes + stdoutUnread ≤ grant ≤ cap
```

for each of the partial cap `P` and the total cap `T` (the tighter grant wins).

That equality is real only for a sender that obeys. RFC 9113 puts the obligation on the sender ("A sender MUST respect flow-control limits imposed by a receiver"). The B3 flood does not read grants. It writes until the kernel blocks. The supervisor learns of the extra bytes only once they are in the socket queue or in the current chunk, which is the failure already measured. An open-loop overload that stops because the child honored a grant is also the closed loop the plan §4 measurement contract warns about: closed-loop under-reports stalls. Credit is the right signal for a correct plugin. It is not, by itself, a cap the flood child can be held to.

### 2. Shrink the kernel buffer, and read less, on their own

Two different knobs are easy to conflate.

**Socket buffer.** [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html) doubles `SO_RCVBUF` and `SO_SNDBUF` on `setsockopt`, returns the doubled value from `getsockopt`, and documents a minimum doubled value of 256 for `SO_RCVBUF` and 2048 for `SO_SNDBUF`. `SO_RCVBUFFORCE` / `SO_SNDBUFFORCE` need `CAP_NET_ADMIN`. On `AF_UNIX`, [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) says the opposite of the obvious fix: "`SO_SNDBUF` does have an effect for UNIX domain sockets, but the `SO_RCVBUF` option does not." The datagram sentence that follows (doubled value minus 32) is about datagram size, not the stream queue. The stream ceiling is whatever a blocked writer actually fills, measured with `FIONREAD`, and it has to be ≤ the `getsockopt(SO_SNDBUF)` of the **writer** end. Setting `SO_RCVBUF` on the parent's stdout fd, which is the read end, is the knob the man page says has no effect. The 131072 reading is evidence of the current queue, not a control the supervisor can turn down from that end.

The writer end for child stdout is the fd the child holds. libuv creates it inside `uv_spawn`, and a hostile child will not shrink it. The supervisor has to create the `socketpair`, call `setsockopt(SO_SNDBUF)` on the end that will become the child's stdout, and spawn with that fd inherited. The same call on the parent's stdin write end bounds parent→child kernel bytes. macOS [getsockopt(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getsockopt.2.html) allows `SO_SNDBUF` and `SO_RCVBUF` to be decreased "to limit the possible backlog of incoming data" and "places an absolute limit on these values." It does not say `SO_RCVBUF` is a no-op. The formula below uses the measured `getsockopt` result on the platform that produced it.

**Pipe capacity.** [F_SETPIPE_SZ](https://man7.org/linux/man-pages/man2/f_setpipe_sz.2const.html) changes the capacity of a pipe to at least `arg` bytes. An unprivileged process is limited to the range from the page size to `/proc/sys/fs/pipe-max-size`. A request below the page size is rounded up. The kernel may allocate the next higher power-of-two page multiple, and the return value is the capacity actually set. `EBUSY` if the new size is below the data already stored. The operation is Linux-only (Standards: Linux; History: Linux 2.6.35). The default pipe is 16 pages, 65536 bytes when the page is 4096 ([pipe(7)](https://man7.org/linux/man-pages/man7/pipe.7.html)). macOS does not have this operation; the XNU pipe buffer is fixed (`PIPE_SIZE` 16384, `BIG_PIPE_SIZE` 64 KiB, [bsd/sys/pipe.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/pipe.h)). It is also the wrong object for this fd: the spike's stdout is a socket, and `F_GETPIPE_SZ` does not apply. `F_SETPIPE_SZ` becomes the ceiling only on a platform where the fd is a real pipe and `F_GETPIPE_SZ` returns the capacity.

**Smaller reads.** Setting the stdout `highWaterMark` (and the framer slice) down from 65536 removes the 32768-byte tail only for the next chunk. The kernel queue remains. A 4096-byte read plus a 131072-byte queue still misses both 36864 and 53248.

Shrink-and-read can enforce the caps only when the measured ceilings fit inside them. On today's unshrunk socket they do not: 131072 is already greater than 32768 and 49152.

### 3. Adopted: reserve the measured kernel ceilings and one read inside each cap

Use both mechanisms, with different jobs.

- **Enforcement, which the oracle trusts,** is the kernel ceiling plus the read size. The flood child already stops when the kernel buffer fills. The supervisor makes that buffer small enough, and stops reading early enough, that the filled buffer plus one read still lands inside the configured cap.
- **Credit, which a correct plugin trusts,** is the same budget advertised to the child and replenished only after consumption. Cancels and grant messages do not consume the child's send window, for the reason in RFC 9113 §5.2.1 item 5. The B3 flood is not required to honor the grant. B1's in-flight window is the userspace budget below, which can be most of a default cap, rather than the kernel ceiling alone.

The supervisor owns the socketpair and sets `SO_SNDBUF` on each writer end before the child starts. `K_in` is the measured child→parent ceiling: `getsockopt(SO_SNDBUF)` on the child's stdout end, confirmed by the maximum `FIONREAD` while a writer is blocked. If the occupancy exceeds the getsockopt value, the occupancy is the ceiling. `K_out` is the same measurement on the parent's stdin write end. `C` is the maximum stdout read (highWaterMark and framer slice, set equal). `P` is the configured partial cap (the trip test uses 32768). `T` is the configured per-child total cap (the trip test uses 49152).

The configuration is satisfiable only when both budgets are non-negative:

```
B_p = P - K_in - C ≥ 0
B_t = T - K_in - K_out - C ≥ 0
```

Otherwise the run is **invalid**. It is not a pass, and it is not permission to publish `K_in` as the accepted bound. The maintainer already refused that bound.

The supervisor starts a stdout read only when `pendingBytes ≤ B_p` and `bufferedBytes() ≤ B_t`. Each read is at most `C`. One read already posted may add at most `C` to the snapshot, split between bytes fed to the framer and the unprocessed tail. `stdoutUnread ≤ K_in`. `stdinQueued ≤ K_out`.

**Assertion, both clauses, on the pre-cleanup snapshot:**

```
partial_high_water = pendingBytes + inFlightTailBytes + stdoutUnread ≤ P

total_accounted = bufferedBytes() + inFlightTailBytes + stdoutUnread + stdinQueued ≤ T
```

`bufferedBytes()` is the userspace total the supervisor already sums (framer, stash, deferred, ids, outbound not yet accepted by the kernel, queue bytes, `readableLength`). The tail term is added only while it is still outside that sum: once it is stashed or pushed back onto the stream, `readableLength` or `stash` already holds it and the tail term is 0. `FIONREAD` is never inside `bufferedBytes()`. The current fault path already adds the tail and the unread count for the total clause; the partial clause gains the unread count too. `stdoutUnread` is `FIONREAD` / `SIOCINQ` on the parent's stdout fd. `stdinQueued` is a documented send-side occupancy when the platform provides one. [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) lists `SIOCINQ` and does not list `SIOCOUTQ` (that ioctl is specified for TCP in [tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html)). Where no send-side probe exists, `stdinQueued` is `K_out` if the parent has written since the child last returned read credit, and `0` only when no such write is outstanding. A missing `K_out` measurement is an invalid run, not a zero.

Those stop rules give:

```
partial_high_water ≤ B_p + C + K_in = P
total_accounted    ≤ B_t + C + K_in + K_out = T
```

The pending-call map stays a count cap enforced before the stdin write. It is not one of the two failed clauses. Outbound data bytes sit inside `T` through `rec.outbound` plus `stdinQueued`, which is the other direction of "at every queue".

The partial inequality is per connection. The total inequality is applied to that child's `#pluginBytes` plus its own tail, `stdoutUnread`, and `stdinQueued`. It is also applied to the process-wide sum against `totalGlobal`, with `K_in` and `K_out` summed over the live children and one `C` reserved per child that may have a read posted. The B3 trip test spawns one child for the byte caps, so that child's sum and `bufferedBytes()` are the same reading. A global budget that goes negative is invalid for the same reason a per-child budget is.

On a platform where stdout is a real pipe, `K_in` is the `F_SETPIPE_SZ` / `F_GETPIPE_SZ` return value instead of `SO_SNDBUF`. The inequalities do not change.

### Vacuity control

A cleaned-up count must not be able to satisfy the bound. Every scored total run already has `afterCleanup` 0, and `0 ≤ T` would be true. The bound function therefore refuses a snapshot that was taken after the child was marked dead and the framer, stash, and tail were dropped. The existing control stays: `totalCapHolds(afterCleanup, T)` is false, so the post-cleanup count is not "just over the cap".

Two further controls keep the new terms load-bearing:

- Replaying the recorded partial snapshot (36864 + 32768, and `stdoutUnread` absent or zero) through `partial_high_water ≤ P` is false at `P = 32768`. A scorer that drops the tail, or that still allows `P + 4096`, fails this control.
- A run whose `K_in` is the unshrunk 131072, or whose probe returned null, is invalid. It must not be reported as `bound: true`.

### Effect on B1, B2, and B4–B6

Default caps stay where they are (partial 65536, per-child total 262144, global total 1048576). The trip test's 32768 and 49152 are the small caps that must still hold; they are not the B1 window. `B_t` under the default total is that total minus `K_in + K_out + C`. With `K_*` at the socket(7) `SO_SNDBUF` floor (doubled minimum 2048) and `C` at 4096, the 1024-byte / in-flight-128 B1 shape still fits in the userspace budget. The re-spike measures the real `K_*`. If they are larger, the budget shrinks by that amount and B1 is scored again, not assumed.

- **B1.** Same frozen shape (2 children, in-flight 128, offered 8000/s, 1024-byte payload, warmup ≥ 5 s, window ≥ 60 s, ≥ 3 reps). Pass remains ≥ 5000 round-trip/s and p99 ≤ 10 ms. Extra blocking shows up there if `K_in` is so small that every response waits on the socket. That is a regression of this design, not a reason to drop `K_in` out of the formula.
- **B2.** Authority transitions stay in PostgreSQL. Renewal traffic stays `active executions / cadence` UPDATE transactions per second. A cancel shares the child's stdin socket with data, so it can sit behind bytes already in `K_out`. Grant and cancel frames do not consume the data window, and the parent reserves room for one cancel inside `K_out` rather than filling that buffer with payload. The race battery reruns as specified.
- **B4.** The 1 MiB typed error, the incremental oversize, and the never-terminated frame stay. A lower read size changes how many reads it takes to reach the cap; it must still fault the offending child with a typed error, and a partial cap below 1 MiB must fault at `P` rather than buffering to the framer's 1 MiB ceiling. The case that sets the partial cap to 1 MiB + 1 byte still reaches `NdjsonOversizeError`.
- **B5.** Crash mid-call still fails pending calls with a typed error. The fencing token stays unusable by the respawned child. No authority-row change.
- **B6.** One socketpair per child, so a full stdout queue does not fill a sibling. Identity remains stamped from the spawn-time credential. Sibling cancel p99 ≤ 500 ms is remeasured under the flood. The path at risk is a cancel on the flooded child's own stdin, bounded by the `K_out` reservation above; the sibling's socket is the one the numeric bound is about.

## Consequences

- The next PR in this series changes the harness to own the socketpair, set and measure `SO_SNDBUF` on the writer ends, cap the read at `C`, and score the two inequalities. This record does not.
- T7 does not adopt the failed numbers (partial high-water 69632, accounted totals 106496 / 57344 / 155648, `SO_RCVBUF` 131072). After a green re-spike the annex's buffer terms are:

```
per child, partial ≤ P    only where K_in + C ≤ P
per child, total   ≤ T    only where K_in + K_out + C ≤ T
per host           ≤ min(N × T, totalGlobal)
```

with `P`, `T`, `K_in`, `K_out`, and `C` taken from that run. RSS stays ≤ 64 MiB over ≥ 60 s. Renewal traffic is unchanged.

- A negative budget on the runtime the harness ships on sends the track back to the maintainer. The larger measured queue is not silently accepted.

## Re-spike

Plan §3.0 ③ and the §4 measurement contract, on the redesigned substrate:

1. **≥ 3 runs** of `pnpm --filter @plerni-spike/ipc-harness spike:b3`, each with preflight recorded (CPU count, load, throttle, overload, `valid`). Frozen warmup ≥ 5 s, window ≥ 60 s, ≥ 3 reps. An invalid environment is an invalid run, not a verdict.
2. **Suites that rerun,** because the substrate moved: B1, B2, B4, B5, B6, and `test:races`, plus the B3 invocation above. Spike A does not rerun for this change.
3. **Revised T7 estimate:** the three inequalities in Consequences, filled with the measured `K_in`, `K_out`, and `C`. No numeric buffer term is published from the failed substrate.
4. **Cross-family rerun:** a reviewer from a different model family than every generator checks out the pinned revision, reruns the suites from scratch, and posts a revision-bound receipt (reviewed head SHA, reviewer role, accountable sponsor, verification summary, outcome, opaque evidence ID). This Proposed record is not that receipt.

The spike B report gains §3.0 diagnosis records for any FAIL along the way. P0 still closes only on green on the shipped substrate.

## Flip conditions

- Measured `K_in + C > P`, or `K_in + K_out + C > T`, on the shipping runtime, and no portable `setsockopt` / `F_SETPIPE_SZ` reaches a non-negative budget. This reservation cannot enforce the configured caps. The track returns to the maintainer; the unshrunk queue is not adopted as the cap.
- B1 on the frozen shape misses ≥ 5000 round-trip/s or p99 ≤ 10 ms under the default caps. Revisit `C` and `K_*` inside the inequalities. Do not remove the kernel term.
- B6 sibling cancel p99 exceeds 500 ms. The stdin reservation for a cancel is too small or too late.
- A later substrate whose stdout is a real pipe records `F_GETPIPE_SZ` as `K_in`. The assertion stays `≤ P` and `≤ T`.

## Sources

Live documents this record relies on, retrieved 2026-10-19:

- RFC 9113 §5.2, <https://www.rfc-editor.org/rfc/rfc9113.html#section-5.2>
- Linux socket(7), <https://man7.org/linux/man-pages/man7/socket.7.html>
- Linux unix(7), <https://man7.org/linux/man-pages/man7/unix.7.html>
- Linux tcp(7) `SIOCOUTQ`, <https://man7.org/linux/man-pages/man7/tcp.7.html>
- Linux F_SETPIPE_SZ, <https://man7.org/linux/man-pages/man2/f_setpipe_sz.2const.html> (man-pages 6.19)
- Linux pipe(7), <https://man7.org/linux/man-pages/man7/pipe.7.html>
- libuv processes guide, <https://docs.libuv.org/en/v1.x/guide/processes.html>
- Node.js v22 stream and child_process, <https://nodejs.org/docs/latest-v22.x/api/stream.html>, <https://nodejs.org/docs/latest-v22.x/api/child_process.html>
- macOS getsockopt(2), <https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getsockopt.2.html>
- XNU `bsd/sys/pipe.h`, <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/pipe.h>
