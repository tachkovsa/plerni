// supervisor.test.mjs — deterministic B4/B5/B6 checks. Performance windows stay in the spike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { b4, childAlive } from './cases/b4-bounds.mjs';
import { b5 } from './cases/b5-crash.mjs';
import { b2 } from './cases/b2-fencing.mjs';
import { b3, partialFrameHighWater, scoreTotalProbe, tripCaps } from './cases/b3-backpressure.mjs';
import { fileURLToPath } from 'node:url';
import { b1 } from './cases/b1-throughput.mjs';
import { applyScoredSkip, floodBound, floodScore, forgedFlood, hostileBattery, starvation } from './cases/b6-mux-identity.mjs';
import { assessEnvironment, delay, measureSeries, openLoop, preflight, treeRss, waitUntil } from './measure.mjs';
import { MuxFramer, encodeMux, encodeNdjson } from './framing.mjs';
import { FencedError } from './authority.mjs';
import { DEFAULT_CAPS, PARTIAL_READ_CHUNK, Supervisor, connectEnds, connectPair, dbConfigured, partialCapHolds, stdinControlReserve, totalCapHolds } from './supervisor.mjs';
import { socketPair } from './kernel-stub.mjs';
import { entryIsPrivate, resolveCacheDir } from './pipe_pending.mjs';
import { closeFd, dupFd, fionread, measureFlowReserve } from './flow_socket.mjs';
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const echoPath = fileURLToPath(new URL('./children/echo.mjs', import.meta.url));
const creditPath = fileURLToPath(new URL('./children/credit-wait.mjs', import.meta.url));
const responsePath = fileURLToPath(new URL('./children/credit-response.mjs', import.meta.url));
const floodPath = fileURLToPath(new URL('./children/flood.mjs', import.meta.url));
const ignorePath = fileURLToPath(new URL('./children/ignore-cancel.mjs', import.meta.url));
const validEnv = () => ({ valid: true, throttled: false, overloaded: false, cpus: 1, load: 0, cpuUnlimited: true });

test('oversize mux call rejects before a waiter is armed', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const err = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: 'x'.repeat(1024 * 1024),
    }, 300).catch((e) => e);
    assert.equal(err.constructor.name, 'MuxOversizeError');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pair.stub.calls.size, 0);
  } finally {
    await pair.close();
  }
});

test('preflight records a validity bit', () => {
  const env = preflight();
  assert.equal(typeof env.valid, 'boolean');
  assert.equal(typeof env.throttled, 'boolean');
});

test('B4 bounds', { timeout: 20_000 }, async () => {
  const result = await b4();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B5 crash typed error', { timeout: 20_000, skip: dbConfigured() ? false : 'no harness database' }, async () => {
  const result = await b5();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B3 caps trip', { timeout: 20_000 }, async () => {
  const result = await tripCaps();
  const total = result.detail.total;
  const cap = 48 * 1024;
  assert.equal(result.detail.pending.admitted, 4);
  assert.ok(result.detail.pending.rejected > 0);
  const partial = result.detail.partial;
  assert.equal(
    partial.highWater,
    partialFrameHighWater(partial.pendingBytes, partial.inFlightTailBytes, partial.stdoutUnread),
  );
  assert.equal(
    partial.bound,
    partial.code === 'partial-cap'
      && partial.stdoutUnread <= partial.kIn
      && partialCapHolds(partial.highWater, 32 * 1024)
      && partialCapHolds(36864 + 32768, 32 * 1024) === false,
  );
  assert.equal(total.tripped, true);
  assert.equal(total.vacuity, true);
  assert.equal(total.accounted, total.buffered + total.pipeUnread + total.stdinQueued);
  assert.ok(total.pipeCapacity > 0, String(total.pipeCapacity));
  assert.ok(total.pipeUnread <= total.pipeCapacity, String(total.pipeUnread));
  assert.equal(total.bound, totalCapHolds(total.accounted, cap));
  assert.equal(result.detail.kernel.bound, true);
  assert.equal(result.detail.kernelBytes.tripped, true);
  assert.equal(result.outcome, 'scored');
  assert.equal(
    result.pass,
    Boolean(result.detail.pending.tripped && result.detail.pending.rejected > 0 && result.detail.pending.admitted === 4
      && partial.tripped && partial.bound
      && total.tripped && total.bound && total.vacuity
      && result.detail.kernel.tripped && result.detail.kernel.bound
      && result.detail.kernelBytes.tripped && result.detail.kernelBytes.bound),
  );
});

test('partial high-water counts the tail and the kernel unread bytes', () => {
  const cap = 32 * 1024;
  assert.equal(partialFrameHighWater(36864, 32768, 0), 69632);
  assert.equal(partialCapHolds(partialFrameHighWater(36864, 32768, 0), cap), false);
  assert.equal(partialCapHolds(cap + 4096, cap), false);
  assert.equal(partialCapHolds(cap, cap), true);
  assert.equal(partialCapHolds(0, cap, { afterCleanup: true }), false);
  assert.equal(partialFrameHighWater(36864, null), null);
  assert.equal(partialCapHolds(partialFrameHighWater(36864, null), cap), false);
});

test('a missing pipe probe is an invalid run', { timeout: 20_000 }, async () => {
  const missing = scoreTotalProbe({
    pipeUnread: null,
    pipeCapacity: null,
    accounted: null,
    cap: 48 * 1024,
    afterCleanup: 0,
  });
  assert.equal(missing.outcome, 'invalid');
  assert.equal(missing.bound, null);
  const noUnread = scoreTotalProbe({
    pipeUnread: null,
    pipeCapacity: 131072,
    accounted: 106496,
    cap: 48 * 1024,
    afterCleanup: 0,
  });
  assert.equal(noUnread.outcome, 'invalid');
  assert.equal(noUnread.bound, null);
  const measuredMiss = scoreTotalProbe({
    pipeUnread: 8192,
    pipeCapacity: 131072,
    accounted: 106496,
    cap: 48 * 1024,
    afterCleanup: 0,
  });
  assert.equal(measuredMiss.outcome, 'scored');
  assert.equal(measuredMiss.bound, false);
  const result = await b3({ hold: false, pipeProbe: () => null });
  assert.equal(result.pass, null);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail.reason, 'pipe-probe-unavailable');
  assert.equal(result.detail.caps.reason, 'fionread-unavailable');
  assert.equal(result.detail.caps.total, undefined);
});

test('pipe helper cache is a private directory', () => {
  const dir = resolveCacheDir();
  assert.equal(typeof dir, 'string');
  const shared = join(tmpdir(), `plerni-pipe-pending-${process.versions.modules}`);
  assert.notEqual(dir, shared);
  assert.equal(entryIsPrivate(lstatSync(dir), process.getuid(), 'dir'), true);
  const uid = process.getuid();
  assert.equal(entryIsPrivate({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid, mode: 0o100700 }, uid, 'file'), true);
  assert.equal(entryIsPrivate({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid, mode: 0o100644 }, uid, 'file'), false);
  assert.equal(entryIsPrivate({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true, uid, mode: 0o100700 }, uid, 'file'), false);
  assert.equal(entryIsPrivate({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid: uid + 1, mode: 0o100700 }, uid, 'file'), false);
});

test('B6 hostile battery rejects forged identity', { timeout: 20_000 }, async () => {
  const result = await hostileBattery({ stampIdentity: true });
  assert.equal(result.pass, true, JSON.stringify(result.checks));
});

test('B6 vacuity without identity stamping delivers the forged result', { timeout: 20_000 }, async () => {
  const result = await hostileBattery({ stampIdentity: false });
  assert.equal(result.pass, false);
  assert.equal(result.exploit, true);
  assert.equal(result.checks.routing, true);
  assert.equal(result.checks.mismatch, true);
  assert.equal(result.checks.stale, true);
});

test('B6 silent child does not starve a sibling', { timeout: 20_000 }, async () => {
  const result = await starvation();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('B6 forged-result flood faults at the hi cap', { timeout: 20_000 }, async () => {
  const result = await forgedFlood();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('openLoop counts slots skipped while behind', async () => {
  let ticks = 0;
  const result = await openLoop({
    ms: 200,
    rate: 1_000,
    tick: () => {
      ticks++;
      if (ticks === 1) {
        const end = performance.now() + 80;
        while (performance.now() < end) { /* fall behind the schedule */ }
      }
    },
  });
  assert.ok(result.skipped > 0);
  assert.equal(result.offered, result.issued + result.skipped);
});

test('invalid preflight does not apply thresholds', async () => {
  const result = await b1({
    warmupMs: 0,
    windowMs: 20,
    reps: 1,
    preflight: () => ({ valid: false, throttled: true, overloaded: false, cpus: 1, load: 0, cpuUnlimited: false }),
  });
  assert.equal(result.pass, null);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail.targetRate, undefined);
  assert.equal(result.detail.p99Ms, undefined);
});

test('measureSeries does not score an invalid environment', async () => {
  let accepted = 0;
  const series = await measureSeries({
    reps: 1,
    preflightFn: () => ({ valid: false, throttled: true, overloaded: false, cpus: 1, load: 0, cpuUnlimited: false }),
    runRep: async () => ({ achieved: 1, p99: 9_999 }),
  });
  if (series.outcome === 'scored') accepted++;
  assert.equal(series.pass, null);
  assert.equal(series.outcome, 'invalid');
  assert.equal(accepted, 0);
  assert.equal(series.rerun[0].p99, 9_999);
});

test('B2 fencing labels', { timeout: 20_000, skip: dbConfigured() ? false : 'no harness database' }, async () => {
  const result = await b2();
  assert.equal(result.pass, true, JSON.stringify(result.detail));
});

test('spawn grants stay bound after the caller mutates them', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const supplied = ['db'];
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, grants: supplied, version: '1.2.3' });
    supplied.push('admin');
    kid.credential.grants.push('admin');
    const internal = pair.sup.children.get('echo').credential.grants;
    assert.deepEqual([...internal], ['db']);
    const widened = await pair.stub.call({
      pluginId: 'echo',
      credential: { ...kid.credential, grants: ['db', 'admin'] },
      correlationId: 1,
      port: 'admin',
      method: 'get',
      payload: { ok: true },
    }, 500).catch((err) => err);
    assert.equal(widened.code, 'credential-mismatch');
  } finally {
    await pair.close();
  }
});

test('respawn keeps grants, version, and per-plugin limits', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      grants: ['db'],
      version: '1.2.3',
      pending: 3,
      total: 80_000,
    });
    const next = await pair.sup.respawn('echo');
    const rec = pair.sup.children.get('echo');
    assert.equal(next.credential.generation, 2);
    assert.equal(rec.credential.version, '1.2.3');
    assert.deepEqual([...rec.credential.grants], ['db']);
    assert.equal(rec.limits.pending, 3);
    assert.equal(rec.limits.total, 80_000);
    assert.notEqual(next.credential.grants, rec.credential.grants);
  } finally {
    await pair.close();
  }
});

test('a stale generation does not settle the respawned waiter', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const first = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const next = await pair.sup.respawn('echo');
    const proc = pair.sup.children.get('echo').child;
    proc.kill('SIGSTOP');
    const pending = pair.stub.call({
      pluginId: 'echo',
      credential: next.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'fresh' },
    }, 2_000);
    await delay(50);
    pair.sup.socket.write(encodeMux({
      kind: 'result',
      for: 'call',
      pluginId: 'echo',
      correlationId: 7,
      generation: first.generation,
      payload: { who: 'stale' },
    }));
    await delay(30);
    assert.equal(pair.stub.calls.size, 1);
    proc.kill('SIGCONT');
    const res = await pending;
    assert.equal(res.payload?.who, 'fresh');
    assert.equal(res.generation, next.credential.generation);
  } finally {
    await pair.close();
  }
});

