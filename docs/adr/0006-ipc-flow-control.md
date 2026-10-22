# ADR-0006 — IPC flow control: caps that include the kernel buffer

- **Status:** Proposed · **Date:** 2026-10-19
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §4.4 (framed NDJSON over stdio, stream backpressure)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D11** names the isolation topology; ADR-0004 remains that record. This record is only the flow-control mechanism under that spike. It does not decide malicious-plugin isolation.
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §3.0, §4 B3, §8 (replacement-validation branch)
- **Evidence:** [`../plans/2026-10-18-spike-b-report.md`](../plans/2026-10-18-spike-b-report.md) §B3 items 11–15; issue #49
- **Number:** 0002, 0004, and 0005 are the names plan §8 already assigns to the ORM, isolation-topology, and UI-kit records. 0003 is the outbox record. This record is the next integer that is neither a file in this directory nor one of those names.

## Scope

This record claims bounded hostile IPC only: memory and flow-control ceilings for non-colluding plugins on the tested Linux ABI, with a basic seccomp filter. The runtime, the pre-start helper cache, and same-UID access are trusted.

Malicious-plugin isolation is out of scope. [ADR-0004](0004-plugin-isolation-topology.md) is that topology record: plugin-to-plugin tampering, plugin-to-cache tampering, dumpable after `exec` or re-exec, and same-user file writes. The filter described below stays. It is the ceiling backstop, not that isolation boundary.

## Context

Plan §4 B3 hypothesises that backpressure is real in both directions, at every queue. The pass criterion is three named caps — the pending-call map, the per-connection partial-frame buffer, and the total buffered bytes — tripped by a sustained open-loop overload, with RSS growth ≤ 64 MiB over ≥ 60 s. The fail action is "redesign flow control". Plan §8 then opens a replacement-validation track, and P0 closes only on green on the shipped substrate. Plan §3.0 requires the cause to be established before that mapping: the oracle is a hypothesis too, a verdict needs ≥ 3 runs with the environment recorded, and environmental noise is an invalid run rather than a redesign.

The pending-call map is enforced before the supervisor writes to the child. The partial-frame and total-byte caps are not. On the current substrate the supervisor reads child stdout, feeds the framer in 4096-byte slices, and pauses the stream once `pendingBytes` or the plugin's userspace total passes the cap. The scored B3 run (three `spike:b3` invocations, warmup 5000 ms, window 60000 ms, 3 reps, every preflight valid) falsifies both clauses:

- **Partial.** Cap 32768. The allowance in the current oracle is one 4096-byte slice, 36864. Every run faulted `partial-cap` with `pendingBytes` 36864, `inFlightTailBytes` 32768, `highWater` 69632, `bound` false. 69632 = 36864 + 32768. The framer residual is already the cap plus one slice; the tail is the rest of the same unread chunk.
- **Total.** Cap 49152. The allowance is one 4096-byte slice, 53248. Accounted bytes (userspace high-water, including the chunk tail, plus `FIONREAD`) were 106496, 57344, and 155648. The stdout socket's `SO_RCVBUF` was 131072 on every run. Unread counts were 8192, 4096, and 45056, each inside that capacity. `afterCleanup` was 0 and the vacuity control was true: the post-cleanup count is not a high-water.
- **RSS.** Growth on the holds stayed ≤ 67108864 (largest sample 17641472). B3 fails on cap enforcement. Issue #49 records a cross-family rerun of partial 69632 and total 98304 against 53248.

Item 11 and item 15 of the report state the oracle result: the hypothesis that the configured cap plus one read chunk covers the buffered bytes is false, for the total and for the partial frame. The maintainer chose the redesign track over accepting the measured per-child bound (caps + one read chunk + kernel socket receive buffer).

### Why this design cannot enforce the hypothesis

The bytes B3 counts are not the bytes the cap inspects.

