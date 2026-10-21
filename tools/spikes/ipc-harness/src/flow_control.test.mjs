import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPair, stdinControlReserve } from './supervisor.mjs';
import { assessFlow, classifyWriterOverrun, FLOW_READ_BYTES, PROBE_INTERVAL_MS, OVERRUN_DEADLINE_MS } from './flow_budget.mjs';
import { fionread, measureFlowReserve, rcvbuf, siocoutq, sndbuf } from './flow_socket.mjs';
import { b3, holdAfterSibling, partialSnapshotInvalid, scoreUnenforced, t7Estimate, tripCaps } from './cases/b3-backpressure.mjs';
import { b4 } from './cases/b4-bounds.mjs';
import { encodeMux, encodeNdjson } from './framing.mjs';
import { delay, waitUntil } from './measure.mjs';

const enlargePath = fileURLToPath(new URL('./children/enlarge-stdout.mjs', import.meta.url));
const echoPath = fileURLToPath(new URL('./children/echo.mjs', import.meta.url));
const replyExitPath = fileURLToPath(new URL('./children/reply-exit.mjs', import.meta.url));
const crashPath = fileURLToPath(new URL('./children/crash-mid-call.mjs', import.meta.url));
const threadPath = fileURLToPath(new URL('./children/thread-writers.mjs', import.meta.url));

function stdoutPending(pair, pluginId, reserved) {
  return (fd) => {
    const rec = pair.sup.children.get(pluginId);
    if (rec && fd === rec.stdoutFd) return reserved.kIn + 1;
    return fionread(fd);
  };
}

function block(ms) {
  const start = Date.now();
  // Block the event loop without spinning, so the child can run the crossing
  // while this thread is held.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return Date.now() - start;
}

test('the revised T7 estimate fills the measured kernel terms', () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const est = t7Estimate(reserved);
  assert.ok(est);
  assert.equal(est.kIn, reserved.kIn);
  assert.equal(est.kOut, reserved.kOut);
  assert.equal(est.kMuxIn, reserved.kMuxIn);
  assert.equal(est.kMuxOut, reserved.kMuxOut);
  assert.equal(est.c, reserved.readBytes);
  assert.equal(est.r, 1);
  for (const row of est.rows) {
    assert.equal(row.s, row.totalGlobal - est.kMuxIn - est.kMuxOut - est.c);
    assert.equal(row.perProcess, Math.min(row.n * row.t + row.s + est.kMuxIn + est.kMuxOut + est.c, row.totalGlobal));
    assert.equal(row.perHost, est.r * row.perProcess);
    assert.equal(row.partialWithin, est.kIn + est.c <= row.p);
    assert.equal(row.totalWithin, est.kIn + est.kOut + est.c <= row.t);
  }
  const tripped = tripCaps({ hold: false });
  return tripped.then((row) => {
    assert.equal(row.detail?.t7?.kIn, reserved.kIn);
  });
});

test('same-host vacuity pair: enforcement off fails and enforced passes', { timeout: 40_000 }, async () => {
  const off = await tripCaps({ enforceFlow: false });
  const on = await tripCaps({ enforceFlow: true });
  assert.notEqual(off.outcome, 'invalid', JSON.stringify(off.detail));
  assert.notEqual(off.outcome, 'unsatisfiable', JSON.stringify(off.detail));
  const scored = scoreUnenforced(off);
  assert.equal(scored.outcome, 'scored', JSON.stringify(scored));
  assert.equal(scored.pass, false, JSON.stringify(scored));
  assert.ok(scored.failed.length > 0, JSON.stringify(scored));
  assert.equal(scored.failed.includes('partial'), scored.partial.over);
  assert.equal(scored.failed.includes('total'), scored.total.over);
  if (scored.partial.over) assert.ok(scored.partial.highWater > scored.partial.cap, JSON.stringify(scored.partial));
  if (scored.total.over) assert.ok(scored.total.accounted > scored.total.cap, JSON.stringify(scored.total));
  assert.ok(scored.partial.capacity > 0, JSON.stringify(scored.partial));
  assert.ok(scored.total.capacity > 0, JSON.stringify(scored.total));
  assert.equal(off.pass, false, JSON.stringify(off.detail));
  assert.equal(on.outcome, 'scored', JSON.stringify(on.detail));
  assert.equal(on.pass, true, JSON.stringify(on.detail));
  assert.equal(on.detail.mux.kMuxIn, on.detail.mux.muxRcvbuf);
  assert.equal(on.detail.mux.kMuxOut, on.detail.mux.muxSndbuf);
  assert.ok(on.detail.mux.kMuxIn > 0);
  assert.equal(on.detail.mux.muxReserve, on.detail.mux.kMuxIn + on.detail.mux.kMuxOut + FLOW_READ_BYTES);
});