test('cancel acknowledgements stop at the high-priority cap', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 4, pending: 64, cancels: 64 } });
  try {
    pair.sup.socket.write = () => false;
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, pending: 64 });
    for (let i = 0; i < 20; i++) {
      pair.stub.cancel({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
      }, 1_000).catch(() => {});
    }
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'echo' && fault.code === 'hi-cap'),
      3_000,
    );
    assert.equal(faulted, true, JSON.stringify({ faults: pair.sup.faults, hi: pair.sup.queueDepth('echo').hi }));
    assert.ok(pair.sup.queueDepth('echo').hi <= 4);
  } finally {
    await pair.close();
  }
});

test('ignored cancels obey the pending cap and are reclaimed', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { pending: 2, cancels: 64 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'ig', script: ignorePath, pending: 2 });
    const settled = await Promise.all(Array.from({ length: 4 }, (_, i) => pair.stub.cancel({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: i + 1,
    }, 250).catch((err) => err)));
    assert.ok(settled.some((row) => row.code === 'pending-cap'));
    await delay(50);
    assert.equal(pair.sup.pending.size, 0);
    const call = await pair.stub.call({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: 9,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 500).catch((err) => err);
    assert.equal(call.payload?.ok, true);
  } finally {
    await pair.close();
  }
});

test('a frame past the partial cap faults within one read chunk', { timeout: 10_000 }, async () => {
  const cap = DEFAULT_CAPS.partial;
  const pair = await connectPair({ sweeper: false });
  try {
    // The oversized line is produced by the child. A call body that large
    // cannot be admitted on stdin once K_out keeps room for control frames.
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      env: { ECHO_PAD: '80000' },
    });
    const pending = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 5_000).catch((err) => err);
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'echo' && fault.code === 'partial-cap'),
      5_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'echo');
    const highWater = partialFrameHighWater(fault.pendingBytes, fault.inFlightTailBytes, fault.stdoutUnread);
    assert.equal(highWater, fault.pendingBytes + fault.inFlightTailBytes + fault.stdoutUnread);
    assert.equal(partialCapHolds(highWater, cap), true, JSON.stringify(fault));
    assert.ok(fault.stdoutUnread <= fault.kIn, String(fault.stdoutUnread));
    const rec = pair.sup.children.get('echo');
    assert.equal(rec.dead, true);
    assert.equal(rec.pauseReason, null);
    const settled = await pending;
    assert.equal(settled.code, 'partial-cap');
  } finally {
    await pair.close();
  }
});

test('partial cap exhaustion stays inside the reserved cap', { timeout: 15_000 }, async () => {
  const cap = 32 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: cap, total: 8 * 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'partial', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const rec = pair.sup.children.get('partial');
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'partial' && fault.code === 'partial-cap'),
      10_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'partial');
    const highWater = partialFrameHighWater(fault.pendingBytes, fault.inFlightTailBytes, fault.stdoutUnread);
    assert.equal(partialCapHolds(highWater, cap), true, JSON.stringify(fault));
    assert.ok(fault.stdoutUnread <= fault.kIn, String(fault.stdoutUnread));
    assert.ok(fault.pendingBytes <= cap, String(fault.pendingBytes));
    assert.equal(rec.dead, true);
    assert.equal(rec.pauseReason, null);
  } finally {
    await pair.close();
  }
});

test('total-buffer bound fails when read after fault cleanup', { timeout: 15_000 }, async () => {
  const cap = 48 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, partial: 1024 * 1024, total: cap, totalGlobal: 8 * 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({ pluginId: 'total', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'total' && fault.code === 'total-cap'),
      10_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'total');
    assert.equal(
      fault.accountedBytes,
      fault.pluginBytes + fault.inFlightTailBytes + fault.stdoutUnread + fault.stdinQueued,
    );
    assert.ok(fault.kIn > 0, String(fault.kIn));
    assert.ok(fault.stdoutUnread <= fault.kIn, String(fault.stdoutUnread));
    assert.equal(totalCapHolds(fault.accountedBytes, cap, {
      stdoutUnread: fault.stdoutUnread,
      stdinQueued: fault.stdinQueued,
      kIn: fault.kIn,
      kOut: fault.kOut,
    }), true, JSON.stringify(fault));
    assert.equal(pair.sup.children.get('total').dead, true);
    assert.equal(totalCapHolds(cap + 1, cap), false);
    assert.equal(totalCapHolds(0, cap, { afterCleanup: true }), false);
    assert.equal(totalCapHolds(pair.sup.bufferedBytes(), cap, { afterCleanup: true }), false);
  } finally {
    await pair.close();
  }
});

test('total-cap snapshot counts kernel unread bytes and stays inside the cap', { timeout: 15_000 }, async () => {
  const cap = 48 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, partial: 1024 * 1024, total: cap, totalGlobal: 8 * 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({
      pluginId: 'total',
      script: floodPath,
      env: { FLOOD_MODE: 'partial', FLOOD_CHUNK: '32768' },
    });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'total' && fault.code === 'total-cap'),
      10_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'total');
    assert.equal(
      fault.accountedBytes,
      fault.pluginBytes + fault.inFlightTailBytes + fault.stdoutUnread + fault.stdinQueued,
    );
    assert.equal(totalCapHolds(fault.accountedBytes, cap, {
      stdoutUnread: fault.stdoutUnread,
      stdinQueued: fault.stdinQueued,
      kIn: fault.kIn,
      kOut: fault.kOut,
    }), true, JSON.stringify(fault));
    assert.equal(totalCapHolds(pair.sup.bufferedBytes(), cap, { afterCleanup: true }), false);
  } finally {
    await pair.close();
  }
});

test('a large child write still keeps the partial high-water inside the cap', { timeout: 15_000 }, async () => {
  const cap = 32 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, partial: cap, total: 8 * 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({
      pluginId: 'partial',
      script: floodPath,
      env: { FLOOD_MODE: 'partial', FLOOD_CHUNK: '32768' },
    });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'partial' && fault.code === 'partial-cap'),
      10_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'partial');
    const highWater = partialFrameHighWater(fault.pendingBytes, fault.inFlightTailBytes, fault.stdoutUnread);
    assert.equal(highWater, fault.pendingBytes + fault.inFlightTailBytes + fault.stdoutUnread);
    assert.equal(partialCapHolds(highWater, cap), true, JSON.stringify(fault));
    assert.equal(partialCapHolds(36864 + 32768, cap), false);
  } finally {
    await pair.close();
  }
});

test('partial cap bound fails when enforcement is removed', { timeout: 15_000 }, async () => {
  const cap = 32 * 1024;
  const pair = await connectPair({
    sweeper: false,
    enforcePartial: false,
    caps: { partial: cap, total: 8 * 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'partial', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'partial' && fault.code === 'NdjsonOversizeError'),
      10_000,
    );
    assert.equal(faulted, true);
    const fault = pair.sup.faults.find((row) => row.pluginId === 'partial');
    assert.equal(fault.code, 'NdjsonOversizeError');
    assert.equal(partialCapHolds(fault.pendingBytes, cap), false, String(fault.pendingBytes));
    assert.ok(fault.pendingBytes > cap + PARTIAL_READ_CHUNK, String(fault.pendingBytes));
  } finally {
    await pair.close();
  }
});

test('sibling survival is false when the process dies by signal', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const proc = pair.sup.children.get('echo').child;
    proc.kill('SIGKILL');
    await waitUntil(() => proc.signalCode != null, 2_000);
    assert.equal(proc.exitCode, null);
    assert.equal(childAlive(proc), false);
    assert.equal(kid.pid, proc.pid);
  } finally {
    await pair.close();
  }
});

test('a cpuset smaller than the host is not a valid measurement', () => {
  const pinned = assessEnvironment({
    cpu: { unlimited: true },
    cpus: 1,
    hostCpus: 4,
    load: 0,
    rssOk: true,
  });
  assert.equal(pinned.cpus, 1);
  assert.equal(pinned.cpuUnlimited, true);
  assert.equal(pinned.throttled, true);
  assert.equal(pinned.valid, false);
  const open = preflight();
  assert.equal(open.cpus, os.availableParallelism());
});

test('a one-core quota on a multi-cpu host is not a valid measurement', () => {
  const capped = assessEnvironment({
    cpu: { unlimited: false, quota: 100_000, period: 100_000 },
    cpus: 4,
    load: 0,
    rssOk: true,
  });
  assert.equal(capped.throttled, true);
  assert.equal(capped.valid, false);
  const missing = assessEnvironment({
    cpu: { unreadable: true },
    cpus: 4,
    load: 0,
    rssOk: false,
  });
  assert.equal(missing.valid, false);
  const open = assessEnvironment({
    cpu: { unlimited: true },
    cpus: 4,
    load: 0,
    rssOk: true,
  });
  assert.equal(open.throttled, false);
  assert.equal(open.valid, true);
});

test('B3 does not pass when RSS cannot be read', async () => {
  const result = await b3({ readRss: () => null });
  assert.equal(result.pass, null);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.detail.reason, 'rss-unreadable');
});

test('B1 achieved rate ignores completions that land after the window', { timeout: 10_000 }, async () => {
  const result = await b1({
    warmupMs: 0,
    windowMs: 40,
    reps: 1,
    script: ignorePath,
    callTimeout: 500,
    preflight: validEnv,
  });
  const rep = result.detail.reps[0];
  assert.ok(rep.issued > 0);
  assert.equal(rep.achieved, 0);
  assert.ok(rep.p99 != null && rep.p99 >= 40, String(rep.p99));
});

test('spawn rejects a duplicate live plugin id', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const first = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'echo', script: echoPath }),
      (err) => err.code === 'duplicate-plugin',
    );
    const live = pair.sup.children.get('echo');
    assert.equal(live.child.pid, first.pid);
    assert.equal(live.child.exitCode, null);
    const res = await pair.stub.call({
      pluginId: 'echo',
      credential: first.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000);
    assert.equal(res.payload?.ok, true);
  } finally {
    await pair.close();
  }
});

test('a second in-flight correlation id does not replace the first waiter', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const first = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'first' },
    }, 1_000);
    const second = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'second' },
    }, 300).catch((err) => err);
    assert.equal(second.code, 'duplicate-correlation');
    const res = await first;
    assert.equal(res.payload?.who, 'first');
    await delay(20);
    assert.equal(pair.sup.pending.size, 0);
    assert.equal(pair.stub.calls.size, 0);
  } finally {
    await pair.close();
  }
});

test('calls count cancellation slots against the pending cap', async () => {
  const pair = await connectPair({ sweeper: false, caps: { pending: 2, cancels: 8 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'ig', script: ignorePath, pending: 2 });
    const cancels = [1, 2].map((id) => pair.stub.cancel({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: id,
    }, 800).catch((err) => err));
    await delay(40);
    const calls = await Promise.all([3, 4].map((id) => pair.stub.call({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: id,
      port: 'db',
      method: 'get',
      payload: { id },
    }, 300).catch((err) => err)));
    assert.ok(calls.every((row) => row.code === 'pending-cap'));
    assert.ok(pair.sup.pending.size <= 2);
    await Promise.all(cancels);
  } finally {
    await pair.close();
  }
});