1. **The read chunk is already in userspace when the cap runs.** Node 22's default `highWaterMark` for a non-object-mode stream is 65536 (`stream.getDefaultHighWaterMark`, bumped in v22.0.0). That option is a threshold, not a limit, and it does not set the read size ([stream](https://nodejs.org/docs/latest-v22.x/api/stream.html)). The 65536-byte delivery comes from libuv: `uv__read` calls `alloc_cb` with `64 * 1024` ([libuv v1.x `src/unix/stream.c`](https://github.com/libuv/libuv/blob/v1.x/src/unix/stream.c)). 69632 = 4096 bytes already in the framer + one 65536-byte delivery. Feeding that delivery in 4096-byte slices crosses the 32768 cap on the slice that takes the framer to 36864 and leaves the other 32768 bytes as `inFlightTailBytes`. `pause()` does not drop them.
2. **The kernel has already accepted more bytes than the cap.** Child stdio from `uv_spawn` with `UV_CREATE_PIPE` is a `socketpair(2)`, not a pipe ([libuv processes](https://docs.libuv.org/en/v1.x/guide/processes.html)). Node documents the two facts separately ([child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html)): "These pipes have limited (and platform-specific) capacity." And: "These are not actual Unix pipes and therefore the child process can not use them by their descriptor files, e.g. `/dev/fd/2` or `/dev/stdout`." The harness observes that capacity as `SO_RCVBUF` 131072. `FIONREAD` / `SIOCINQ` on that fd is the unread receive count ([unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html)). Those bytes sit outside `bufferedBytes()` until a later read. Pausing the stream stops the next read; it does not shrink the queue the child has already filled. The flood child writes until `stdout.write` returns false and then waits for `drain`, so it already honors kernel backpressure — and the queue it fills is larger than either cap.

Userspace high-water marks therefore cannot be the enforcement point. They observe a copy, after the kernel queue and after the current read.

## Decision

Compare the three live options, then adopt one formula. Acceptance of the formula is measured on Linux. macOS is a dev-only platform and is not a pass platform for this record. The skb ceiling below is a Linux `AF_UNIX` `SOCK_STREAM` fact and is not claimed on macOS.

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

**Socket buffer.** [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html) doubles `SO_RCVBUF` and `SO_SNDBUF` on `setsockopt`, returns the doubled value from `getsockopt`, and documents a minimum doubled value of 256 for `SO_RCVBUF` and 2048 for `SO_SNDBUF`. The unprivileged maximum is `/proc/sys/net/core/wmem_max` for `SO_SNDBUF` (and `rmem_max` for `SO_RCVBUF`). `SO_RCVBUFFORCE` / `SO_SNDBUFFORCE` need `CAP_NET_ADMIN`. On `AF_UNIX`, [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) says the opposite of the obvious fix: "`SO_SNDBUF` does have an effect for UNIX domain sockets, but the `SO_RCVBUF` option does not." The datagram sentence that follows (doubled value minus 32) is about datagram size, not the stream queue. Setting `SO_RCVBUF` on the parent's stdout fd, which is the read end, does not shrink this queue. The 131072 reading is evidence of the current queue, not a control the supervisor can turn down from that end.

`getsockopt(SO_SNDBUF)` is not itself the hard ceiling. In `unix_stream_sendmsg` the ordinary send path caps each skb at `(sk_sndbuf >> 1) - 64` ("Keep two messages in the pipe so it schedules better"), then further at `SKB_MAX_HEAD(0) + UNIX_SKB_FRAGS_SZ`, which can only shrink that skb ([`net/unix/af_unix.c`](https://github.com/torvalds/linux/blob/master/net/unix/af_unix.c)). `sock_alloc_send_pskb` allocates while `sk_wmem_alloc_get(sk) < sk_sndbuf` ([`net/core/sock.c`](https://github.com/torvalds/linux/blob/master/net/core/sock.c)), so a writer can add one more skb once usage is just under the limit. The reserved ceiling is therefore

```
K = sndbuf + (sndbuf >> 1) - 64
```

where `sndbuf` is the `getsockopt(SO_SNDBUF)` value, already doubled. Queued **data** before the extra skb is at most `sndbuf - 1`, and the extra skb's payload is at most `(sndbuf >> 1) - 64`, so the data occupancy is at most `sndbuf + (sndbuf >> 1) - 65`. `K` is one byte above that and is the reservation this record uses for **one writer**. `unix_stream_sendmsg` calls `sock_alloc_send_pskb` before it locks the peer, and it does not lock the sending socket, so each thread can pass the check and queue an skb. The temporary overshoot above `K` is at most `thread count × ((sndbuf >> 1) - 64)`. That product is not a new value of `K`. `SKB_MAX_HEAD` only makes each extra skb smaller. The `MSG_SPLICE_PAGES` branch does not apply the per-skb cap. `sock_alloc_send_pskb` only checks that usage is under `sndbuf`, and the spliced byte count is charged afterwards, so one `splice(2)`, `vmsplice(2)`, or `sendfile(2)` can queue more data than `K`. That path is not a new value of `K`. The supervisor rejects those three calls, and it also rejects `io_uring_setup`, `io_uring_enter`, and `io_uring_register`. The same filter rejects `fork` and `vfork`, rejects `clone` unless `CLONE_THREAD` is set, and returns `ENOSYS` for `clone3` so libc falls back to `clone` and the filter can see the flags. The child cannot create another process. That rejection is a basic seccomp filter so the memory ceiling holds for a non-colluding plugin on the tested Linux ABI. It is not a malicious-plugin isolation boundary. Threads stay allowed: a Node child calls `clone` or `clone3` at startup, and rejecting every `clone` would stop it before it runs. Node's `child_process.spawn` has no pre-exec hook. Its options are the working directory, the environment, `argv0`, stdio, `detached`, uid, gid, serialization, shell, the Windows flags, `signal`, `timeout`, and `killSignal` ([child_process](https://nodejs.org/docs/latest-v22.x/api/child_process.html)). The filter is installed by a tiny exec wrapper, which is the program `spawn` starts. The wrapper calls `setpgid(0, 0)`, installs the seccomp filter in the child, then execs the plugin. The supervisor does not install that filter in its own process. The measured backstop stays `FIONREAD`: `stdoutUnread > K_in` does not raise `K`. One writer that did not raise `SO_SNDBUF` and still crosses `K_in` is the flip condition below. An overshoot from the child's own threads is the typed `thread-writer` fault below. `IORING_OP_SPLICE` reaches that same send path without calling `splice(2)` ([`include/uapi/linux/io_uring.h`](https://github.com/torvalds/linux/blob/master/include/uapi/linux/io_uring.h)). Filtering only the three named syscalls leaves the opcode open. For a single writer, `K` is the ceiling for `write` and for `sendmsg` without `MSG_SPLICE_PAGES`. A splice that still lands, by syscall or by io_uring, and leaves `stdoutUnread > K_in` is the flip condition: confinement did not hold. The re-spike's splice child passes when both the direct calls and `IORING_OP_SPLICE` fail and `stdoutUnread` stays ≤ `K_in`. That pass does not fail the B3 cap verdict. If `(sndbuf >> 1) - 64` is not positive, the path has no usable extra-skb bound and the budget is unsatisfiable.

The writer end for child stdout is the fd the child holds. libuv creates the pair inside `uv_spawn`, and a hostile child will not shrink it. Node has no public `socketpair` and no public `setsockopt(SO_SNDBUF)` on a `net.Socket`. The supervisor does both through a small N-API helper under the same rules as [`tools/spikes/ipc-harness/src/pipe_pending.mjs`](../../tools/spikes/ipc-harness/src/pipe_pending.mjs): compiled for this ABI on first use; the binary placed in a `0700` directory owned by the current uid; a symlink rejected; group and other permission bits clear; ownership and mode checked again before `require()`; a failed compile, check, or call returns null; a null result is never turned into a scored bound. The runtime that compiles and loads that helper, the cache as it exists before the supervisor starts, and same-UID access are trusted. Those checks are not a defense against a plugin that rewrites the cache or another plugin's files. The helper creates the `socketpair`, sets `SO_SNDBUF` on each writer end, dups the stdin read end, and reads `FIONREAD`. It does not score `SIOCOUTQ`. `unix_outq_len` is `sk_wmem_alloc_get`, and `skb_set_owner_w` adds `skb->truesize` to that counter ([`net/core/sock.c`](https://github.com/torvalds/linux/blob/master/net/core/sock.c)), so `SIOCOUTQ` counts kernel memory per queued skb, overhead included. `K_out` bounds data bytes. A parent whose payload is still inside `K_out` can still read a larger `SIOCOUTQ`, and that reading is not a failed cap.

The child end is passed to `spawn` as a positive integer stdio fd. Node's rule for that value is a separate sentence from the two quoted above: "The integer value is interpreted as a file descriptor that is open in the parent process. It is shared with the child process, similar to how objects can be shared. Passing sockets is not supported on Windows." The parent closes its copy of the fd it passed. For stdout the parent keeps the read end, the child inherits the write end as fd 1, and `SO_SNDBUF` is set on that write end before spawn. For stdin the parent keeps the write end, the child inherits the read end as fd 0, and `SO_SNDBUF` is set on the write end before spawn. Before spawn the helper dups that read end and the parent keeps the dup. The parent calls `FIONREAD` on the dup and does not `read` it, so the probe does not take bytes the child has not consumed. Another read end does not change the child's EOF: EOF arrives when every write end is closed. The child does not hold the stdin writer, so it cannot raise `K_out`. On the child `exit` event the supervisor kills and reaps that process group, then drains stdout to EOF. The record stays in the accounted set through the drain. Only then does the parent close the probe dup and mark the record dead. A later write fails with `EPIPE`. Crash detection stays on `exit`. `EPIPE` is not the crash signal. A descendant that still holds fd 0 or fd 1 after the reap is the flip: confinement did not hold.

A `socketpair` is full-duplex. Before spawn the helper half-closes the unused direction on each end: `SHUT_WR` on the child's stdin socket, so the child cannot write fd 0, and `SHUT_RD` on the child's stdout socket, so the child cannot read fd 1. `shutdown` is not reversible. The parent's stdin write end is not shut for write, so the child still receives stdin until that write end closes. A child that writes fd 0 after the half-close gets `EPIPE` and does not fill a receive queue on the parent's socket. That reverse queue is not part of `stdinQueued` or `stdoutUnread`. The re-spike's reverse-direction child passes when the write fails and `FIONREAD` on the parent's stdin socket stays 0. That pass does not fail the B3 cap verdict. Reverse bytes that do queue are the flip condition: the half-close did not hold.

**Pipe capacity.** [F_SETPIPE_SZ](https://man7.org/linux/man-pages/man2/f_setpipe_sz.2const.html) changes the capacity of a pipe to at least `arg` bytes. An unprivileged process is limited to the range from the page size to `/proc/sys/fs/pipe-max-size`. A request below the page size is rounded up. The kernel may allocate the next higher power-of-two page multiple, and the return value is the capacity actually set. `EBUSY` if the new size is below the data already stored. The operation is Linux-only (Standards: Linux; History: Linux 2.6.35). The default pipe is 16 pages, 65536 bytes when the page is 4096 ([pipe(7)](https://man7.org/linux/man-pages/man7/pipe.7.html)). macOS does not have this operation; the XNU pipe buffer is fixed (`PIPE_SIZE` 16384, `BIG_PIPE_SIZE` 64 KiB, [bsd/sys/pipe.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/pipe.h)). It is also the wrong object for this fd: the spike's stdout is a socket, and `F_GETPIPE_SZ` does not apply. `F_SETPIPE_SZ` becomes the ceiling only on a platform where the fd is a real pipe. There the reserved `K_in` is the `F_GETPIPE_SZ` return, with no skb overshoot added.

**Smaller reads.** `highWaterMark` does not cap the buffer libuv delivers. The stdout read end is wrapped as

```
new net.Socket({ fd, onread: { buffer: Buffer.alloc(C), callback } })
```

with `readable: true`. That flag defaults to false when an `fd` is passed, and without it the socket does not read ([net](https://nodejs.org/docs/latest-v22.x/api/net.html), `onread` added in v12.10.0). Incoming data is stored in that single buffer and passed to the callback as the byte count and the buffer. Returning false from the callback pauses the socket. The streaming `'data'` path is not used, so a delivered chunk is at most `C` bytes. A smaller `C` without a shrunk writer buffer still leaves the kernel queue. A 4096-byte read plus the unshrunk queue still misses both 36864 and 53248.

macOS [getsockopt(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getsockopt.2.html) allows `SO_SNDBUF` and `SO_RCVBUF` to be decreased "to limit the possible backlog of incoming data" and "places an absolute limit on these values." It does not say `SO_RCVBUF` is a no-op. A macOS dev run is not the acceptance measurement for the Linux formula.

Shrink-and-read can enforce the caps only when `K_in + C` fits in `P` and `K_in + K_out + C` fits in `T`. On today's unshrunk socket they do not: 131072 is already greater than 32768 and 49152.

### 3. Adopted: reserve the writer-end ceiling and one read inside each cap

Use both mechanisms, with different jobs.

- **Enforcement, which the oracle trusts,** is the writer-end ceiling plus the `onread` buffer. The flood child already stops when the kernel buffer fills. The supervisor makes that buffer small enough, and posts reads of at most `C`, that the filled buffer plus one read still lands inside the configured cap.
- **Credit, which a correct plugin trusts,** is the same budget advertised to the child and replenished only after consumption. Cancels and grant messages do not consume the child's send window, for the reason in RFC 9113 §5.2.1 item 5. The B3 flood is not required to honor the grant. B1's in-flight window is the userspace budget below, which can be most of a default cap, rather than the kernel ceiling alone.

`sndbuf_in` is `getsockopt(SO_SNDBUF)` on the child stdout writer, taken from the supervisor's own `setsockopt` before spawn. `sndbuf_out` is the same call on the parent's stdin writer. `K_in` and `K_out` are each `sndbuf + (sndbuf >> 1) - 64` for that end. On a real pipe the corresponding `K` is the `F_GETPIPE_SZ` return and the half-skb term is absent. `C` is the `onread` buffer size, and the framer slice is set equal to it. `P` is the configured partial cap (the trip test uses 32768). `T` is the configured per-child total cap (the trip test uses 49152). `S` is the configured ceiling for the shared userspace bytes that `#pluginBytes` does not charge to a child: the mux framer (`bridge.pendingBytes()`), the unbound queue, and the shared socket outbound buffer (`socketOutbound`). Per-child hi/lo queue bytes stay inside `T` and are not counted again in `S`. The mux socket is the supervisor's TCP connection to the broker. Before `connect`, the supervisor sets `SO_RCVBUF` and `SO_SNDBUF` and reads them back. [tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html) requires that size to be set before `connect` or `listen`, and `getsockopt` returns the doubled value. Those read-back values are `K_mux_in` and `K_mux_out`, chosen so `B_g` stays non-negative. An unset reading is not a ceiling: TCP autotuning can raise the buffer above `totalGlobal`. The set takes `SOCK_RCVBUF_LOCK` and `SOCK_SNDBUF_LOCK` (`__sock_set_rcvbuf` and the `SO_SNDBUF` path in [`net/core/sock.c`](https://github.com/torvalds/linux/blob/master/net/core/sock.c)). `tcp_rcvbuf_grow` returns when the receive lock is set, and `tcp_sndbuf_expand` runs only when the send lock is clear ([`net/ipv4/tcp_input.c`](https://github.com/torvalds/linux/blob/master/net/ipv4/tcp_input.c)). The unix half-skb formula is not applied. A later reading above that read-back is the flip, and `K_mux_in` and `K_mux_out` are not raised. `muxUnread` is `FIONREAD` on that socket. `muxSendQueued` is its kernel send queue, read with TCP `SIOCOUTQ` (unacknowledged data bytes, not the unix `truesize` counter). Mux reads use the same `onread` buffer of size `C`.

The configuration is satisfiable only when every budget is non-negative and each socket's per-skb term is positive:

```
(sndbuf_in  >> 1) - 64 > 0
(sndbuf_out >> 1) - 64 > 0
B_p = P - K_in - C ≥ 0
B_t = T - K_in - K_out - C ≥ 0
B_g = totalGlobal - Σ K_in - Σ K_out - Σ C - K_mux_in - K_mux_out - C ≥ 0
```

`Σ` runs over live children. `Σ C` counts a child that may have a read posted. A pipe end skips the per-skb test and contributes its `F_GETPIPE_SZ` return as `K`. If any required test fails, the outcome is **`unsatisfiable`**. That outcome is a B3 FAIL. The §3.0 record states the cause (the reservation does not fit the configured caps) and points at the flip condition below. Plan §3.0 keeps **`invalid`** for environmental noise: a failed preflight, and a null probe that cannot score. An unsatisfiable budget is not that outcome, and it is not permission to publish the unshrunk queue as the accepted bound.

socket(7) documents a doubled `SO_SNDBUF` minimum of 2048, which would give `K = 2048 + 1024 - 64 = 3008`. Linux stores `max(val * 2, SOCK_MIN_SNDBUF)` on `setsockopt(SO_SNDBUF)`, and `SOCK_MIN_SNDBUF` is `(2048 + SKB_DATA_ALIGN(sizeof(struct sk_buff))) * 2` ([`include/net/sock.h`](https://github.com/torvalds/linux/blob/master/include/net/sock.h)). That floor is above 2048. `sizeof(struct sk_buff)` depends on the kernel build, so this record does not publish a numeric substitute for it. The illustrative `K = 3008` is below any real `getsockopt` return. The budgets use the measured value. A measured pair still has to satisfy `K_in + C ≤ 32768` and `K_in + K_out + C ≤ 49152` on the trip caps.

**Spawn reservation.** `B_g` is computed from the children that are about to be live, including the one being started. Before `spawn`, the supervisor adds that child's `K_in + K_out + C` to the current process accounted total (`bufferedBytes()`, tails not yet in that sum, each `stdoutUnread`, each `stdinQueued`, `muxUnread`, `muxSendQueued`). The spawn is rejected when the sum would exceed `totalGlobal`. The child is not started. A rejected spawn is not a B3 cap failure. If those kernel and read terms alone, at zero userspace, make `B_g` negative, the outcome is `unsatisfiable`.

**Admission.** The inequalities hold because every byte addition is gated, not because a stdout read happened to look first.

- A stdout read is started only when `pendingBytes ≤ B_p`, the child's `#pluginBytes ≤ B_t`, and the process userspace sum has room for `C` inside `B_g`. Each read is at most `C`. One read already posted may add at most `C`, split between bytes fed to the framer and the unprocessed tail. The same decision probes `FIONREAD` (below).
- An outbound payload and its identifiers are admitted only when the resulting `#pluginBytes` stays ≤ `B_t` and the process userspace sum stays ≤ `B_g`. The pending-call map remains a count cap checked before the stdin write. It does not admit those bytes.
- A shared-buffer write (mux framer, unbound queue, shared socket outbound) is admitted only when the shared total stays ≤ `S` and the process userspace sum stays ≤ `B_g`. A mux read uses the same `onread` rule and starts only when `muxUnread ≤ K_mux_in` and the process sum has room for `C`.

**Usable credit.** Grants, reservations, admission, and pause/resume are decided by one pure book (`tools/spikes/ipc-harness/src/credit.mjs`), separate from the socket transport. The harness supervisor remains the spike substrate. Headroom is the largest live call cost, withheld from the next grant so a later call of that size still fits beside advertised credit. The withhold is capped so the grant still covers the usable reply: one initial result line, or the whole idle grant when the ceiling is smaller. A cost above the child ceiling or the process ceiling is not headroom. A rejected call and a timed-out call drop their cost. A completed call may leave a floor, and the same cap still applies. Every grant reads current userspace, windows, and live costs, including the grant that follows a release. A credit-compliant child, which writes a reply only when the window covers that line, therefore receives a window that covers it.

**Resume.** A child paused because the process ceiling was crossed resumes when its next bounded read fits in that ceiling. The read is one `C`-byte buffer when the child is paused or the kernel queue is empty, and the shorter queued tail otherwise. Falling to half the ceiling is not required. An open stdout line uses the same test. When the open lines alone cannot take the read, the child is faulted `total-cap`. Bytes that can still be released are not that fault; the next release decides again.

**Parent write policy for control frames.** The kernel cannot reserve room inside `K_out`. Cancel and window-update grants share the child's stdin with payload, and a correct plugin can stop reading new requests until a grant arrives. The parent therefore keeps room for one cancel and one grant at the same time, and writes those two ahead of payload. It does not admit payload that would leave the userspace budget or `stdinQueued` without room for both. A separate control socket is the alternative this record does not adopt. The control frames' own bytes still count: they sit in `rec.outbound` until the kernel accepts them, then in the measured queue.

**Kernel terms are measured in data bytes, and they are not redefined upward.** `stdoutUnread` is `FIONREAD` / `SIOCINQ` on the parent's stdout fd. For a stream socket that is `unix_inq_len`, the payload sum (`inq_len`, each `skb->len`). `stdinQueued` is `FIONREAD` on the parent-kept dup of the child's stdin read end, the same payload count, and it must be ≤ `K_out`. It is not assumed equal to `K_out`, and a child's read-credit message does not clear it. A null probe is `invalid` (the run cannot be scored). `SIOCOUTQ` is not this term.

`FIONREAD` on the stdout fd and on the stdin probe dup is taken at every read-gate decision, and again on a fixed 20 ms timer while stdout reads are paused. A paused socket does not emit a read event, so the timer is the probe that still runs. The fault deadline stays 100 ms. The timer interval is not that deadline. Node documents that a timer callback will likely not be invoked in precisely `delay` milliseconds, and that it makes no guarantees about the exact timing of when callbacks will fire ([timers](https://nodejs.org/docs/latest-v22.x/api/timers.html)). The worst case is an overrun just after a probe. Detection then waits one probe interval plus the event-loop lag of that callback, and that sum must be < 100 ms. The fault is due on the probe that first sees the overrun.

**Buffer-enlarger.** A child can raise `SO_SNDBUF` on its own stdout writer without privileges ([socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html)). The call clamps the argument at `wmem_max` and then stores `max(val * 2, SOCK_MIN_SNDBUF)`, so a child that asks for the maximum gets `max(2 * wmem_max, SOCK_MIN_SNDBUF)`. On a real pipe the child can raise `F_SETPIPE_SZ` up to `pipe-max-size`. The reserved `K` stays the value from the supervisor's own call. While the supervisor is paused at a cap, the child can fill that enlarged ceiling before the next timer tick. The unread data in that window is at most `K` of the enlarged `sndbuf`, or `pipe-max-size` on a pipe. The supervisor faults the child with the typed error `buffer-enlarged` on the probe that sees `stdoutUnread > K_in`. It does not adopt the new occupancy as `K_in`.

The enlarger case **passes** when that typed fault happens within 100 ms of the unread data exceeding `K_in`. The 20 ms probe is what leaves room for timer delay: probe interval + measured event-loop lag < 100 ms. The pass does not fail the overall B3 verdict. B3's cap verdict is the flood child that leaves the buffer at the supervisor's setting. A scorer that records `buffer-enlarged` as a B3 cap failure, or that lifts `K_in` to the child's new buffer and reports `bound: true`, fails the enlarger case. A sandbox or seccomp that rejects a later `SO_SNDBUF` raise and `F_SETPIPE_SZ` would let that child stay inside the cap instead of faulting; this record does not adopt that alternative.

**Thread writers.** Threads share the sending socket, so each one can pass the `sk_wmem_alloc < sndbuf` check and queue one skb. While the supervisor is paused, unread data can sit above `K_in` by at most `thread count × ((sndbuf >> 1) - 64)`. The supervisor faults that child with the typed error `thread-writer` on the `FIONREAD` probe that sees `stdoutUnread > K_in` when the child has not raised its buffer. It does not raise `K`. The fault is due within 100 ms, on the same clock as the enlarger. That pass does not fail the overall B3 verdict. A new process (`fork`, `vfork`, or `clone` without `CLONE_THREAD`) is the flip condition below.

`stdinQueued > K_out` on the dup, from a parent that did not raise its own `SO_SNDBUF`, is the flip condition below: the data ceiling was wrong. It does not raise `K_out`.

**Assertion, both clauses, on the pre-cleanup snapshot,** and only while `stdoutUnread ≤ K_in` and `stdinQueued ≤ K_out`:

```
partial_high_water = pendingBytes + inFlightTailBytes + stdoutUnread ≤ P

total_accounted = #pluginBytes + inFlightTailBytes + stdoutUnread + stdinQueued ≤ T
```

`#pluginBytes` is the per-child userspace total (framer, stash, deferred, ids, hi/lo, outbound not yet accepted by the kernel, `readableLength`). The tail term is added only while it is still outside that sum: once it is stashed or pushed back onto the socket, the userspace term already holds it and the tail term is 0. `FIONREAD` is never inside `#pluginBytes`. The process-wide assertion is the same shape against `totalGlobal`: `bufferedBytes()` (which already includes the shared userspace terms and every child's userspace bytes) plus tails not yet in that sum, plus each `stdoutUnread`, plus each `stdinQueued`, plus `muxUnread`, plus `muxSendQueued`. `socketOutbound` is userspace not yet accepted by the kernel. `muxSendQueued` starts after that accept. They are not the same bytes.

**Stderr.** fd 2 is not a buffered stream. The supervisor passes an fd open on `/dev/null`, and the process total has no stderr term. A child that writes fd 2 does not fill a kernel queue the formula would otherwise omit. The current harness pipe (`stdio: ['pipe', 'pipe', 'pipe']`, drained from the `'data'` handler) is the queue this record removes.

Those rules give:

```
partial_high_water ≤ B_p + C + K_in = P
total_accounted    ≤ B_t + C + K_in + K_out = T
process            ≤ B_g + Σ K_in + Σ K_out + Σ C + K_mux_in + K_mux_out + C = totalGlobal
```

The partial inequality is per connection. The B3 trip test spawns one child for the byte caps, so that child's sum and the process reading move together. The pending-call map is not one of the two failed clauses.

**Typed faults.** An ordinary sender fills at most `K - 1` data bytes, because the extra skb is admitted only while usage is strictly under `sndbuf` and is then capped. After the last read the supervisor is willing to start (`pendingBytes ≤ B_p`), userspace holds at most `B_p + C = P - K_in`. The accounted sum therefore tops out at `P - 1`. A predicate that waits for `partial_high_water > P` does not fire, and the child would sit paused with an unterminated frame. The supervisor does not do that.

When the next stdout read is refused because `pendingBytes > B_p` and the bytes already in the framer and the in-flight tail contain no newline, the supervisor faults immediately. `MAX_RESIDUAL` is `MAX_FRAME_SIZE + 1`. If those consumed bytes are not more than `MAX_RESIDUAL`, the fault is `partial-cap`. The framer throws `NdjsonOversizeError` only once unterminated bytes already buffered are more than `MAX_RESIDUAL`. Buffering exactly `MAX_FRAME_SIZE + 1` does not throw. The kernel may still hold the newline; those bytes are not pulled in before typing `partial-cap`. `NdjsonOversizeError` is only the framer's own error.

`stdoutUnread > K_in` on a child that raised its buffer is the `buffer-enlarged` signal above. The same overrun from more than one thread, with the buffer left at the supervisor's setting, is the `thread-writer` signal above. Neither is the trip for the ordinary never-terminated sender. A splice that escapes confinement and crosses `K_in` is the flip condition.

### Vacuity control

A cleaned-up count must not be able to satisfy the bound. Every scored total run already has `afterCleanup` 0, and `0 ≤ T` would be true. The bound function therefore refuses a snapshot that was taken after the child was marked dead and the framer, stash, and tail were dropped. The existing control stays: `totalCapHolds(afterCleanup, T)` is false, so the post-cleanup count is not "just over the cap".

Three further controls keep the new terms load-bearing:

- Replaying the recorded partial snapshot (36864 + 32768, and `stdoutUnread` absent or zero) through `partial_high_water ≤ P` is false at `P = 32768`. A scorer that drops the tail, or that still allows `P + 4096`, fails this control.
- On one host, against the same `P` and `T`, a variant with enforcement removed (the default socket buffer and libuv's 64 KiB reads) scores **FAIL**. That result is not `invalid` and not `unsatisfiable`. The enforced variant on that same host scores pass. A scorer that marks the unenforced run `invalid`, or that lets it pass, fails this control.
- The buffer-enlarger case passes when the supervisor emits `buffer-enlarged` within 100 ms of `stdoutUnread` exceeding `K_in`, with that elapsed time taken as re-spike item 4 defines it. That pass is not a B3 cap failure. A scorer that counts the typed fault against the B3 verdict, that raises `K` and reports `bound: true`, or that starts the clock at the supervisor's own probe, fails this control.

### Effect on B1, B2, and B4–B6

Default caps stay where they are (partial 65536, per-child total 262144, global total 1048576). The trip test's 32768 and 49152 are the small caps that must still hold; they are not the B1 window. `B_t` under the default total is that total minus `K_in + K_out + C`. The socket(7) figure `K = 3008` is below `SOCK_MIN_SNDBUF` and is not a Linux reading. The re-spike measures the real `K_*`. If they leave too little userspace budget for the 1024-byte / in-flight-128 shape, B1 is scored again, not assumed.

- **B1.** Same frozen shape (2 children, in-flight 128, offered 8000/s, 1024-byte payload, warmup ≥ 5 s, window ≥ 60 s, ≥ 3 reps). Pass remains ≥ 5000 round-trip/s and p99 ≤ 10 ms. Extra blocking shows up there if `K_in` is so small that every response waits on the socket. That is a regression of this design, not a reason to drop `K_in` out of the formula.
- **B2.** Authority transitions stay in PostgreSQL. Renewal traffic stays `active executions / cadence` UPDATE transactions per second. Cancel and grant frames share the child's stdin with data and do not consume the data window. Room for both at once is the parent write policy above: the kernel does not hold that slice inside `K_out`. The race battery reruns as specified.
- **B4.** The 1 MiB typed error, the incremental oversize, and the never-terminated frame stay. The B4 partial cap is explicit: `P = MAX_RESIDUAL + K_in + C`. Then `B_p = MAX_RESIDUAL`, so the last admitted read can push the framer past that threshold while `stdoutUnread` stays within `K_in`. The never-terminated case passes only on `NdjsonOversizeError` once the framer has seen more than `MAX_RESIDUAL` unterminated bytes. A `partial-cap` before the framer has seen more than `MAX_RESIDUAL` fails B4.
- **B5.** Crash mid-call still fails pending calls with a typed error. The fencing token stays unusable by the respawned child. No authority-row change. The crash is observed on the child `exit` event. The supervisor then kills and reaps the process group, drains stdout to EOF, and only then closes the probe dup and drops the record. A later write fails with `EPIPE`. The exit event remains the detection. A write error is not. The descendant case is re-spike item 7.
- **B6.** One socketpair per child, so a full stdout queue does not fill a sibling. Identity remains stamped from the spawn-time credential. Sibling cancel p99 ≤ 500 ms is remeasured under the flood. The sibling's socket is the numeric bound. The flooded child's own stdin is the parent-write-policy path.

## Consequences

- The next PR in this series changes the harness: the native helper, the integer-fd spawn, the exec wrapper (filter, `setpgid`, and the reap), the stdin read-end dup, the `onread` buffer on stdout and on the mux socket, the admission gates, and the inequalities. This record does not.
- The largest frame the SDK can treat as legal is about `P - K_in`. With the writer queue full, `stdoutUnread` can be `K_in`, so `pendingBytes` has to stay within `P - K_in` or `partial_high_water` passes `P`. `P` is not the maximum frame size a plugin may send.
- T7 does not adopt the failed numbers (partial high-water 69632, accounted totals 106496 / 57344 / 155648, `SO_RCVBUF` 131072). After a green re-spike the annex's buffer terms are:

```
per child, partial        ≤ P    only where K_in + C ≤ P
per child, total          ≤ T    only where K_in + K_out + C ≤ T
shared                    ≤ S    mux framer, unbound queue, shared socket outbound
per runner process        ≤ min(N × T + S + K_mux_in + K_mux_out + C, totalGlobal)
per host                  ≤ R × that bound
```

with `P`, `T`, `S`, `K_in`, `K_out`, `K_mux_in`, `K_mux_out`, and `C` taken from that run. `R` is the number of colocated runner processes. One supervisor enforces `totalGlobal` for its own process; the spike runs one process, so `R = 1`. `N × T` does not include the shared userspace terms or the mux kernel terms. RSS stays ≤ 64 MiB per process over ≥ 60 s. Renewal traffic is unchanged.

- An `unsatisfiable` budget on the runtime the harness ships on sends the track back to the maintainer. The larger measured queue is not silently accepted.

## Re-spike

Plan §3.0 ③ and the §4 measurement contract, on the redesigned substrate. The pass/fail measurement is on Linux. A macOS dev run is not that measurement.

1. **≥ 3 runs** of `pnpm --filter @plerni-spike/ipc-harness spike:b3`, each with preflight recorded (CPU count, load, throttle, overload, `valid`). Frozen warmup ≥ 5 s, window ≥ 60 s, ≥ 3 reps. An invalid environment is an invalid run, not a verdict. An `unsatisfiable` budget is a B3 FAIL with a §3.0 record and the flip condition, not an invalid run.
2. **Suites that rerun,** because the substrate moved: B1, B2, B4, B5, B6, and `test:races`, plus the B3 invocation above. Spike A does not rerun for this change. B4 sets `P = MAX_RESIDUAL + K_in + C`. The never-terminated frame passes only on `NdjsonOversizeError` after the framer has seen more than `MAX_RESIDUAL` unterminated bytes. A `partial-cap` before that fails B4.
3. **Same-host vacuity pair.** One run with enforcement removed (default socket buffer, 64 KiB reads) and one enforced run, same host, same `P` and `T`. The unenforced run is FAIL. The enforced run passes.
4. **Buffer-enlarger.** An adversarial child raises `SO_SNDBUF` on its stdout writer after spawn, up to the clamp at `wmem_max` (or `F_SETPIPE_SZ` up to `pipe-max-size` when the fd is a pipe). While the supervisor is paused, the test holds its event loop for 50 ms across the moment the queued data crosses the reserved `K_in`. The child records the wall-clock time of the write that first exceeds that reserved size, from the byte count it wrote, not from the parent's `FIONREAD`. The test records the wall-clock time at which it observes `buffer-enlarged`, outside the supervisor's probe. Elapsed detection is the second timestamp minus the first, and it must be < 100 ms. The measured event-loop lag is that induced hold, recorded by the test. The case also requires `20 ms + that lag < 100 ms`. A clock that starts at the supervisor's probe does not measure the elapsed detection. That pass does not fail the overall B3 verdict. The flood child that does not enlarge its buffer is the B3 cap pass.
5. **Splice child.** It calls `splice`, `vmsplice`, or `sendfile` on stdout, and it submits `IORING_OP_SPLICE` through `io_uring_enter`. The case passes when every one of those fails and `stdoutUnread` stays ≤ `K_in`. That pass does not fail the B3 cap verdict. Any of them that succeeds and pushes `stdoutUnread` above `K_in` is the flip condition.
6. **Reverse-direction child.** It writes fd 0. The case passes when the write fails with `EPIPE` and `FIONREAD` on the parent's stdin socket stays 0. That pass does not fail the B3 cap verdict. Queued reverse bytes are the flip condition.
7. **Descendant (B5).** The child calls `fork` and the descendant inherits fd 0 and fd 1, then the child exits. The case passes when `fork` fails, or the process group is killed and reaped, stdout is drained to EOF, and the record stays accounted until that drain. Dropping the record at `exit` while a holder or unread stdout bytes remain fails the case. That pass does not fail the B3 cap verdict.
8. **Multi-writer.** `fork` is rejected. Two threads then write fd 1 at once. The case passes when `fork` fails and the supervisor emits `thread-writer` within 100 ms of `stdoutUnread` exceeding the reserved `K_in`, timed the way item 4 times the enlarger. The temporary overshoot in that window is at most `thread count × ((sndbuf >> 1) - 64)`. `K` is not raised. That pass does not fail the B3 cap verdict. A scorer that records `thread-writer` as a B3 cap failure, or that lifts `K` and reports `bound: true`, fails the case.
9. **Mux open-loop.** The broker and the supervisor flood the mux socket. Before `connect`, `SO_RCVBUF` and `SO_SNDBUF` were set and read back, and those values are the `K_mux_in` and `K_mux_out` in `B_g`. The case passes when `muxUnread ≤ K_mux_in`, `muxSendQueued ≤ K_mux_out`, every mux read is at most `C`, and the process sum stays ≤ `totalGlobal`. A queue above its reservation, or a later `getsockopt` above that read-back, is the flip. It does not raise `K_mux_in` or `K_mux_out`.
10. **Revised T7 estimate:** the inequalities in Consequences, filled with the measured `K_in`, `K_out`, `K_mux_in`, `K_mux_out`, `C`, and the configured `S`. No numeric buffer term is published from the failed substrate.
11. **Cross-family rerun:** a reviewer from a different model family than every generator checks out the pinned revision, reruns the suites from scratch, and posts a revision-bound receipt (reviewed head SHA, reviewer role, accountable sponsor, verification summary, outcome, opaque evidence ID). This Proposed record is not that receipt. The receipt binds the re-spike head. It is not a sentence in this file: committing it would change the head it names.
12. **Stderr flood.** The child writes fd 2. The case passes when fd 2 is `/dev/null`, the write adds nothing to the process sum, and there is no stderr pipe to probe. A pipe or socket on fd 2 fails the case. That pass does not fail the B3 cap verdict.

The spike B report gains §3.0 diagnosis records for any FAIL along the way. P0 still closes only on green on the shipped substrate.

## Out of scope / verified in re-spike

Malicious-plugin isolation is not part of this record and was not verified here. Plugin-to-plugin tampering, plugin-to-cache tampering, dumpable after `exec` or re-exec, and same-user file writes are recorded in [ADR-0004](0004-plugin-isolation-topology.md). The runtime, the pre-start helper cache, and same-UID access are trusted.

The checks below (B4's explicit budget, the descendant, the multi-writer, the mux open-loop, and the stderr flood) are the acceptance tests for the flow-control ceiling. Further edge cases of that ceiling belong to the harness PR, not to another section of this record:

- Call `PR_SET_NO_NEW_PRIVS` before installing the seccomp filter.
- Kill the process group, and set `PR_SET_CHILD_SUBREAPER`, so descendants are reaped.
- A drain-to-EOF timeout. Expiry is the flip condition.
- A TCP queue that still exceeds the reserved mux `getsockopt` values, and a later substrate whose stdout is a real pipe. Those show up as a failed re-spike check or a flip condition.

## Flip conditions

- A budget is `unsatisfiable` on the shipping runtime: a per-skb term `(sndbuf >> 1) - 64` is not positive, or `B_p`, `B_t`, or `B_g` is negative, and no portable `setsockopt` / `F_SETPIPE_SZ` reaches a non-negative budget. This reservation cannot enforce the configured caps. The track returns to the maintainer. The unshrunk queue is not adopted as the cap.
- An ordinary `write` or `sendmsg` without `MSG_SPLICE_PAGES`, from one thread of a child that does not raise `SO_SNDBUF` or `F_SETPIPE_SZ`, produces `stdoutUnread > K_in` or `stdinQueued > K_out`. The data ceiling is wrong on this kernel. The track returns to the maintainer. The observed occupancy is not adopted as the new `K`. Threads that stay inside `thread count × ((sndbuf >> 1) - 64)` and are faulted as `thread-writer` within 100 ms are the multi-writer pass.
- A `splice`, `vmsplice`, `sendfile`, or `IORING_OP_SPLICE` succeeds and leaves `stdoutUnread > K_in`, a `fork`, `vfork`, or `clone` without `CLONE_THREAD` is not rejected, a descendant still holds fd 0 or fd 1 after the process-group reap, or a write to fd 0 queues bytes on the parent's stdin socket. Confinement did not hold. The track returns to the maintainer. `K` is not raised to fit the extra bytes. A `thread-writer` fault within 100 ms is the multi-writer pass, not this condition.
- `muxUnread > K_mux_in` or `muxSendQueued > K_mux_out` under the open-loop mux load, or a later `getsockopt` of the mux socket is above the read-back taken before `connect`. The mux reservation was too small or did not stay pinned. The measured queue is not adopted as the new ceiling.
- fd 2 is a pipe or a socket. Stderr is `/dev/null`, so a fillable kernel queue would sit outside `totalGlobal`. The track returns to the maintainer.
- B1 on the frozen shape misses ≥ 5000 round-trip/s or p99 ≤ 10 ms under the default caps. Revisit `C` and `K_*` inside the inequalities. Do not remove the kernel term.
- B6 sibling cancel p99 exceeds 500 ms, or a correct plugin stalls because a grant could not be written ahead of payload. The parent's control-frame reservation was too small or too late.
- A later substrate whose stdout is a real pipe records `F_GETPIPE_SZ` as `K_in`. The assertion stays `≤ P` and `≤ T`.

## Sources

Live documents this record relies on, retrieved 2026-10-19:

- RFC 9113 §5.2, <https://www.rfc-editor.org/rfc/rfc9113.html#section-5.2>
- Linux socket(7), <https://man7.org/linux/man-pages/man7/socket.7.html>
- Linux unix(7), <https://man7.org/linux/man-pages/man7/unix.7.html>
- Linux `unix_stream_sendmsg` and `unix_inq_len` (`FIONREAD` payload), <https://github.com/torvalds/linux/blob/master/net/unix/af_unix.c>
- Linux `sock_alloc_send_pskb` and `skb_set_owner_w` (`truesize` charged to `sk_wmem_alloc`; unix `SIOCOUTQ` reads that counter), <https://github.com/torvalds/linux/blob/master/net/core/sock.c>
- Linux TCP `SIOCOUTQ` (`write_seq - snd_una`, data bytes), <https://github.com/torvalds/linux/blob/master/net/ipv4/tcp.c>
- Linux tcp(7) (buffer size set before `connect` or `listen`; `tcp_moderate_rcvbuf`, `tcp_rmem`, `tcp_wmem`), <https://man7.org/linux/man-pages/man7/tcp.7.html>
- Linux `__sock_set_rcvbuf` (`SOCK_RCVBUF_LOCK`) and `SO_SNDBUF` (`SOCK_SNDBUF_LOCK`), <https://github.com/torvalds/linux/blob/master/net/core/sock.c>; `tcp_rcvbuf_grow` and `tcp_sndbuf_expand` leave a locked buffer alone, <https://github.com/torvalds/linux/blob/master/net/ipv4/tcp_input.c>
- Linux `SOCK_MIN_SNDBUF`, <https://github.com/torvalds/linux/blob/master/include/net/sock.h>
- Linux `IORING_OP_SPLICE`, <https://github.com/torvalds/linux/blob/master/include/uapi/linux/io_uring.h>
- Linux F_SETPIPE_SZ, <https://man7.org/linux/man-pages/man2/f_setpipe_sz.2const.html> (man-pages 6.19)
- Linux pipe(7), <https://man7.org/linux/man-pages/man7/pipe.7.html>
- libuv processes guide, <https://docs.libuv.org/en/v1.x/guide/processes.html>
- libuv v1.x `uv__read` `alloc_cb` of `64 * 1024`, <https://github.com/libuv/libuv/blob/v1.x/src/unix/stream.c>
- Node.js v22 stream, child_process, net, and timers, <https://nodejs.org/docs/latest-v22.x/api/stream.html>, <https://nodejs.org/docs/latest-v22.x/api/child_process.html>, <https://nodejs.org/docs/latest-v22.x/api/net.html>, <https://nodejs.org/docs/latest-v22.x/api/timers.html>
- macOS getsockopt(2), <https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getsockopt.2.html>
- XNU `bsd/sys/pipe.h`, <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/pipe.h>