test('the unenforced control fails when enforcement makes no difference', async () => {
  const inside = {
    outcome: 'scored',
    pass: false,
    detail: {
      partial: { highWater: 1024, cap: 32 * 1024, capacity: 65536 },
      total: { accounted: 2048, cap: 48 * 1024, capacity: 65536 },
    },
  };
  const result = await b3({ hold: false, unenforced: inside });
  assert.equal(result.outcome, 'scored');
  assert.equal(result.pass, false);
  assert.equal(result.detail.reason, 'unenforced-within-caps');
  assert.equal(result.detail.unenforcedPass, true);
  assert.deepEqual(result.detail.vacuity.failed, []);
  assert.equal(result.detail.vacuity.partial.highWater, 1024);
  assert.equal(result.detail.vacuity.partial.over, false);
  assert.equal(result.detail.vacuity.total.accounted, 2048);
  assert.equal(result.detail.vacuity.total.over, false);
});

test('a literal 4096 total cap is unsatisfiable before spawn', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 64 * 1024, total: 4096, totalGlobal: 1024 * 1024 },
  });
  try {
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'echo', script: echoPath, total: 4096 }),
      (err) => err.code === 'unsatisfiable',
    );
    assert.equal(pair.sup.children.size, 0);
  } finally {
    await pair.close();
  }
});

test('a per-child budget below the kernel reserve is rejected before spawn', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 64 * 1024, total: 1024 * 1024, totalGlobal: 1024 * 1024 },
  });
  try {
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'echo', script: enlargePath, total: 1024 }),
      (err) => err.code === 'unsatisfiable',
    );
    assert.equal(pair.sup.children.size, 0);
  } finally {
    await pair.close();
  }
});

test('a missing partial snapshot is invalid and a missing fault is not', () => {
  const fault = { stdoutUnread: null, kIn: 1, pendingBytes: 1, inFlightTailBytes: 0 };
  assert.equal(partialSnapshotInvalid(true, fault), true);
  assert.equal(partialSnapshotInvalid(false, fault), false);
  assert.equal(partialSnapshotInvalid(true, null), false);
  assert.equal(partialSnapshotInvalid(true, {
    stdoutUnread: 0,
    kIn: 1,
    pendingBytes: 1,
    inFlightTailBytes: 0,
  }), false);
});

test('an injected reservation that does not fit is unsatisfiable, not invalid', async () => {
  const result = await tripCaps({
    reserve: { sndbufIn: 200_000, sndbufOut: 200_000, readBytes: 4096 },
  });
  assert.equal(result.outcome, 'unsatisfiable');
  assert.equal(result.pass, false);
  assert.equal(result.detail.protocol, '3.0');
  const direct = assessFlow({
    partialCap: 32 * 1024,
    totalCap: 48 * 1024,
    totalGlobal: 1024 * 1024,
    sndbufIn: 200_000,
    sndbufOut: 200_000,
    readBytes: 4096,
    childCount: 1,
  });
  assert.equal(direct.outcome, 'unsatisfiable');
});