test('cancellation writes count against the byte caps', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const userspace = 4_096;
  const globalUserspace = 8_192;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      total: userspace + reserved.perChild,
      totalGlobal: globalUserspace + reserved.perChild + reserved.muxReserve,
      pending: 8,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      total: userspace + reserved.perChild,
    });
    const big = 'y'.repeat(3_000);
    const settled = await Promise.all([0, 1, 2, 3].map((n) => pair.stub.cancel({
      pluginId: 'silent',
      credential: kid.credential,
      correlationId: `${big}-${n}`,
    }, 400).catch((err) => err)));
    assert.ok(settled.some((row) => row.code === 'total-cap'));
    assert.ok(pair.sup.bufferedBytes() <= globalUserspace);
  } finally {
    await pair.close();
  }
});

test('a cancelled frame with for call retires the call waiter', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const proc = pair.sup.children.get('echo').child;
    proc.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 5,
      port: 'db',
      method: 'get',
      payload: { who: 'call' },
    }, 1_000);
    const cancelP = pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 5,
    }, 1_000);
    await delay(40);
    const generation = kid.credential.generation;
    pair.sup.socket.write(encodeMux({
      kind: 'cancelled', for: 'cancel', pluginId: 'echo', correlationId: 5, generation,
    }));
    pair.sup.socket.write(encodeMux({
      kind: 'cancelled', for: 'call', pluginId: 'echo', correlationId: 5, generation,
    }));
    const [callRes, cancelRes] = await Promise.all([callP, cancelP]);
    assert.equal(cancelRes.kind, 'cancelled');
    assert.equal(callRes.for, 'call');
    assert.equal(callRes.kind, 'cancelled');
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('the global byte ceiling pauses every contributing child', { timeout: 10_000 }, async () => {
  const cap = 64 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { total: 1024 * 1024, totalGlobal: cap, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({ pluginId: 'a', script: floodPath, env: { FLOOD_MODE: 'partial' }, total: 1024 * 1024 });
    pair.sup.spawn({ pluginId: 'b', script: floodPath, env: { FLOOD_MODE: 'partial' }, total: 1024 * 1024 });
    const paused = await waitUntil(() => {
      const a = pair.sup.children.get('a');
      const b = pair.sup.children.get('b');
      return a.paused && b.paused && a.pauseReason === 'global' && b.pauseReason === 'global';
    }, 3_000);
    assert.equal(paused, true);
    const buffered = pair.sup.bufferedBytes();
    await delay(300);
    // Each paused child may already hold a pipe burst in readableLength.
    assert.ok(buffered <= cap + 256 * 1024, String(buffered));
    assert.ok(pair.sup.bufferedBytes() <= buffered + 4_096);
  } finally {
    await pair.close();
  }
});

test('treeRss is invalid when a child sample is missing', () => {
  const missing = 1_000_000_000;
  assert.equal(treeRss([missing]), null);
  const self = treeRss([]);
  if (self != null) assert.ok(self > 0);
});

test('a non-array grant list is rejected', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'echo', script: echoPath, grants: 'db' }),
      (err) => err.code === 'invalid-grants',
    );
    assert.equal(pair.sup.children.has('echo'), false);
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    assert.deepEqual([...pair.sup.children.get('echo').credential.grants], ['*']);
    const res = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000);
    assert.equal(res.payload?.ok, true);
  } finally {
    await pair.close();
  }
});

test('a spawn error retires the fencing token', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.size >= 1, 2_000);
    assert.equal(armed, true);
    rec.child.emit('error', Object.assign(new Error('emfile'), { code: 'EMFILE' }));
    const settled = await callP;
    assert.equal(settled.code, 'EMFILE');
    assert.equal(rec.dead, true);
    assert.equal(pair.sup.retiredTokens.has(kid.token), false);
    await assert.rejects(
      () => pair.sup.commitIfLive('id', kid.token, async () => {}),
      (err) => err instanceof FencedError,
    );
  } finally {
    await pair.close();
  }
});

test('kernel writes stop until drain and stay inside the byte cap', async () => {
  const pair = await connectPair({
    sweeper: false,
    kernel: { pendingCap: 8, byteCap: 64 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const writes = [];
    pair.stub.socket.write = (buf, cb) => {
      writes.push(buf);
      return false;
    };
    const first = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 300).catch((err) => err);
    const second = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 2 },
    }, 300).catch((err) => err);
    assert.equal(writes.length, 1);
    assert.equal(pair.stub.writeBlocked, true);
    assert.ok(pair.stub.bufferedBytes() <= pair.stub.byteCap);
    pair.stub.socket.emit('drain');
    assert.equal(writes.length, 2);
    assert.equal(pair.stub.calls.size, 2);
    await Promise.all([first, second]);
  } finally {
    await pair.close();
  }
});

test('a paused child keeps its unread tail and the buffer stops growing', { timeout: 10_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 8 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { total: 1024 * 1024, totalGlobal: cap + reserved.perChild + reserved.muxReserve, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({
      pluginId: 'partial',
      script: floodPath,
      env: { FLOOD_MODE: 'partial' },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('partial');
    const paused = await waitUntil(() => rec.paused && !rec.dead, 3_000);
    assert.equal(paused, true);
    await delay(200);
    const buffered = pair.sup.bufferedBytes();
    const stashed = rec.stash?.length ?? 0;
    await delay(200);
    assert.equal(rec.dead, false);
    assert.equal(rec.paused, true);
    assert.equal(pair.sup.bufferedBytes(), buffered);
    assert.ok(buffered >= cap, String(buffered));
    if (stashed > 0) assert.ok(buffered >= stashed);
  } finally {
    await pair.close();
  }
});

test('a paused stdout stream does not deliver a truncated result', { timeout: 20_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const control = stdinControlReserve();
  const payloadLen = 1024;
  const line = Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId: 12,
    port: 'db',
    method: 'get',
    payload: 'p'.repeat(payloadLen),
  }));
  assert.ok(line + control.total < reserved.kOut, `${line} + ${control.total} >= ${reserved.kOut}`);
  const pair = await connectPair({ sweeper: false, caps: { lo: 4, hi: 8, partial: 1024 * 1024, total: 8 * 1024 * 1024 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, total: 8 * 1024 * 1024 });
    pair.stub.socket.pause();
    const payload = 'p'.repeat(payloadLen);
    const pending = [];
    for (let i = 0; i < 12; i++) {
      pending.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload,
      }, 8_000).catch((err) => err));
    }
    await waitUntil(() => pair.sup.children.get('echo').paused, 3_000);
    await delay(300);
    pair.stub.socket.resume();
    const settled = await Promise.all(pending);
    const lengths = settled.map((row) => (typeof row.payload === 'string' ? row.payload.length : -1));
    assert.ok(lengths.some((len) => len === payloadLen), JSON.stringify(lengths));
    assert.ok(lengths.every((len) => len === payloadLen || len === -1), JSON.stringify(lengths));
    for (const row of settled) {
      if (typeof row.payload !== 'string') assert.equal(row.code, 'total-cap');
    }
  } finally {
    pair.stub.socket.resume();
    await pair.close();
  }
});

test('faulting a child does not drive the outbound count negative', { timeout: 10_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, total: 8 * 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      pending: 64,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('silent');
    const granted = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(granted, true, String(rec.outbound));
    const queued = fionread(rec.stdinProbe);
    assert.equal(Number.isInteger(queued), true);
    const wrapper = Buffer.byteLength(encodeNdjson({
      kind: 'call',
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { blob: '' },
    }));
    const control = stdinControlReserve();
    // One payload that fills K_out, after the grant already sitting in the
    // kernel queue. It cannot be flushed while the child refuses to read.
    const room = reserved.kOut - control.total - queued - wrapper - 8;
    assert.ok(room > reserved.sndbufOut, `${room} vs ${reserved.sndbufOut}`);
    const writes = [];
    writes.push(pair.stub.call({
      pluginId: 'silent',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { blob: 'x'.repeat(room) },
    }, 2_000).catch((err) => err));
    const held = await waitUntil(() => rec.outbound > 0, 2_000);
    assert.equal(held, true, String(rec.outbound));
    rec.child.stdout.emit('data', Buffer.from('{bad\n'));
    await delay(100);
    assert.equal(rec.dead, true);
    assert.ok(rec.outbound >= 0, String(rec.outbound));
    assert.ok(pair.sup.bufferedBytes() >= 0, String(pair.sup.bufferedBytes()));
    await Promise.all(writes);
    assert.ok(rec.outbound >= 0, String(rec.outbound));
    assert.ok(pair.sup.bufferedBytes() >= 0, String(pair.sup.bufferedBytes()));
  } finally {
    await pair.close();
  }
});

test('kernel-side rejections do not hi-cap fault the target child', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 4, pending: 64 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'q', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    pair.sup.socket.write = () => false;
    const bad = [];
    for (let i = 0; i < 40; i++) {
      bad.push(pair.stub.call({
        pluginId: 'q',
        credential: { ...kid.credential, secret: 'nope' },
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 500).catch((err) => err));
    }
    await delay(100);
    assert.equal(pair.sup.children.get('q').dead, false);
    assert.equal(pair.sup.faults.some((fault) => fault.code === 'hi-cap'), false);
    assert.ok(pair.sup.queueDepth('q').hi < 4);
    pair.sup.socket.write = original;
    pair.sup.socket.emit('drain');
    const settled = await Promise.all(bad);
    assert.ok(settled.some((row) => row.code === 'credential-mismatch'));
    const ok = await pair.stub.call({
      pluginId: 'q',
      credential: kid.credential,
      correlationId: 99,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000);
    assert.equal(ok.payload?.ok, true);
  } finally {
    await pair.close();
  }
});

test('child-exited is delivered while the high-priority queue is full', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 1, pending: 8 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    let block = true;
    pair.sup.socket.write = (buf, cb) => {
      if (block) return false;
      return original(buf, cb);
    };
    for (let i = 0; i < 2; i++) {
      pair.stub.cancel({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
      }, 2_000).catch(() => {});
    }
    const filled = await waitUntil(() => pair.sup.queueDepth('echo').hi >= 1, 2_000);
    assert.equal(filled, true);
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 3_000).catch((err) => err);
    await delay(40);
    rec.child.kill('SIGKILL');
    block = false;
    pair.sup.socket.emit('drain');
    const settled = await callP;
    assert.equal(settled.code, 'child-exited');
  } finally {
    await pair.close();
  }
});

test('timeout is delivered while the high-priority queue is full', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 1, pending: 8 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    const written = [];
    let block = true;
    pair.sup.socket.write = (buf, cb) => {
      if (block) return false;
      written.push(Buffer.from(buf));
      return original(buf, cb);
    };
    for (let i = 0; i < 2; i++) {
      pair.stub.cancel({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
      }, 2_000).catch(() => {});
    }
    const filled = await waitUntil(() => pair.sup.queueDepth('echo').hi >= 1, 2_000);
    assert.equal(filled, true);
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 9,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 80).catch((err) => err);
    const queued = await waitUntil(() => pair.sup.terminal.length >= 1, 2_000);
    assert.equal(queued, true);
    block = false;
    pair.sup.socket.emit('drain');
    const settled = await callP;
    assert.equal(settled.code, 'timeout');
    const framer = new MuxFramer();
    const frames = [];
    for (const buf of written) {
      framer.feed(buf);
      frames.push(...framer.frames());
    }
    assert.ok(
      frames.some((frame) => frame.kind === 'error' && frame.code === 'timeout' && frame.correlationId === 9),
      JSON.stringify(frames.map((frame) => [frame.kind, frame.code, frame.correlationId])),
    );
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('an unsolicited cancelled frame does not retire the call', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'kept' },
    }, 2_000);
    await delay(40);
    rec.credential.generation += 1;
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({ kind: 'cancelled', correlationId: 7 })));
    await delay(30);
    assert.equal(pair.sup.pending.has('echo', 7, 'call'), true);
    assert.equal(pair.stub.calls.size, 1);
    rec.credential.generation -= 1;
    rec.child.kill('SIGCONT');
    const res = await callP;
    assert.equal(res.payload?.who, 'kept');
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('grant lists that contain a separator are not joined', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, grants: ['a\0b'] });
    const mismatched = await pair.stub.call({
      pluginId: 'echo',
      credential: { ...kid.credential, grants: ['a', 'b'] },
      correlationId: 1,
      port: 'a\0b',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    assert.equal(mismatched.code, 'credential-mismatch');
    const matched = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'a\0b',
      method: 'get',
      payload: { ok: true },
    }, 1_000);
    assert.equal(matched.payload?.ok, true);
  } finally {
    await pair.close();
  }
});