test('paused probe faults a buffer enlarger within 100 ms', { timeout: 15_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved, 'helper unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'plerni-enlarge-'));
  const go = join(dir, 'go');
  const ready = join(dir, 'ready');
  const held = join(dir, 'block');
  const mark = join(dir, 'mark');
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({
      pluginId: 'enlarge',
      script: enlargePath,
      env: {
        ENLARGE_GO: go,
        ENLARGE_READY: ready,
        ENLARGE_BLOCK: held,
        ENLARGE_MARK: mark,
        RESERVED_K: String(reserved.kIn),
      },
    });
    const rec = pair.sup.children.get('enlarge');
    // Pause before the event loop reads. The 20 ms probe is what has to see
    // the enlarged queue; a read callback would consume the crossing.
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.child.stdout.pause();
    writeFileSync(go, '1');
    const poised = await waitUntil(() => existsSync(ready), 2_000);
    assert.equal(poised, true, 'child did not reach the pre-crossing wait');
    const blockStart = Date.now();
    writeFileSync(held, '1');
    const lag = block(50);
    const blockEnd = Date.now();
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'enlarge' && fault.code === 'buffer-enlarged'),
      1_000,
    );
    assert.equal(faulted, true, JSON.stringify(pair.sup.faults));
    const observed = Date.now();
    const text = readFileSync(mark, 'utf8').trim().split(/\s+/);
    assert.equal(classifyWriterOverrun(text[0]), 'enlarger');
    const marked = Number(text[1]);
    assert.ok(marked >= blockStart && marked <= blockEnd, JSON.stringify({ marked, blockStart, blockEnd }));
    const elapsed = observed - marked;
    assert.ok(elapsed >= 0 && elapsed < OVERRUN_DEADLINE_MS, String(elapsed));
    assert.ok(PROBE_INTERVAL_MS + lag < OVERRUN_DEADLINE_MS, String(lag));
    const fault = pair.sup.faults.find((row) => row.code === 'buffer-enlarged');
    assert.ok(fault.stdoutUnread > fault.kIn, JSON.stringify(fault));
    assert.equal(fault.kIn, reserved.kIn);
  } finally {
    await pair.close();
  }
});

test('a reply larger than B_t is rejected before it is queued', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  // The port stays authorized. The extra grant is what makes the mux reply
  // larger than the child's own line, and larger than B_t.
  const grants = ['db', 'g'.repeat(4000)];
  const reply = encodeMux({
    kind: 'result',
    for: 'call',
    pluginId: 'echo',
    correlationId: 1,
    payload: { n: 1 },
    sendTs: 0,
    ingressTs: 0,
    egressTs: 0,
    version: '0.0.0',
    generation: 1,
    grants,
  });
  const callLine = encodeNdjson({
    kind: 'call',
    correlationId: 1,
    port: 'db',
    method: 'get',
    payload: { n: 1 },
  });
  const callBytes = Buffer.byteLength(callLine)
    + Buffer.byteLength(JSON.stringify('echo'))
    + Buffer.byteLength(JSON.stringify(1));
  // The call has to leave room for one cancel and one grant beside B_t.
  const reserve = stdinControlReserve();
  const userspace = callBytes + reserve.total + 64;
  assert.ok(reply.length > userspace);
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 64 * 1024,
      total: userspace + reserved.perChild,
      totalGlobal: 1024 * 1024,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      grants,
      total: userspace + reserved.perChild,
    });
    const rec = pair.sup.children.get('echo');
    assert.equal(rec.bT, userspace);
    rec.paused = true;
    rec.child.kill('SIGSTOP');
    const call = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 1_000).catch((err) => err);
    const armed = await waitUntil(() => rec.callPending === 1, 1_000);
    assert.equal(armed, true);
    const line = encodeNdjson({ kind: 'result', correlationId: 1, payload: { n: 1 } });
    rec.paused = false;
    rec.child.stdout.emit('data', Buffer.from(line));
    const settled = await call;
    assert.equal(settled.code, 'total-cap');
    assert.equal(rec.loBytes + rec.hiBytes, 0);
    assert.ok(rec.deferredBytes <= rec.bT, String(rec.deferredBytes));
  } finally {
    const rec = pair.sup.children.get('echo');
    if (rec && rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    await pair.close();
  }
});