test('an unfinished mux frame pauses the shared input at the global ceiling', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    caps: { totalGlobal: 64 + reserved.perChild + reserved.muxReserve },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(200, 0);
    pair.stub.socket.write(Buffer.concat([prefix, Buffer.alloc(80, 0x61)]));
    await delay(30);
    // B_g is below C, so the read never starts. The unfinished frame stays in
    // the kernel reservation and a later write does not enter userspace.
    assert.equal(pair.sup.bufferedBytes(), 0);
    assert.equal(pair.sup.caps.total, true);
    assert.equal(pair.sup.inputPaused, true);
    const queued = fionread(pair.sup.muxFd);
    assert.ok(queued >= 84, String(queued));
    assert.ok(queued <= pair.sup.kMuxIn, String(queued));
    pair.stub.socket.write(Buffer.alloc(1_000, 0x62));
    await delay(40);
    assert.equal(pair.sup.bufferedBytes(), 0);
    const again = fionread(pair.sup.muxFd);
    assert.ok(again >= queued, String(again));
    assert.ok(again <= pair.sup.kMuxIn, String(again));
  } finally {
    await pair.close();
  }
});

test('the shared input resumes below the global low water', { timeout: 10_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 64 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { total: 1024 * 1024, totalGlobal: cap + 2 * reserved.perChild + reserved.muxReserve, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({ pluginId: 'a', script: floodPath, env: { FLOOD_MODE: 'partial' }, total: 1024 * 1024 });
    pair.sup.spawn({ pluginId: 'b', script: floodPath, env: { FLOOD_MODE: 'partial' }, total: 1024 * 1024 });
    const paused = await waitUntil(() => pair.sup.inputPaused && pair.sup.bufferedBytes() > cap, 3_000);
    assert.equal(paused, true);
    for (const id of ['a', 'b']) pair.sup.children.get(id).child.kill('SIGKILL');
    const resumed = await waitUntil(
      () => pair.sup.inputPaused === false && pair.sup.bufferedBytes() <= cap / 2,
      3_000,
    );
    assert.equal(resumed, true, JSON.stringify({
      paused: pair.sup.inputPaused,
      buffered: pair.sup.bufferedBytes(),
      dead: ['a', 'b'].map((id) => pair.sup.children.get(id).dead),
    }));
  } finally {
    for (const rec of pair.sup.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    }
    await pair.close();
  }
});

test('a timed-out unsent call is not written after drain', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { pending: 64, total: 8 * 1024 * 1024 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, pending: 64 });
    const original = pair.stub.socket.write.bind(pair.stub.socket);
    pair.stub.socket.write = () => false;
    pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 2_000).catch(() => {});
    assert.equal(pair.stub.writeBlocked, true);
    const late = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 9_001,
      port: 'db',
      method: 'get',
      payload: { late: true },
    }, 40).catch((err) => err);
    assert.equal(late.code, 'timeout');
    assert.equal(
      pair.stub.writeQueue.some((entry) => entry.sent?.lane === 'call'
        && entry.sent.pluginId === 'echo'
        && entry.sent.correlationId === 9_001),
      false,
    );
    pair.stub.socket.write = original;
    pair.stub.socket.emit('drain');
    await delay(50);
    assert.equal(pair.sup.pending.has('echo', 9_001, 'call'), false);
    const again = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 9_001,
      port: 'db',
      method: 'get',
      payload: { again: true },
    }, 1_000);
    assert.equal(again.payload?.again, true);
  } finally {
    await pair.close();
  }
});

test('unknown plugin rejections share one bounded queue', async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 4, totalGlobal: 64 * 1024 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    pair.sup.socket.write = () => false;
    for (let i = 0; i < 40; i++) {
      const pluginId = `nope-${i}`;
      pair.stub.call({
        pluginId,
        credential: { pluginId, version: '0', grants: ['*'], generation: 1, secret: 'x' },
        correlationId: 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 200).catch(() => {});
    }
    await delay(40);
    assert.equal(pair.sup.children.get('echo').dead, false);
    assert.equal(pair.sup.faults.some((fault) => fault.code === 'hi-cap'), false);
    assert.ok(pair.sup.hi.size <= 1, String(pair.sup.hi.size));
    const queued = [...pair.sup.hi.values()].reduce((sum, queue) => sum + queue.length, 0);
    assert.ok(queued <= 1, String(queued));
    assert.ok(pair.sup.unknownRejectsCoalesced > 0);
    assert.ok(pair.sup.bufferedBytes() <= pair.sup.capsConfig.totalGlobal);
    pair.sup.socket.write = original;
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('respawn still delivers the retired generation child-exited error', { timeout: 15_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 1, pending: 8 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    let block = true;
    pair.sup.socket.write = (buf, cb) => {
      if (block) return false;
      return original(buf, cb);
    };
    for (let i = 0; i < 2; i++) {
      pair.stub.cancel({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
      }, 2_000).catch(() => {});
    }
    const filled = await waitUntil(() => pair.sup.queueDepth('echo').hi >= 1, 2_000);
    assert.equal(filled, true);
    pair.sup.children.get('echo').child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 8_000).catch((err) => err);
    await delay(40);
    const next = await pair.sup.respawn('echo');
    assert.notEqual(next.credential.generation, kid.credential.generation);
    block = false;
    pair.sup.socket.emit('drain');
    const settled = await callP;
    assert.equal(settled.code, 'child-exited');
    assert.equal(pair.sup.children.get('echo').dead, false);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('B3 warm-up finishes before the RSS baseline', { timeout: 40_000 }, async () => {
  const result = await b3({
    warmupMs: 300,
    windowMs: 400,
    reps: 1,
    preflight: validEnv,
  });
  assert.notEqual(result.outcome, 'invalid', JSON.stringify(result.detail));
  const row = result.detail.holds[0];
  assert.equal(row.filled, true);
  assert.ok(row.warmedMs >= 250, String(row.warmedMs));
  assert.equal(row.offered, row.issued + row.skipped);
  assert.ok(row.issued > 0);
});

test('flood rate counts only the scored window', { timeout: 15_000 }, async () => {
  const result = await floodBound({
    warmupMs: 200,
    windowMs: 200,
    reps: 1,
    preflight: validEnv,
  });
  const rep = result.detail.reps[0];
  assert.ok(rep.floodBaseline > 0);
  assert.ok(rep.floodFrames > 0);
  assert.equal(rep.floodRate, rep.floodFrames / 0.2);
  assert.ok(rep.floodFrames < rep.floodBaseline + rep.floodFrames);
  const lifetime = rep.floodBaseline + rep.floodFrames;
  assert.ok(lifetime > rep.floodFrames);
});

test('a mux framing fault closes the kernel and rejects later sends', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.stub.socket.write.bind(pair.stub.socket);
    pair.stub.socket.write = () => false;
    const first = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 1_000).catch((err) => err);
    const queued = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 2 },
    }, 1_000).catch((err) => err);
    assert.equal(pair.stub.writeBlocked, true);
    assert.ok(pair.stub.writeQueue.length >= 1);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1024 * 1024 + 8, 0);
    pair.sup.socket.write(prefix);
    const settled = await Promise.all([first, queued]);
    assert.ok(settled.every((err) => err.code === 'MuxOversizeError'), JSON.stringify(settled.map((err) => err.code)));
    assert.equal(pair.stub.framingFault, 'MuxOversizeError');
    assert.equal(pair.stub.shut, true);
    assert.equal(pair.stub.writeQueue.length, 0);
    assert.equal(pair.stub.socket.destroyed, true);
    pair.stub.socket.write = original;
    pair.stub.socket.emit('drain');
    await delay(30);
    assert.equal(pair.sup.pending.size, 0);
    const again = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { n: 3 },
    }, 500).catch((err) => err);
    assert.equal(again.code, 'MuxOversizeError');
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('pushed-back stdout bytes count against the per-plugin and global caps', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 16, total: 64 * 1024, totalGlobal: cap + reserved.perChild + reserved.muxReserve, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({
      pluginId: 'partial',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      total: 64 * 1024,
    });
    const rec = pair.sup.children.get('partial');
    pair.sup.socket.write = () => false;
    const floods = [];
    for (let i = 0; i < 20; i++) floods.push(encodeNdjson({ kind: 'flood' }));
    rec.child.stdout.emit('data', Buffer.from(floods.join('')));
    assert.equal(rec.pauseReason, 'bulk');
    rec.child.stdout.emit('data', Buffer.alloc(20_000, 0x61));
    const unread = rec.child.stdout.readableLength;
    assert.ok(unread > 1024, String(unread));
    const pluginBytes = pair.sup.queueDepth('partial').pluginBytes;
    assert.ok(pluginBytes >= unread, String(pluginBytes));
    assert.ok(pair.sup.bufferedBytes() >= unread, String(pair.sup.bufferedBytes()));
    assert.equal(rec.dead, false);
    assert.equal(rec.paused, true);
  } finally {
    await pair.close();
  }
});

test('numeric and NUL identities do not retire each other\'s waiters', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const numeric = pair.sup.spawn({ pluginId: 1, script: echoPath });
    const text = pair.sup.spawn({ pluginId: '1', script: echoPath });
    const plain = pair.sup.spawn({ pluginId: 'a', script: echoPath });
    const embedded = pair.sup.spawn({ pluginId: 'a\0b', script: echoPath });
    for (const id of [1, '1', 'a', 'a\0b']) pair.sup.children.get(id).child.kill('SIGSTOP');
    const numericCall = pair.stub.call({
      pluginId: 1,
      credential: numeric.credential,
      correlationId: 4,
      port: 'db',
      method: 'get',
      payload: { who: 'number' },
    }, 1_000).catch((err) => err);
    const textCall = pair.stub.call({
      pluginId: '1',
      credential: text.credential,
      correlationId: 4,
      port: 'db',
      method: 'get',
      payload: { who: 'text' },
    }, 1_000).catch((err) => err);
    const plainCall = pair.stub.call({
      pluginId: 'a',
      credential: plain.credential,
      correlationId: 'b\0c',
      port: 'db',
      method: 'get',
      payload: { who: 'plain' },
    }, 1_000).catch((err) => err);
    const embeddedCall = pair.stub.call({
      pluginId: 'a\0b',
      credential: embedded.credential,
      correlationId: 'c',
      port: 'db',
      method: 'get',
      payload: { who: 'embedded' },
    }, 1_000).catch((err) => err);
    const separated = pair.stub.call({
      pluginId: 'a',
      credential: plain.credential,
      correlationId: 'cancel\u00005',
      port: 'db',
      method: 'get',
      payload: { who: 'lane' },
    }, 1_000).catch((err) => err);
    await delay(40);
    assert.equal(pair.sup.pending.has(1, 4, 'call'), true);
    assert.equal(pair.sup.pending.has('1', 4, 'call'), true);
    assert.equal(pair.stub.calls.has(1, 4), true);
    assert.equal(pair.stub.calls.has('1', 4), true);
    pair.sup.children.get('1').child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result', correlationId: 4, payload: { who: 'text' },
    })));
    pair.sup.children.get('a\0b').child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result', correlationId: 'c', payload: { who: 'embedded' },
    })));
    pair.sup.children.get('a').child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'cancelled', correlationId: '5',
    })));
    await delay(30);
    assert.equal(pair.sup.pending.has(1, 4, 'call'), true);
    assert.equal(pair.sup.pending.has('a', 'b\0c', 'call'), true);
    assert.equal(pair.sup.pending.has('a', 'cancel\u00005', 'call'), true);
    assert.equal(pair.stub.calls.has(1, 4), true);
    const textRes = await textCall;
    const embeddedRes = await embeddedCall;
    assert.equal(textRes.payload?.who, 'text');
    assert.equal(embeddedRes.payload?.who, 'embedded');
    for (const id of [1, 'a']) pair.sup.children.get(id).child.kill('SIGCONT');
    pair.sup.children.get(1).child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result', correlationId: 4, payload: { who: 'number' },
    })));
    pair.sup.children.get('a').child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result', correlationId: 'b\0c', payload: { who: 'plain' },
    })));
    pair.sup.children.get('a').child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result', correlationId: 'cancel\u00005', payload: { who: 'lane' },
    })));
    const [numericRes, plainRes, laneRes] = await Promise.all([numericCall, plainCall, separated]);
    assert.equal(numericRes.payload?.who, 'number');
    assert.equal(plainRes.payload?.who, 'plain');
    assert.equal(laneRes.payload?.who, 'lane');
  } finally {
    for (const rec of pair.sup.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    }
    await pair.close();
  }
});