test('a result written before exit is delivered', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.child.kill('SIGSTOP');
    const call = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 2_000).catch((err) => err);
    const armed = await waitUntil(() => rec.callPending === 1, 1_000);
    assert.equal(armed, true);
    const line = Buffer.from(encodeNdjson({ kind: 'result', correlationId: 1, payload: { ok: true } }));
    writeSync(rec.stdoutWriter, line);
    rec.child.kill('SIGKILL');
    const settled = await call;
    assert.equal(settled.payload?.ok, true, JSON.stringify(settled));
  } finally {
    await pair.close();
  }
});

test('a child that writes its reply and exits is delivered', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'reply', script: replyExitPath });
    const rec = pair.sup.children.get('reply');
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.stdoutSocket.pause();
    let heldOnExit = false;
    rec.child.on('exit', () => {
      heldOnExit = rec.exitDrain === true
        && rec.dead === false
        && rec.exited === true
        && pair.sup.tokenIsLive(kid.token) === false
        && Number.isInteger(rec.stdinProbe)
        && rec.stdoutSocket != null
        && rec.stdoutSocket.destroyed === false;
    });
    const settled = await pair.stub.call({
      pluginId: 'reply',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 2_000).catch((err) => err);
    assert.equal(settled.payload?.ok, true, JSON.stringify(settled));
    assert.equal(heldOnExit, true);
    assert.equal(rec.exitCode, 0);
    const released = await waitUntil(
      () => rec.dead === true && rec.stdinProbe == null && rec.stdoutSocket == null && rec.stdoutWriter == null,
      1_000,
    );
    assert.equal(released, true);
  } finally {
    await pair.close();
  }
});

test('a drain that never reaches EOF releases on the deadline', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const drainMs = 80;
  const userspace = 8192;
  const pair = await connectPair({
    sweeper: false,
    exitDrainMs: drainMs,
    caps: {
      partial: 64 * 1024,
      total: reserved.perChild + userspace,
      totalGlobal: reserved.perChild + reserved.muxReserve + userspace,
    },
  });
  let held = null;
  try {
    const kid = pair.sup.spawn({
      pluginId: 'crash',
      script: crashPath,
      total: reserved.perChild + userspace,
    });
    const rec = pair.sup.children.get('crash');
    let drainAt = 0;
    rec.child.on('exit', () => {
      drainAt = Date.now();
    });
    // A leftover write end is what keeps stdout from reaching EOF after the
    // child and the supervisor's writer dup are both gone.
    held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: ['ignore', 'ignore', 'ignore', rec.stdoutWriter],
    });
    const call = pair.stub.call({
      pluginId: 'crash',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 2_000).catch((err) => err);
    const draining = await waitUntil(() => rec.exitDrain === true && rec.dead === false, 1_000);
    assert.equal(draining, true);
    assert.equal(Number.isInteger(rec.stdinProbe), true);
    assert.ok(rec.stdoutSocket);
    assert.throws(
      () => pair.sup.spawn({
        pluginId: 'other',
        script: echoPath,
        total: reserved.perChild + userspace,
      }),
      (err) => err.code === 'unsatisfiable',
    );
    const released = await waitUntil(
      () => rec.dead === true && rec.stdinProbe == null && rec.stdoutSocket == null && rec.stdoutWriter == null,
      1_000,
    );
    const elapsed = Date.now() - drainAt;
    assert.equal(released, true);
    assert.ok(elapsed >= drainMs - 20, String(elapsed));
    const settled = await call;
    assert.equal(settled.code, 'drain-timeout', JSON.stringify(settled));
    assert.equal(pair.sup.flip, 'drain-timeout');
    assert.equal(pair.sup.faults.some((fault) => fault.code === 'drain-timeout'), true);
    const second = pair.sup.spawn({
      pluginId: 'other',
      script: echoPath,
      total: reserved.perChild + userspace,
    });
    assert.ok(second.pid);
  } finally {
    if (held && held.exitCode == null && held.signalCode == null) held.kill('SIGKILL');
    await pair.close();
  }
});

test('an unavailable B4 reservation is invalid', async () => {
  const result = await b4({ reserve: null });
  assert.equal(result.pass, null);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail.reason, 'reservation-unavailable');
});

test('a null FIONREAD mid-run is invalid instead of stalling', async () => {
  const pair = await connectPair({
    sweeper: false,
    flowPending: () => null,
    caps: { partial: 64 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const seen = await waitUntil(() => pair.sup.invalidReason === 'fionread-unavailable', 1_000);
    assert.equal(seen, true);
    assert.equal(pair.sup.faults.length, 0);
    assert.equal(pair.sup.children.get('echo').dead, false);
  } finally {
    await pair.close();
  }
});

test('a null writer SO_SNDBUF on overrun is invalid', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    flowPending: (fd) => stdoutPending(pair, 'echo', reserved)(fd),
    readSndbuf: () => null,
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.child.stdout.pause();
    const seen = await waitUntil(() => pair.sup.invalidReason === 'sndbuf-unavailable', 1_000);
    assert.equal(seen, true);
    assert.equal(pair.sup.faults.length, 0);
  } finally {
    await pair.close();
  }
});

test('an overrun at the reserved SO_SNDBUF is thread-writer', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  // Unread is injected above K on stdout only. The buffer size is the live
  // getsockopt on the writer dup, which the child has not raised, so the
  // fault is thread-writer rather than buffer-enlarged.
  const pair = await connectPair({
    sweeper: false,
    flowPending: (fd) => stdoutPending(pair, 'echo', reserved)(fd),
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.code === 'thread-writer'),
      1_000,
    );
    assert.equal(faulted, true, JSON.stringify({
      faults: pair.sup.faults,
      invalid: pair.sup.invalidReason,
    }));
    const fault = pair.sup.faults.find((row) => row.code === 'thread-writer');
    assert.ok(fault.stdoutUnread > fault.kIn, JSON.stringify(fault));
    assert.equal(fault.kIn, reserved.kIn);
    assert.equal(pair.sup.invalidReason, null);
    assert.equal(pair.sup.faults.some((row) => row.code === 'buffer-enlarged'), false);
  } finally {
    await pair.close();
  }
});

test('an overrun is typed when the child exits before the paused probe', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    flowPending: (fd) => stdoutPending(pair, 'echo', reserved)(fd),
    readSndbuf: () => reserved.sndbufIn + 4096,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.stdoutSocket.pause();
    rec.child.kill('SIGKILL');
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.code === 'buffer-enlarged'),
      1_000,
    );
    assert.equal(faulted, true, JSON.stringify({
      faults: pair.sup.faults,
      invalid: pair.sup.invalidReason,
    }));
    const fault = pair.sup.faults.find((row) => row.code === 'buffer-enlarged');
    assert.ok(fault.stdoutUnread > fault.kIn, JSON.stringify(fault));
    const released = await waitUntil(
      () => rec.dead === true && rec.stdinProbe == null && rec.stdoutSocket == null,
      1_000,
    );
    assert.equal(released, true);
    assert.equal(pair.sup.invalidReason, null);
  } finally {
    await pair.close();
  }
});