test('an unfinished frame past the total cap is a typed fault', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { total: 32 * 1024, totalGlobal: 8 * 1024 * 1024, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      total: 32 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const pending = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 2_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.size === 1, 2_000);
    assert.equal(armed, true);
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 1,
      payload: { blob: 'z'.repeat(80_000) },
    })));
    const settled = await pending;
    assert.equal(settled.code, 'total-cap');
    assert.equal(rec.dead, true);
    assert.equal(rec.paused, false);
    assert.ok(pair.sup.faults.some((fault) => fault.pluginId === 'echo' && fault.code === 'total-cap'));
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('socket writes stay in the global byte count until flushed', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 32 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      lo: 1000,
      hi: 64,
      pending: 80,
      pendingGlobal: 80,
      total: 8 * 1024 * 1024,
      totalGlobal: cap + reserved.perChild + reserved.muxReserve,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 80,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const calls = [];
    for (let i = 0; i < 40; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 1_500).catch((err) => err));
    }
    const armed = await waitUntil(() => pair.sup.pending.size >= 40, 2_000);
    assert.equal(armed, true);
    let held = 0;
    pair.sup.socket.write = (buf) => {
      held += buf.length;
      return true;
    };
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(encodeNdjson({ kind: 'result', correlationId: i + 1, payload: { n: 'x'.repeat(2000) } }));
    }
    rec.child.stdout.emit('data', Buffer.from(lines.join('')));
    assert.ok(held > 0, String(held));
    assert.ok(held <= cap, String(held));
    assert.ok(pair.sup.socketOutbound <= cap, String(pair.sup.socketOutbound));
    assert.ok(pair.sup.bufferedBytes() >= held, `${pair.sup.bufferedBytes()} vs ${held}`);
    assert.ok(pair.sup.bufferedBytes() <= cap, String(pair.sup.bufferedBytes()));
    const mux = pair.sup.queuedBytes + pair.sup.socketOutbound;
    assert.ok(mux <= cap, `queued+outbound ${mux}`);
    // A reply that does not fit is rejected. Parking it would keep the ids and the frame.
    assert.equal(rec.deferred.length, 0);
    assert.ok(pair.sup.caps.total === true);
    await Promise.all(calls);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('overlapping respawns do not leave a duplicate generation running', { timeout: 15_000 }, async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const first = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const generation = first.credential.generation;
    const [left, right] = await Promise.all([
      pair.sup.respawn('echo'),
      pair.sup.respawn('echo'),
    ]);
    assert.equal(left.credential.generation, generation + 1);
    assert.equal(right.credential.generation, generation + 2);
    const live = pair.sup.children.get('echo');
    assert.equal(live.child.pid, right.pid);
    assert.equal(live.credential.generation, generation + 2);
    assert.notEqual(left.pid, right.pid);
    const gone = await waitUntil(() => {
      try {
        process.kill(left.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3_000);
    assert.equal(gone, true);
    const res = await pair.stub.call({
      pluginId: 'echo',
      credential: right.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { who: 'live' },
    }, 2_000);
    assert.equal(res.payload?.who, 'live');
    assert.equal(res.generation, generation + 2);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('one stdout chunk cannot enqueue results past the low-priority cap', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: {
      lo: 4,
      hi: 64,
      pending: 80,
      pendingGlobal: 80,
      total: 8 * 1024 * 1024,
      totalGlobal: 8 * 1024 * 1024,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 80,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const calls = [];
    for (let i = 0; i < 40; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 3_000).catch((err) => err));
    }
    const armed = await waitUntil(() => pair.sup.pending.size >= 40, 2_000);
    assert.equal(armed, true);
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    const held = [];
    pair.sup.socket.write = (buf, cb) => {
      held.push(Buffer.from(buf));
      if (cb) cb();
      return false;
    };
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(encodeNdjson({ kind: 'result', correlationId: i + 1, payload: { i } }));
    }
    rec.child.stdout.emit('data', Buffer.from(lines.join('')));
    assert.ok(pair.sup.queueDepth('echo').lo <= 4, String(pair.sup.queueDepth('echo').lo));
    assert.equal(pair.sup.caps.lo, true);
    assert.ok(pair.sup.pending.size > 0);
    pair.sup.socket.write = original;
    for (const buf of held) original(buf);
    pair.sup.socket.emit('drain');
    const settled = await Promise.all(calls);
    const byId = new Map(settled.map((row) => [row.correlationId, row]));
    for (let i = 0; i < 40; i++) {
      assert.equal(byId.get(i + 1)?.payload?.i, i, JSON.stringify(settled));
    }
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('one plugin cannot fill the kernel ahead of a sibling cancel', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const silent = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
    });
    const sib = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    const burst = [];
    for (let i = 0; i < pair.stub.pendingCap; i++) {
      burst.push(pair.stub.call({
        pluginId: 'silent',
        credential: silent.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 300).catch((err) => err));
    }
    assert.ok(pair.stub.calls.sizeOf('silent') <= pair.stub.pendingPerPlugin);
    assert.ok(pair.stub.calls.size < pair.stub.pendingCap);
    const cancel = await pair.stub.cancel({
      pluginId: 'sib',
      credential: sib.credential,
      correlationId: 1,
    }, 1_000).catch((err) => err);
    assert.notEqual(cancel.code, 'pending-cap');
    await Promise.all(burst);
  } finally {
    await pair.close();
  }
});

test('pending identifiers stay charged after the child reads them', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  // The userspace room stays 20_000 / 40_000. The child and mux reservations
  // are added on top so B_t and B_g are that room.
  const userspace = 20_000;
  const globalUserspace = 40_000;
  const total = userspace + reserved.perChild;
  const totalGlobal = globalUserspace + reserved.perChild + reserved.muxReserve;
  const pair = await connectPair({
    sweeper: false,
    caps: { total, totalGlobal, pending: 8 },
    kernel: { pendingCap: 32, byteCap: 200_000 },
  });
  let first;
  try {
    const kid = pair.sup.spawn({ pluginId: 'ig', script: ignorePath, total });
    const id = 'z'.repeat(6_000);
    const floor = Buffer.byteLength(JSON.stringify(id));
    first = pair.stub.cancel({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: id,
    }, 2_000).catch((err) => err);
    const held = await waitUntil(() => {
      const rec = pair.sup.children.get('ig');
      return Boolean(rec)
        && rec.outbound === 0
        && pair.sup.pending.size === 1
        && pair.stub.outbound === 0
        && pair.sup.bufferedBytes() >= floor
        && pair.stub.bufferedBytes() >= floor;
    }, 2_000);
    assert.equal(held, true);
    assert.ok(pair.sup.bufferedBytes() <= 40_000, String(pair.sup.bufferedBytes()));
    assert.ok(pair.stub.bufferedBytes() <= 40_000, String(pair.stub.bufferedBytes()));
    // The stdin line alone fits the remaining per-plugin room. The retained id does not.
    const again = await pair.stub.cancel({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: 'q'.repeat(8_000),
    }, 1_000).catch((err) => err);
    assert.equal(again.code, 'total-cap');
    assert.equal(pair.sup.pending.size, 1);
    assert.ok(pair.sup.bufferedBytes() >= floor, String(pair.sup.bufferedBytes()));
    assert.ok(pair.stub.bufferedBytes() >= floor, String(pair.stub.bufferedBytes()));
    assert.ok(pair.sup.bufferedBytes() <= 40_000, String(pair.sup.bufferedBytes()));
    assert.ok(pair.stub.bufferedBytes() <= 40_000, String(pair.stub.bufferedBytes()));
  } finally {
    await pair.close();
    if (first) await first;
  }
});