test('a reply that does not fit beside charged bytes is rejected and not retained', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const userspace = 8192;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 64 * 1024,
      total: reserved.perChild + userspace,
      totalGlobal: 1024 * 1024,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      total: reserved.perChild + userspace,
    });
    const rec = pair.sup.children.get('echo');
    assert.equal(rec.bT, userspace);
    rec.paused = true;
    rec.child.kill('SIGSTOP');
    const call = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 1_000).catch((err) => err);
    const armed = await waitUntil(() => rec.callPending === 1, 1_000);
    assert.equal(armed, true);
    rec.loBytes = rec.bT;
    const line = encodeNdjson({ kind: 'result', correlationId: 1, payload: { n: 1 } });
    rec.paused = false;
    rec.child.stdout.emit('data', Buffer.from(line));
    const settled = await call;
    assert.equal(settled.code, 'total-cap', JSON.stringify(settled));
    assert.equal(rec.deferred.length, 0);
    assert.equal(rec.dead, false);
  } finally {
    const rec = pair.sup.children.get('echo');
    if (rec && rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    await pair.close();
  }
});

test('an invalid hold discovered during the sibling wait cannot score as a pass', () => {
  const base = {
    growth: 10,
    measurable: true,
    answered: true,
    near: { pending: true, partial: true, bytes: true, lo: true },
  };
  const invalid = holdAfterSibling(
    { invalidReason: 'fionread-unavailable', flip: 'stdin-overrun' },
    true,
    base,
  );
  assert.equal(invalid.invalidReason, 'fionread-unavailable');
  assert.equal(invalid.flip, undefined);
  assert.equal(invalid.measurable, false);
  assert.equal(invalid.answered, false);
  assert.equal(invalid.growth, null);
  const flipped = holdAfterSibling({ invalidReason: null, flip: 'stdin-overrun' }, true, base);
  assert.equal(flipped.flip, 'stdin-overrun');
  assert.equal(flipped.invalidReason, undefined);
  assert.equal(flipped.answered, false);
});

function drainStdout(fd) {
  const buf = Buffer.alloc(8192);
  for (let i = 0; i < 64; i++) {
    const n = fionread(fd) ?? 0;
    if (n <= 0) return;
    try {
      readSync(fd, buf, 0, Math.min(buf.length, n), null);
    } catch {
      return;
    }
  }
}

test('child threads are classified as a thread writer only when the live queue crosses K_in', { timeout: 30_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const dir = mkdtempSync(join(tmpdir(), 'plerni-threads-'));
  const go = join(dir, 'go');
  const marks = join(dir, 'marks');
  mkdirSync(marks);
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  const attempts = 40;
  try {
    pair.sup.spawn({
      pluginId: 'threads',
      script: threadPath,
      env: {
        THREAD_GO: go,
        THREAD_MARK: marks,
        THREAD_COUNT: '4',
        THREAD_ATTEMPTS: String(attempts),
        RESERVED_K: String(reserved.kIn),
      },
    });
    const rec = pair.sup.children.get('threads');
    // The probe still runs while the socket is paused. It is what scores
    // stdoutUnread > K_in. A read would hide the crossing.
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.stdoutSocket?.pause();
    rec.child.stdout?.pause();
    let peak = 0;
    let lag = 0;
    let fault = null;
    for (let attempt = 1; attempt <= attempts && !fault; attempt++) {
      writeFileSync(go, String(attempt));
      // Hold the event loop across the burst. The child runs while this waits.
      lag = block(50);
      const mark = join(marks, String(attempt));
      const marked = await waitUntil(() => existsSync(mark), 2_000);
      assert.equal(marked, true, `attempt ${attempt} produced no mark`);
      await delay(5);
      const unread = fionread(rec.stdoutFd) ?? 0;
      if (unread > peak) peak = unread;
      const text = readFileSync(mark, 'utf8').trim().split(/\s+/);
      assert.equal(classifyWriterOverrun(text[0]), 'thread-writer');
      const crossedAt = Number(text[1]);
      const written = Number(text[2]);
      const forkErrno = Number(text[3]);
      assert.equal(forkErrno, 1);
      assert.ok(written > 0, String(written));
      fault = pair.sup.faults.find((row) => row.code === 'thread-writer') ?? null;
      const crossed = unread > reserved.kIn || written > reserved.kIn || fault != null;
      if (!crossed) {
        assert.equal(pair.sup.faults.some((row) => row.code === 'buffer-enlarged'), false);
        if (!rec.dead) drainStdout(rec.stdoutFd);
        continue;
      }
      while (!fault && Date.now() - crossedAt < OVERRUN_DEADLINE_MS) {
        await delay(5);
        const unreadAgain = fionread(rec.stdoutFd) ?? 0;
        if (unreadAgain > peak) peak = unreadAgain;
        fault = pair.sup.faults.find((row) => row.code === 'thread-writer') ?? null;
      }
      assert.ok(fault, JSON.stringify({
        peak, unread, written, kIn: reserved.kIn, faults: pair.sup.faults, invalid: pair.sup.invalidReason,
      }));
      const elapsed = Date.now() - crossedAt;
      assert.ok(elapsed >= 0 && elapsed < OVERRUN_DEADLINE_MS, String(elapsed));
      assert.ok(PROBE_INTERVAL_MS + lag < OVERRUN_DEADLINE_MS, String(lag));
      assert.ok(fault.stdoutUnread > fault.kIn, JSON.stringify(fault));
      assert.equal(fault.kIn, reserved.kIn);
      assert.equal(pair.sup.invalidReason, null);
      assert.equal(pair.sup.faults.some((row) => row.code === 'buffer-enlarged'), false);
      assert.ok(peak > reserved.kIn || fault.stdoutUnread > reserved.kIn);
      break;
    }
    assert.ok(fault, JSON.stringify({ peak, kIn: reserved.kIn, faults: pair.sup.faults }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await pair.close();
  }
});

test('a blocked stdin write stays inside K_out', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    await new Promise((resolve, reject) => {
      rec.child.stdin.write(Buffer.alloc(1024, 0x61), (err) => (err ? reject(err) : resolve()));
    });
    const queued = fionread(rec.stdinProbe);
    assert.ok(Number.isInteger(queued) && queued > 0 && queued <= rec.kOut, String(queued));
    assert.equal(pair.sup.flip, null);
    rec.child.kill('SIGKILL');
  } finally {
    await pair.close();
  }
});

test('stdin queued above K_out is a flip', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    flowPending: (fd) => {
      const rec = pair.sup.children.get('echo');
      if (rec && fd === rec.stdinProbe) return rec.kOut + 1;
      return fionread(fd);
    },
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    await new Promise((resolve, reject) => {
      rec.child.stdin.write(Buffer.from('x'), (err) => (err ? reject(err) : resolve()));
    });
    const flipped = await waitUntil(() => pair.sup.flip === 'stdin-overrun', 1_000);
    assert.equal(flipped, true, JSON.stringify({ flip: pair.sup.flip, faults: pair.sup.faults }));
    const fault = pair.sup.faults.find((row) => row.code === 'stdin-overrun');
    assert.ok(fault);
    assert.ok(fault.stdinQueued > fault.kOut, JSON.stringify(fault));
  } finally {
    await pair.close();
  }
});

test('a mux read waits for FIONREAD inside K_mux_in and room for C', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const tight = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: reserved.muxReserve },
  });
  try {
    tight.stub.socket.write(Buffer.alloc(64, 0x61));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(tight.sup.muxReadHigh, 0);
    const queued = fionread(tight.sup.muxFd);
    assert.ok(queued > 0, String(queued));
    assert.equal(tight.sup.flip, null);
  } finally {
    await tight.close();
  }
  const holder = { block: false };
  const pair = await connectPair({
    sweeper: false,
    muxPending: (fd) => (holder.block ? pair.sup.kMuxIn + 1 : fionread(fd)),
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    holder.block = true;
    pair.sup.socket.pause();
    pair.sup.muxReadPosted = false;
    const flipped = await waitUntil(() => pair.sup.flip === 'mux-unread', 1_000);
    assert.equal(flipped, true, pair.sup.flip);
    assert.equal(pair.sup.muxReadPosted, false);
  } finally {
    await pair.close();
  }
});