test('an unknown rejection does not hi-cap a plugin id outside the unbound key', async () => {
  const pair = await connectPair({ sweeper: false, caps: { hi: 1, pending: 8 } });
  const id = '\0unbound';
  const pending = [];
  try {
    const kid = pair.sup.spawn({ pluginId: id, script: echoPath });
    pair.sup.socket.write = () => false;
    for (let n = 1; n <= 2; n++) {
      pending.push(pair.stub.cancel({
        pluginId: id,
        credential: kid.credential,
        correlationId: n,
      }, 2_000).catch((err) => err));
    }
    const filled = await waitUntil(() => pair.sup.queueDepth(id).hi >= 1, 2_000);
    assert.equal(filled, true);
    pending.push(pair.stub.call({
      pluginId: 'no-such',
      credential: kid.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err));
    const queued = await waitUntil(() => pair.sup.unknownRejectQueued === true, 2_000);
    assert.equal(queued, true);
    assert.equal(pair.sup.children.get(id).dead, false);
    assert.equal(pair.sup.faults.some((fault) => fault.code === 'hi-cap'), false);
    assert.ok(pair.sup.queueDepth(id).hi >= 1);
  } finally {
    await pair.close();
    await Promise.all(pending);
  }
});

test('a socket write does not start when it would pass the global cap', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 8 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      total: 1024 * 1024,
      totalGlobal: cap + reserved.perChild + reserved.muxReserve,
      partial: 1024 * 1024,
      lo: 8,
      pending: 8,
      pendingGlobal: 8,
    },
    partialHighWater: 1024 * 1024,
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      total: 1024 * 1024,
      pending: 8,
    });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const calls = [];
    for (let i = 0; i < 3; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 1_000).catch((err) => err));
    }
    const armed = await waitUntil(() => pair.sup.pending.size >= 3, 2_000);
    assert.equal(armed, true);
    const writes = [];
    pair.sup.socket.write = (buf) => {
      writes.push(buf.length);
      return true;
    };
    const body = 'z'.repeat(3_000);
    rec.child.stdout.emit('data', Buffer.from([1, 2, 3].map((id) => encodeNdjson({
      kind: 'result',
      correlationId: id,
      payload: { blob: body },
    })).join('')));
    assert.ok(writes.length >= 1, writes.join(','));
    assert.ok(writes.every((n) => n <= cap), writes.join(','));
    assert.ok(writes.reduce((sum, n) => sum + n, 0) <= cap, writes.join(','));
    assert.ok(pair.sup.socketOutbound <= cap, String(pair.sup.socketOutbound));
    const accepted = pair.sup.queuedBytes + pair.sup.socketOutbound;
    assert.ok(accepted <= cap, `queued+outbound ${accepted}`);
    assert.ok(pair.sup.bufferedBytes() <= cap, String(pair.sup.bufferedBytes()));
    assert.equal(rec.deferred.length, 0);
    assert.equal(rec.dead, false);
    assert.ok(pair.sup.caps.total === true);
    await Promise.all(calls);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a completed reply survives respawn', { timeout: 15_000 }, async () => {
  const pair = await connectPair({ sweeper: false, caps: { lo: 8, hi: 8, pending: 8 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    const held = [];
    let block = true;
    pair.sup.socket.write = (buf, cb) => {
      if (block) {
        held.push(Buffer.from(buf));
        if (cb) cb();
        return false;
      }
      return original(buf, cb);
    };
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const calls = [1, 2].map((id) => pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: id,
      port: 'db',
      method: 'get',
      payload: { who: id },
    }, 8_000).catch((err) => err));
    const armed = await waitUntil(() => pair.sup.pending.size >= 2, 2_000);
    assert.equal(armed, true);
    rec.child.stdout.emit('data', Buffer.from([1, 2].map((id) => encodeNdjson({
      kind: 'result',
      correlationId: id,
      payload: { who: id },
    })).join('')));
    const queued = await waitUntil(() => pair.sup.queueDepth('echo').lo >= 1, 2_000);
    assert.equal(queued, true);
    assert.equal(pair.sup.pending.size, 0);
    const next = await pair.sup.respawn('echo');
    assert.ok(pair.sup.queueDepth('echo').lo >= 1, String(pair.sup.queueDepth('echo').lo));
    block = false;
    for (const buf of held) original(buf);
    pair.sup.socket.emit('drain');
    const settled = await Promise.all(calls);
    const byId = new Map(settled.map((row) => [row.correlationId, row]));
    assert.equal(byId.get(1)?.payload?.who, 1, JSON.stringify(settled));
    assert.equal(byId.get(2)?.payload?.who, 2, JSON.stringify(settled));
    const fresh = await pair.stub.call({
      pluginId: 'echo',
      credential: next.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { who: 'live' },
    }, 2_000);
    assert.equal(fresh.payload?.who, 'live');
    assert.equal(fresh.generation, next.credential.generation);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('retired tokens do not accumulate across respawns', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const first = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const old = first.token;
    for (let i = 0; i < 12; i++) await pair.sup.respawn('echo');
    assert.equal(pair.sup.retiredTokens.size, 0);
    await assert.rejects(
      () => pair.sup.commitIfLive('id', old, async () => {}),
      (err) => err instanceof FencedError,
    );
  } finally {
    await pair.close();
  }
});

test('a deferred reply stays inside the byte caps', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const cap = 30_000;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      lo: 1,
      hi: 8,
      pending: 8,
      pendingGlobal: 8,
      total: 2 * 1024 * 1024,
      totalGlobal: cap + 2 * reserved.perChild + reserved.muxReserve,
      partial: 2 * 1024 * 1024,
    },
    partialHighWater: 2 * 1024 * 1024,
  });
  try {
    const a = pair.sup.spawn({
      pluginId: 'a',
      script: echoPath,
      pending: 8,
      total: 2 * 1024 * 1024,
    });
    const b = pair.sup.spawn({
      pluginId: 'b',
      script: echoPath,
      pending: 8,
      total: 2 * 1024 * 1024,
    });
    const recA = pair.sup.children.get('a');
    recA.child.kill('SIGSTOP');
    // Longer than the denied call. Expiry flushes the parked reply and would
    // reopen the mux read onto the canary bytes.
    for (const id of [1, 2]) {
      pair.stub.call({
        pluginId: 'a',
        credential: a.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: { id },
      }, 5_000).catch(() => {});
    }
    const armed = await waitUntil(() => pair.sup.pending.size >= 2, 2_000);
    assert.equal(armed, true);
    pair.sup.draining = true;
    recA.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 1,
      payload: { n: 1 },
    })));
    const filled = await waitUntil(() => pair.sup.queueDepth('a').lo >= 1 && recA.paused, 2_000);
    assert.equal(filled, true);
    // The low-priority queue is full. Parse the next result anyway so it is
    // parked, which is the path whose bytes used to leave the framer uncounted.
    recA.paused = false;
    recA.pauseReason = null;
    recA.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 2,
      payload: { blob: 'z'.repeat(20_000) },
    })));
    assert.ok(recA.deferredBytes >= 20_000, String(recA.deferredBytes));
    assert.ok(pair.sup.bufferedBytes() >= recA.deferredBytes, String(pair.sup.bufferedBytes()));
    assert.equal(pair.sup.pending.has('a', 2, 'call'), true);
    const mux = pair.sup.queuedBytes + pair.sup.socketOutbound;
    assert.ok(mux <= cap, `queued+outbound ${mux}`);
    pair.sup.draining = false;
    // The call's mux frame is larger than the room beside the deferred reply.
    // C-byte reads pause the shared input on that partial instead of assembling
    // a frame the cap cannot hold. The call is not admitted.
    const denied = pair.stub.call({
      pluginId: 'b',
      credential: b.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { blob: 'y'.repeat(12_000) },
    }, 1_000).catch((err) => err);
    const paused = await waitUntil(() => pair.sup.inputPaused === true, 1_000);
    assert.equal(paused, true);
    assert.equal(pair.sup.pending.has('b', 1, 'call'), false);
    const held = pair.sup.bufferedBytes();
    assert.ok(held <= cap + recA.deferredBytes, String(held));
    pair.stub.socket.write(Buffer.alloc(4_000, 0x62));
    await delay(40);
    assert.equal(pair.sup.bufferedBytes(), held);
    const settled = await denied;
    assert.equal(settled.code, 'timeout');
  } finally {
    for (const rec of pair.sup.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    }
    await pair.close();
  }
});

test('a timed-out correlation is not reused in the same generation', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const first = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'first' },
    }, 80).catch((err) => err);
    assert.equal(first.code, 'timeout');
    const quarantined = await waitUntil(
      () => pair.sup.stale.has('echo', 7, 'call') && pair.sup.pending.size === 0,
      2_000,
    );
    assert.equal(quarantined, true);
    await delay(30);
    assert.equal(pair.stub.calls.size, 0);
    const reused = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'second' },
    }, 500).catch((err) => err);
    assert.equal(reused.code, 'stale-correlation');
    assert.equal(pair.sup.pending.size, 0);
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 7,
      payload: { who: 'first' },
    })));
    await delay(30);
    assert.equal(pair.sup.pending.size, 0);
    const freshP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 8,
      port: 'db',
      method: 'get',
      payload: { who: 'fresh' },
    }, 1_000);
    const armed = await waitUntil(() => pair.sup.pending.has('echo', 8, 'call'), 2_000);
    assert.equal(armed, true);
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 8,
      payload: { who: 'fresh' },
    })));
    const fresh = await freshP;
    assert.equal(fresh.payload?.who, 'fresh');
    rec.child.kill('SIGCONT');
    const next = await pair.sup.respawn('echo');
    const again = await pair.stub.call({
      pluginId: 'echo',
      credential: next.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { who: 'again' },
    }, 2_000);
    assert.equal(again.payload?.who, 'again');
    assert.equal(again.generation, next.credential.generation);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a forged reply retires the waiter on its lane', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 2, pendingGlobal: 4, hi: 8 },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, pending: 2 });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const callP = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 4,
      port: 'db',
      method: 'get',
      payload: { who: 'call' },
    }, 1_000).catch((err) => err);
    const cancelP = pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 5,
    }, 1_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.size >= 2, 2_000);
    assert.equal(armed, true);
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 4,
      pluginId: 'sib',
      payload: { who: 'forged' },
    })));
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'cancelled',
      correlationId: 5,
      pluginId: 'sib',
    })));
    const [callR, cancelR] = await Promise.all([callP, cancelP]);
    assert.equal(callR.code, 'forged-plugin-id');
    assert.equal(cancelR.code, 'forged-plugin-id');
    assert.equal(pair.sup.pending.size, 0);
    rec.child.kill('SIGCONT');
    const next = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 6,
      port: 'db',
      method: 'get',
      payload: { who: 'admitted' },
    }, 2_000);
    assert.equal(next.payload?.who, 'admitted');
    assert.notEqual(next.code, 'pending-cap');
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a completed reply survives a later child fault', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.kill('SIGSTOP');
    const calls = [1, 2].map((id) => pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: id,
      port: 'db',
      method: 'get',
      payload: { who: id },
    }, 2_000).catch((err) => err));
    const armed = await waitUntil(() => pair.sup.pending.size === 2, 2_000);
    assert.equal(armed, true);
    const original = pair.sup.socket.write.bind(pair.sup.socket);
    const held = [];
    let block = true;
    pair.sup.socket.write = (buf, cb) => {
      if (block) {
        held.push(Buffer.from(buf));
        if (cb) cb();
        return false;
      }
      return original(buf, cb);
    };
    rec.child.stdout.emit('data', Buffer.concat([
      Buffer.from(encodeNdjson({ kind: 'result', correlationId: 1, payload: { who: 1 } })),
      Buffer.from(encodeNdjson({ kind: 'result', correlationId: 2, payload: { who: 2 } })),
      Buffer.from('{bad\n'),
    ]));
    const faulted = await waitUntil(() => rec.dead === true, 2_000);
    assert.equal(faulted, true);
    assert.ok(pair.sup.queueDepth('echo').lo >= 1, String(pair.sup.queueDepth('echo').lo));
    block = false;
    for (const buf of held) original(buf);
    pair.sup.socket.emit('drain');
    const settled = await Promise.all(calls);
    const byId = new Map(settled.map((row) => [row.correlationId, row]));
    assert.equal(byId.get(1)?.payload?.who, 1, JSON.stringify(settled));
    assert.equal(byId.get(2)?.payload?.who, 2, JSON.stringify(settled));
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('an inbound mux partial counts against the kernel byte cap', async () => {
  const cap = 600;
  const pair = await connectPair({
    sweeper: false,
    kernel: { byteCap: cap, pendingCap: 8 },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(2_000, 0);
    pair.sup.socket.write(Buffer.concat([prefix, Buffer.alloc(500, 0x61)]));
    const counted = await waitUntil(
      () => pair.stub.framer.pendingBytes() >= 504 && pair.stub.bufferedBytes() >= 504,
      2_000,
    );
    assert.equal(counted, true, String(pair.stub.bufferedBytes()));
    assert.equal(pair.stub.framingFault, null);
    const denied = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 500).catch((err) => err);
    assert.equal(denied.code, 'total-cap');
    assert.equal(pair.stub.calls.size, 0);
  } finally {
    await pair.close();
  }
});

test('an inbound mux partial past the kernel byte cap is a typed fault', async () => {
  const cap = 1024;
  const pair = await connectPair({
    sweeper: false,
    kernel: { byteCap: cap, pendingCap: 4 },
  });
  try {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(8_000, 0);
    pair.sup.socket.write(Buffer.concat([prefix, Buffer.alloc(8_000, 0x62)]));
    const faulted = await waitUntil(() => pair.stub.framingFault === 'total-cap', 2_000);
    assert.equal(faulted, true, String(pair.stub.framingFault));
    assert.ok(pair.stub.framer.pendingBytes() <= cap, String(pair.stub.framer.pendingBytes()));
    assert.equal(pair.stub.calls.size, 0);
  } finally {
    await pair.close();
  }
});