test('mux open-loop queues stay inside the read-back buffers', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    const sup = pair.sup;
    assert.equal(sup.kMuxIn, sup.muxRcvbuf);
    assert.equal(sup.kMuxOut, sup.muxSndbuf);
    sup.socket.pause();
    sup.muxReadPosted = false;
    pair.stub.socket.pause();
    const chunk = Buffer.alloc(16 * 1024, 0x6d);
    let unread = 0;
    for (let i = 0; i < 64; i++) {
      const ok = pair.stub.socket.write(chunk);
      unread = fionread(sup.muxFd) ?? 0;
      if (!ok || unread >= sup.kMuxIn) break;
    }
    assert.ok(unread > 0, String(unread));
    assert.ok(unread <= sup.kMuxIn, `${unread} > ${sup.kMuxIn}`);
    let outq = 0;
    let admitted = false;
    for (let i = 0; i < 64; i++) {
      admitted = sup.queueMuxBytes(chunk);
      outq = siocoutq(sup.muxFd) ?? 0;
      if (!admitted || outq >= sup.kMuxOut) break;
    }
    assert.equal(admitted, true);
    assert.ok(outq > 0, String(outq));
    assert.ok(outq <= sup.kMuxOut, `${outq} > ${sup.kMuxOut}`);
    // libuv may still hold the tail. That tail is socketOutbound; a raw write would leave it out.
    assert.ok(sup.socket.writableLength > 0, String(sup.socket.writableLength));
    assert.ok(sup.socketOutbound >= sup.socket.writableLength, `${sup.socketOutbound} < ${sup.socket.writableLength}`);
    assert.ok(sndbuf(sup.muxFd) <= sup.muxSndbuf);
    assert.ok(rcvbuf(sup.muxFd) <= sup.muxRcvbuf);
    assert.ok(sup.muxReadHigh <= FLOW_READ_BYTES);
    const sum = sup.bufferedBytes() + (fionread(sup.muxFd) ?? 0) + (siocoutq(sup.muxFd) ?? 0);
    assert.ok(sum <= sup.capsConfig.totalGlobal, String(sum));
    assert.equal(sup.flip, null);
  } finally {
    await pair.close();
  }
});

test('bytes already handed to the mux socket count against the send reservation', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 8 * 1024 * 1024 },
  });
  try {
    const sup = pair.sup;
    pair.stub.socket.pause();
    // libuv still holds this much. SIOCOUTQ does not include it yet, and a
    // further small frame must wait instead of landing past K_mux_out.
    sup.socketOutbound = sup.kMuxOut - 10;
    const before = sup.socketOutbound;
    const frame = Buffer.alloc(100, 0x61);
    assert.equal(sup.queueMuxBytes(frame), true);
    assert.equal(sup.flip, null);
    assert.equal(sup.invalidReason, null);
    assert.equal(sup.socketOutbound, before);
    assert.ok(sup.queuedBytes >= frame.length);
    const outq = siocoutq(sup.muxFd);
    assert.ok(Number.isInteger(outq) && outq <= sup.kMuxOut, String(outq));
  } finally {
    await pair.close();
  }
});

test('a burst of mux frames stays inside the send reservation', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 8 * 1024 * 1024 },
  });
  try {
    const sup = pair.sup;
    pair.stub.socket.pause();
    const frame = Buffer.alloc(1100, 0x61);
    for (let i = 0; i < 64; i++) sup.queueMuxBytes(frame);
    await delay(100);
    const outq = siocoutq(sup.muxFd);
    assert.equal(sup.flip, null);
    assert.equal(sup.invalidReason, null);
    assert.ok(Number.isInteger(outq) && outq <= sup.kMuxOut, `${outq} > ${sup.kMuxOut}`);
  } finally {
    await pair.close();
  }
});

test('unenforced b3 classifies a missing helper as invalid', async () => {
  const result = await b3({ hold: false, helperAvailable: () => false });
  assert.equal(result.pass, null);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail.reason, 'reservation-unavailable');
});