test('B6 counts skipped scored cancellations as failures', () => {
  const clean = {
    p99: 40,
    samples: 2,
    timeouts: 0,
    offered: 2,
    issued: 2,
    skipped: 0,
    bulkRate: 20_000,
    floodRate: 20_000,
  };
  assert.equal(floodScore(clean), true);
  const tally = { samples: [], timeouts: 0, offered: 2, issued: 2, skipped: 0 };
  applyScoredSkip(tally, 1);
  assert.equal(tally.timeouts, 1);
  assert.equal(tally.skipped, 1);
  assert.equal(tally.offered, tally.issued + tally.skipped);
  assert.equal(floodScore({ ...clean, ...tally, p99: 40, samples: 3 }), false);
});

test('respawn keeps the old reservation until the stdout drain finishes', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: reserved.perChild + reserved.muxReserve,
    },
  });
  let held = null;
  try {
    const first = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    held = dupFd(rec.stdoutWriter);
    assert.equal(typeof held, 'number');
    const respawning = pair.sup.respawn('echo');
    const draining = await waitUntil(() => rec.exited === true && rec.exitFinished === false, 2_000);
    assert.equal(draining, true);
    assert.equal(pair.sup.children.get('echo')?.child.pid, first.pid);
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'other', script: echoPath }),
      (err) => err?.code === 'unsatisfiable' || err?.code === 'spawn-rejected',
    );
    closeFd(held);
    held = null;
    const next = await respawning;
    assert.notEqual(next.pid, first.pid);
    assert.equal(pair.sup.children.get('echo')?.child.pid, next.pid);
    assert.equal(pair.sup.children.has('other'), false);
  } finally {
    closeFd(held);
    await pair.close();
  }
});

test('a call during the stdout drain is rejected', async () => {
  const pair = await connectPair({ sweeper: false });
  let held = null;
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    held = dupFd(rec.stdoutWriter);
    process.kill(kid.pid, 'SIGKILL');
    const draining = await waitUntil(() => rec.exited === true && rec.dead === false, 2_000);
    assert.equal(draining, true);
    const rejected = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: {},
    }, 1_000).catch((err) => err);
    assert.equal(rejected.code, 'unknown-plugin');
    closeFd(held);
    held = null;
  } finally {
    closeFd(held);
    await pair.close();
  }
});

test('spawn admission counts userspace bytes and every live reservation', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const slack = 500;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: reserved.muxReserve + 2 * reserved.perChild + slack,
    },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.stash = Buffer.alloc(slack + 1);
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'other', script: echoPath }),
      (err) => err?.code === 'spawn-rejected',
    );
    assert.equal(pair.sup.children.has('other'), false);
  } finally {
    await pair.close();
  }
});

test('a parked reply releases its identifiers and stays inside the caps', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const userspace = 20_000;
  const correlation = 'c'.repeat(32);
  const pair = await connectPair({
    sweeper: false,
    caps: {
      lo: 1,
      pending: 8,
      partial: 1024 * 1024,
      total: reserved.perChild + userspace,
      totalGlobal: reserved.muxReserve + reserved.perChild + userspace,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 8,
      total: reserved.perChild + userspace,
    });
    const rec = pair.sup.children.get('echo');
    assert.equal(rec.bT, userspace);
    rec.child.kill('SIGSTOP');
    const firstId = `${correlation}a`;
    const secondId = `${correlation}b`;
    for (const id of [firstId, secondId]) {
      pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: { n: 1 },
      }, 5_000).catch(() => {});
    }
    const armed = await waitUntil(() => pair.sup.pending.size === 2, 2_000);
    assert.equal(armed, true);
    pair.sup.draining = true;
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: firstId,
      payload: { n: 1 },
    })));
    const filled = await waitUntil(() => pair.sup.queueDepth('echo').lo >= 1 && rec.paused, 2_000);
    assert.equal(filled, true);
    const measured = pair.sup.lo.get('echo')[0].length;
    const idBytes = rec.idBytes;
    assert.ok(idBytes >= 16, String(idBytes));
    const slack = Math.floor(idBytes / 2);
    // A send-credit refill may already be queued. Those bytes are charged
    // beside the low-priority frame, so the synthetic load has to leave room
    // for them. The slack is still only half the identifiers: the reply fits
    // once parking releases them, and it would not fit if they stayed.
    const charged = pair.sup.queueDepth('echo').pluginBytes;
    const other = charged - rec.loBytes - idBytes;
    assert.ok(other >= 0, String(other));
    rec.loBytes = rec.bT - measured + slack - idBytes - other;
    assert.ok(rec.loBytes >= 0, String(rec.loBytes));
    rec.paused = false;
    rec.pauseReason = null;
    rec.child.stdout.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: secondId,
      payload: { n: 1 },
    })));
    assert.equal(rec.deferred.length, 1, JSON.stringify({
      deferred: rec.deferred.length,
      pluginBytes: pair.sup.queueDepth('echo').pluginBytes,
      bT: rec.bT,
      idBytes: rec.idBytes,
      measured,
    }));
    assert.equal(rec.idBytes, 0, String(rec.idBytes));
    assert.equal(pair.sup.pending.has('echo', secondId, 'call'), true);
    assert.ok(pair.sup.queueDepth('echo').pluginBytes <= rec.bT, String(pair.sup.queueDepth('echo').pluginBytes));
    assert.ok(pair.sup.bufferedBytes() <= userspace, String(pair.sup.bufferedBytes()));
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

async function stopChild(pid) {
  return waitUntil(() => {
    try {
      process.kill(pid, 'SIGSTOP');
      return readFileSync(`/proc/${pid}/status`, 'utf8').includes('\tT');
    } catch {
      return false;
    }
  }, 2_000);
}

test('exit keeps one terminal error inside the full byte cap', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const frameLen = encodeMux({
    kind: 'error',
    code: 'child-exited',
    for: 'call',
    pluginId: 'echo',
    correlationId: 1,
    generation: 1,
  }).length;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending: 16,
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: 8 * 1024 * 1024,
    },
  });
  const calls = [];
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, pending: 16 });
    pair.sup.spawn({ pluginId: 'other', script: echoPath });
    const echo = pair.sup.children.get('echo');
    const sibling = pair.sup.children.get('other');
    // Stop and admit in this turn, before the send window is promised.
    // A later call would have to fit beside that credit.
    process.kill(sibling.child.pid, 'SIGSTOP');
    process.kill(kid.pid, 'SIGSTOP');
    for (let i = 0; i < 6; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 800).catch((err) => err));
    }
    assert.equal(await stopChild(sibling.child.pid), true);
    assert.equal(await stopChild(kid.pid), true);
    const armed = await waitUntil(() => pair.sup.pending.size === 6, 2_000);
    assert.equal(armed, true);
    sibling.stash = Buffer.alloc(reserved.perChild);
    pair.sup.capsConfig.totalGlobal = reserved.muxReserve + 2 * reserved.perChild + frameLen;
    process.kill(kid.pid, 'SIGKILL');
    const finished = await waitUntil(() => echo.exitFinished === true, 3_000);
    assert.equal(finished, true);
    const settled = await Promise.all(calls);
    const delivered = settled.filter((row) => row?.code === 'child-exited');
    assert.equal(delivered.length, 1, JSON.stringify(settled.map((row) => row?.code)));
    assert.ok(pair.sup.terminalCoalesced >= 5, String(pair.sup.terminalCoalesced));
    assert.ok(
      pair.sup.bufferedBytes() <= reserved.perChild + frameLen,
      String(pair.sup.bufferedBytes()),
    );
  } finally {
    await Promise.allSettled(calls);
    await pair.close();
  }
});

test('a terminal error is not queued when the sibling stash already fills the cap', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending: 16,
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: 8 * 1024 * 1024,
    },
  });
  const calls = [];
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, pending: 16 });
    pair.sup.spawn({ pluginId: 'other', script: echoPath });
    const echo = pair.sup.children.get('echo');
    const sibling = pair.sup.children.get('other');
    // Stop and admit in this turn, before the send window is promised.
    // A later call would have to fit beside that credit.
    process.kill(sibling.child.pid, 'SIGSTOP');
    process.kill(kid.pid, 'SIGSTOP');
    for (let i = 0; i < 6; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 500).catch((err) => err));
    }
    assert.equal(await stopChild(sibling.child.pid), true);
    assert.equal(await stopChild(kid.pid), true);
    const armed = await waitUntil(() => pair.sup.pending.size === 6, 2_000);
    assert.equal(armed, true);
    sibling.stash = Buffer.alloc(reserved.perChild);
    pair.sup.capsConfig.totalGlobal = reserved.muxReserve + 2 * reserved.perChild;
    process.kill(kid.pid, 'SIGKILL');
    const finished = await waitUntil(() => echo.exitFinished === true, 3_000);
    assert.equal(finished, true);
    const settled = await Promise.all(calls);
    assert.ok(settled.every((row) => row?.code === 'timeout'), JSON.stringify(settled.map((row) => row?.code)));
    assert.ok(pair.sup.terminalCoalesced >= 6, String(pair.sup.terminalCoalesced));
    assert.equal(pair.sup.terminal.length, 0);
    assert.ok(pair.sup.bufferedBytes() <= reserved.perChild, String(pair.sup.bufferedBytes()));
  } finally {
    await Promise.allSettled(calls);
    await pair.close();
  }
});

test('a spawn error with no exit lets respawn finish', { timeout: 10_000 }, async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    rec.child.removeAllListeners('exit');
    rec.child.emit('error', Object.assign(new Error('emfile'), { code: 'EMFILE' }));
    assert.equal(rec.exitFinished, true);
    const next = await Promise.race([
      pair.sup.respawn('echo'),
      delay(3_000).then(() => null),
    ]);
    assert.ok(next?.pid, 'respawn hung after a spawn error with no exit');
    assert.notEqual(next.pid, kid.pid);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a live rejection is not queued once the child holds B_t', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
    });
    const rec = pair.sup.children.get('echo');
    const flushed = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(flushed, true);
    const frame = encodeMux({
      kind: 'rejected',
      code: 'total-cap',
      for: 'call',
      pluginId: 'echo',
      correlationId: 1,
      generation: kid.credential.generation,
    });
    rec.idBytes = rec.bT - frame.length;
    const admitted = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    assert.equal(admitted.code, 'total-cap');
    assert.ok(rec.idBytes + rec.hiBytes <= rec.bT, `${rec.idBytes}+${rec.hiBytes} > ${rec.bT}`);
    rec.idBytes = rec.bT;
    const dropped = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 400).catch((err) => err);
    assert.equal(dropped.code, 'timeout');
    assert.equal(rec.hiBytes, 0);
    assert.ok(rec.idBytes <= rec.bT);
    assert.ok(pair.sup.bufferedBytes() <= pair.sup.capsConfig.totalGlobal);
  } finally {
    await pair.close();
  }
});

test('control frames are written ahead of payload when stdin is blocked', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'credit', script: creditPath });
    const rec = pair.sup.children.get('credit');
    const seen = [];
    let held = null;
    rec.child.stdin.write = (chunk, cb) => {
      seen.push(String(chunk));
      if (held == null) {
        held = cb;
        return false;
      }
      if (typeof cb === 'function') cb();
      return true;
    };
    // Admit both calls before the window is promised. The grant is control,
    // so it is written before the call that is still queued.
    const calls = [1, 2].map((id) => pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: id,
      port: 'db',
      method: 'get',
      payload: { id },
    }, 2_000).catch((err) => err));
    const armed = await waitUntil(
      () => seen.length === 1
        && JSON.parse(seen[0]).kind === 'call'
        && pair.sup.pending.size === 2
        && rec.creditSent > 0
        && rec.stdinPayload.length === 1,
      2_000,
    );
    assert.equal(armed, true, JSON.stringify({
      seen: seen.map((line) => JSON.parse(line).kind),
      pending: pair.sup.pending.size,
      credit: rec.creditSent,
      payload: rec.stdinPayload.length,
      control: rec.stdinControl.map((entry) => entry.lane),
    }));
    const cancel = pair.stub.cancel({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 9,
    }, 2_000).catch((err) => err);
    const queued = await waitUntil(() => rec.stdinControl.length === 2, 2_000);
    assert.equal(queued, true, rec.stdinControl.map((entry) => entry.lane).join(','));
    assert.equal(seen.length, 1);
    const release = held;
    held = () => {};
    release();
    const ordered = await waitUntil(() => seen.length === 4, 2_000);
    assert.equal(ordered, true, seen.map((line) => JSON.parse(line).kind).join(','));
    assert.deepEqual(seen.map((line) => JSON.parse(line).kind), ['call', 'grant', 'cancel', 'call']);
    await Promise.allSettled([...calls, cancel]);
  } finally {
    await pair.close();
  }
});

test('payload stops before the stdin reserve for a cancel and a grant', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const reserve = stdinControlReserve();
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const flushed = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(flushed, true);
    const real = pair.sup.flowPending;
    pair.sup.flowPending = (fd) => (fd === rec.stdinProbe ? rec.kOut - reserve.total : real(fd));
    const payload = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    assert.equal(payload.code, 'total-cap');
    assert.equal(pair.sup.pending.size, 0);
    const cancel = await pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 4,
    }, 2_000);
    assert.equal(cancel.kind, 'cancelled');
  } finally {
    await pair.close();
  }
});

test('a timed-out call or cancel is dropped before the blocked stdin write resumes', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'credit', script: creditPath });
    const rec = pair.sup.children.get('credit');
    const seen = [];
    let held = null;
    rec.child.stdin.write = (chunk, cb) => {
      seen.push(String(chunk));
      if (held == null) {
        held = cb;
        return false;
      }
      if (typeof cb === 'function') cb();
      return true;
    };
    // The live call is handed to the blocked write. The expired call and
    // cancel stay queued, so the timeout can drop them before the write resumes.
    const live = pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { id: 2 },
    }, 2_000).catch((err) => err);
    const expiredCall = pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { id: 1 },
    }, 150).catch((err) => err);
    const expiredCancel = pair.stub.cancel({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 1,
    }, 150).catch((err) => err);
    const queued = await waitUntil(
      () => seen.length === 1
        && JSON.parse(seen[0]).correlationId === 2
        && rec.stdinPayload.length === 1
        && rec.stdinControl.some((entry) => entry.lane === 'cancel'),
      1_000,
    );
    assert.equal(queued, true, `seen ${seen.length} payload ${rec.stdinPayload.length} control ${rec.stdinControl.map((entry) => entry.lane).join(',')}`);
    const dropped = await waitUntil(
      () => rec.stdinPayload.length === 0
        && rec.stdinControl.every((entry) => entry.lane !== 'cancel')
        && rec.creditSent > 0,
      1_000,
    );
    assert.equal(dropped, true, `payload ${rec.stdinPayload.map((entry) => entry.correlationId)} control ${rec.stdinControl.map((entry) => entry.lane).join(',')}`);
    assert.equal(seen.length, 1);
    const release = held;
    held = () => {};
    release();
    const written = await waitUntil(
      () => seen.length >= 2 && rec.stdinPayload.length === 0 && rec.stdinControl.length === 0,
      1_000,
    );
    assert.equal(written, true, `seen ${seen.length} payload ${rec.stdinPayload.length} control ${rec.stdinControl.length}`);
    const kinds = seen.map((line) => JSON.parse(line));
    // Dropping the expired call frees room, so a second grant can follow the first.
    assert.equal(kinds[0].kind, 'call');
    assert.equal(kinds[0].correlationId, 2);
    assert.ok(kinds.slice(1).every((msg) => msg.kind === 'grant'), kinds.map((msg) => msg.kind).join(','));
    assert.ok(!kinds.some((msg) => msg.kind === 'cancel' || msg.correlationId === 1));
    await Promise.allSettled([expiredCall, expiredCancel, live]);
  } finally {
    await pair.close();
  }
});

test('a global hold probes a child that has no plugin bytes', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const userspace = 64;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: reserved.perChild + reserved.muxReserve + userspace,
    },
  });
  try {
    pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('silent');
    const held = await waitUntil(
      () => rec.readHeld === true && rec.paused === false && rec.outbound === 0,
      2_000,
    );
    assert.equal(held, true, JSON.stringify({
      readHeld: rec.readHeld,
      paused: rec.paused,
      outbound: rec.outbound,
    }));
    const real = pair.sup.flowPending;
    const marked = Date.now();
    pair.sup.flowPending = (fd) => (fd === rec.stdoutFd ? rec.kIn + 1 : real(fd));
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'silent' && fault.stdoutUnread > fault.kIn),
      500,
    );
    const elapsed = Date.now() - marked;
    assert.equal(faulted, true, JSON.stringify(pair.sup.faults));
    assert.ok(elapsed < 100, String(elapsed));
    const fault = pair.sup.faults.find((row) => row.pluginId === 'silent');
    assert.equal(fault.code, 'thread-writer');
    assert.equal(rec.dead, true);
  } finally {
    await pair.close();
  }
});

test('a call leaves room for a cancel of its own correlation id', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const minimum = stdinControlReserve();
  const correlationId = 'c'.repeat(180);
  const longCancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId }));
  const numericCancel = minimum.cancel;
  assert.ok(longCancel > numericCancel);
  const smallCall = Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId: 1,
    port: 'db',
    method: 'get',
    payload: { ok: true },
  }));
  const longCall = Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId,
    port: 'db',
    method: 'get',
    payload: { ok: true },
  }));
  const numericLimit = reserved.kOut - smallCall - minimum.total;
  const longLimit = reserved.kOut - longCall - minimum.grant - longCancel;
  assert.ok(numericLimit > longLimit, `${numericLimit} vs ${longLimit}`);
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('silent');
    const flushed = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(flushed, true);
    const real = pair.sup.flowPending;
    // Room for a numeric-id call plus the numeric cancel and a grant.
    // The longer correlation id's cancel does not fit in that hole.
    pair.sup.flowPending = (fd) => (fd === rec.stdinProbe ? numericLimit : real(fd));
    const rejected = await pair.stub.call({
      pluginId: 'silent',
      credential: kid.credential,
      correlationId,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    assert.equal(rejected.code, 'total-cap');
    assert.equal(pair.sup.pending.has('silent', correlationId, 'call'), false);
    const admitted = pair.stub.call({
      pluginId: 'silent',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.has('silent', 1, 'call'), 1_000);
    assert.equal(armed, true);
    admitted.catch(() => {});
  } finally {
    await pair.close();
  }
});

test('send credit refills after a large response is consumed', { timeout: 10_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pad = 3000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const bT = lineBytes + 2048;
  assert.ok(lineBytes <= bT);
  assert.ok(lineBytes * 2 > bT);
  const total = bT + reserved.kIn + reserved.kOut + reserved.readBytes;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 1024 * 1024,
      total,
      totalGlobal: total + reserved.perChild + reserved.muxReserve,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      total,
    });
    const first = await pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000);
    assert.equal(first.payload.length, pad);
    const second = await pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 2 },
    }, 3_000);
    assert.equal(second.payload.length, pad);
  } finally {
    await pair.close();
  }
});

test('concurrent calls fill the original send window', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pad = 3000;
  const calls = 3;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const idBytes = (id) => Buffer.byteLength(JSON.stringify('wide')) + Buffer.byteLength(JSON.stringify(id));
  let ident = 0;
  for (let id = 1; id <= calls; id++) ident += idBytes(id);
  // The grant is the ceiling minus those identifiers. Three result lines
  // fill it, and a fourth line does not. The slack covers the mux wrapper.
  const slack = 2048;
  assert.ok(slack < lineBytes);
  const bT = calls * lineBytes + ident + slack;
  const total = bT + reserved.kIn + reserved.kOut + reserved.readBytes;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending: 8,
      partial: 1024 * 1024,
      total,
      totalGlobal: total + reserved.perChild + reserved.muxReserve,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      pending: 8,
      total,
    });
    const rec = pair.sup.children.get('wide');
    // Stop and admit before the first await. A stop that takes a timer turn
    // would let the full ceiling be granted, and the later calls would then
    // be rejected for sitting beside that credit.
    process.kill(kid.pid, 'SIGSTOP');
    const pending = [];
    for (let id = 1; id <= calls; id++) {
      pending.push(pair.stub.call({
        pluginId: 'wide',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: { n: id },
      }, 3_000));
    }
    assert.equal(await stopChild(kid.pid), true);
    const granted = await waitUntil(
      () => rec.creditSent > 0 && rec.outbound === 0 && rec.callPending === calls && rec.sendWindow > 0,
      2_000,
    );
    assert.equal(granted, true, JSON.stringify({
      creditSent: rec.creditSent,
      outbound: rec.outbound,
      callPending: rec.callPending,
      sendWindow: rec.sendWindow,
    }));
    const window = rec.sendWindow;
    assert.ok(window >= calls * lineBytes, `${window} < ${calls * lineBytes}`);
    assert.ok(window < (calls + 1) * lineBytes, `${window} fits another line`);
    process.kill(kid.pid, 'SIGCONT');
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((row) => row.payload?.length), Array(calls).fill(pad));
  } finally {
    const proc = pair.sup.children.get('wide')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('fd 0 is a valid mux handle and a rejected mux closes both ends', async () => {
  const script = `
    import { fstatSync } from 'node:fs';
    import { Supervisor, connectEnds } from './src/supervisor.mjs';
    import { socketPair } from './src/kernel-stub.mjs';
    import { closeFd, dupFd } from './src/flow_socket.mjs';

    const stdin = dupFd(0);
    if (stdin == null || stdin <= 0) throw new Error('stdin dup ' + stdin);
    closeFd(0);
    try {
      const ends = await socketPair();
      let fd = ends.supervisorFd;
      if (fd !== 0) {
        try { closeFd(0); } catch { /* already closed */ }
        fd = dupFd(ends.supervisorFd);
      }
      if (fd !== 0) throw new Error('expected fd 0, got ' + fd);
      const sup = new Supervisor({
        fd: 0,
        kMuxIn: ends.kMuxIn,
        kMuxOut: ends.kMuxOut,
        muxSndbuf: ends.muxSndbuf,
        muxRcvbuf: ends.muxRcvbuf,
      });
      if (sup.muxFd !== 0) throw new Error('muxFd ' + sup.muxFd);
      await sup.close();
      closeFd(ends.supervisorFd);
      ends.kernel.destroy();

      const failed = await socketPair();
      failed.kMuxIn = 0;
      let code = null;
      try {
        connectEnds(failed);
      } catch (err) {
        code = err?.code ?? null;
      }
      if (code !== 'flow-unavailable') throw new Error('code ' + code);
      if (!failed.kernel.destroyed) throw new Error('kernel still open');
      let supervisorClosed = false;
      try { fstatSync(failed.supervisorFd); }
      catch { supervisorClosed = true; }
      if (!supervisorClosed) throw new Error('supervisor fd still open');
    } finally {
      try { closeFd(0); } catch { /* already closed */ }
      const back = dupFd(stdin);
      if (back !== 0) throw new Error('stdin restored onto ' + back);
      closeFd(stdin);
    }
    console.log('ok');
  `;
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout });
    });
  });
  assert.match(stdout, /ok/);
});
