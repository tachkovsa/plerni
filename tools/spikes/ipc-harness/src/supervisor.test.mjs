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
import { MuxFramer, STDOUT_KIND_PREFIX, classifyStdoutLine, encodeMux, encodeNdjson } from './framing.mjs';
import { FencedError } from './authority.mjs';
import { DEFAULT_CAPS, PARTIAL_READ_CHUNK, PLUGIN_ENV_ENTRY_MAX, PLUGIN_ENV_MAX, Supervisor, USABLE_RESPONSE, connectEnds, connectPair, dbConfigured, partialCapHolds, pluginEnvBlock, stdinControlReserve, totalCapHolds, writePluginEnv } from './supervisor.mjs';
import { socketPair } from './kernel-stub.mjs';
import { entryIsPrivate, resolveCacheDir } from './pipe_pending.mjs';
import { closeFd, dupFd, fionread, measureFlowReserve, openEnvPipe, processGroup, spawnSleeper } from './flow_socket.mjs';
import { execFile } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
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
    caps: { totalGlobal: 64 + pluginEnvBlock({}, 'echo').length + reserved.perChild + reserved.muxReserve },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(200, 0);
    pair.stub.socket.write(Buffer.concat([prefix, Buffer.alloc(80, 0x61)]));
    // The environment pipe is inside the sum until the wrapper reads it.
    // B_g stays below C after that, so the read never starts. The unfinished
    // frame stays in the kernel reservation and a later write does not enter
    // userspace.
    const drained = await waitUntil(() => pair.sup.bufferedBytes() === 0, 2_000);
    assert.equal(drained, true, String(pair.sup.bufferedBytes()));
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

// The idle park sweep rejects a stuck queue after 40ms. Holding the timer
// keeps a parked call in place so a test can observe it past that sweep.
function holdPark(rec) {
  if (rec.parkTimer?.held) return;
  const timer = rec.parkTimer;
  const held = setTimeout(() => {}, 60_000);
  held.unref();
  held.held = true;
  rec.parkTimer = held;
  if (!timer) return;
  if (typeof timer._onTimeout === 'function') clearTimeout(timer);
  else clearImmediate(timer);
}

test('parked call bytes count toward the global ceiling', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  // The call hole is outside the grant and larger than one child's kernel
  // reserve, so a sibling fits beside the advertised window until parked
  // calls fill that hole. Parked bytes stay beside the window; they are not
  // stored in the credit the child was told it may still write.
  const pending = 32;
  const hole = 1209 * pending;
  const slack = 20_000;
  const totalGlobal = hole + slack + 2 * reserved.perChild + reserved.muxReserve;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending,
      pendingGlobal: 128,
      total: 8 * 1024 * 1024,
      totalGlobal,
    },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(() => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 0, 2_000);
    assert.equal(granted, true, String(rec.sendWindow));
    const early = pair.sup.spawn({
      pluginId: 'sib',
      script: echoPath,
      pending,
      total: 8 * 1024 * 1024,
    });
    assert.equal(early.credential.pluginId, 'sib');
    stop('sib');
    const released = await waitUntil(() => pair.sup.children.get('sib')?.dead === true, 3_000);
    assert.equal(released, true);
    assert.equal(await stopChild(rec.child.pid), true);
    let windows = 0;
    for (const child of pair.sup.children.values()) {
      if (child.dead || !child.flowOk || !(child.sendWindow > 0)) continue;
      windows += child.sendWindow;
    }
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    for (let i = 0; i < 24; i++) {
      pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: 'p'.repeat(3000),
      }, 5_000).catch(() => {});
    }
    const held = await waitUntil(() => {
      if (rec.parked.length > 0) holdPark(rec);
      return rec.parkedBytes > reserved.perChild;
    }, 2_000);
    assert.equal(held, true, JSON.stringify({
      parkedBytes: rec.parkedBytes,
      buffered: pair.sup.bufferedBytes(),
      window: rec.sendWindow,
      parked: rec.parked.length,
    }));
    assert.ok(
      pair.sup.bufferedBytes() >= rec.parkedBytes,
      `${pair.sup.bufferedBytes()} < ${rec.parkedBytes}`,
    );
    assert.ok(
      pair.sup.bufferedBytes() + windows <= globalCap,
      `buffered ${pair.sup.bufferedBytes()} + window ${windows} exceeds ${globalCap}`,
    );
    assert.throws(
      () => pair.sup.spawn({ pluginId: 'sib2', script: echoPath, pending, total: 8 * 1024 * 1024 }),
      (err) => err?.code === 'spawn-rejected',
    );
    assert.equal(pair.sup.children.has('sib2'), false);
  } finally {
    stop('echo');
    stop('sib');
    await pair.close();
  }
});

test('a parked call is not sent after its caller times out', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, total: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 64,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    const written = [];
    const stdin = rec.child.stdin;
    const orig = stdin.write.bind(stdin);
    stdin.write = (chunk, enc, cb) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8').toString('utf8');
      written.push(text);
      if (typeof enc === 'function') return orig(chunk, enc);
      return orig(chunk, enc, cb);
    };
    const granted = await waitUntil(() => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 0, 2_000);
    assert.equal(granted, true, String(rec.creditSent));
    assert.equal(await stopChild(rec.child.pid), true);
    // The grant leaves the call hole outside the window. A call that does not
    // fit beside that window is rejected. These fillers fit there and fill
    // K_out on the stopped child, so the next call parks instead.
    const fillerLine = Buffer.byteLength(encodeNdjson({
      kind: 'call',
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: 'y'.repeat(2000),
    }));
    const fillerCount = Math.max(2, Math.ceil((rec.kOut + 1) / fillerLine));
    assert.ok(fillerCount * fillerLine < rec.sendWindow, `${fillerCount} fillers would consume the window`);
    for (let i = 0; i < fillerCount; i++) {
      pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: 'y'.repeat(2000),
      }, 5_000).catch(() => {});
    }
    const blocked = await waitUntil(
      () => rec.parked.length > 0 || rec.outbound + fillerLine > rec.kOut,
      1_000,
    );
    assert.equal(blocked, true, JSON.stringify({
      outbound: rec.outbound,
      kOut: rec.kOut,
      parked: rec.parked.length,
    }));
    const victimId = 'parked-late';
    const victim = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: victimId,
      port: 'db',
      method: 'get',
      payload: 'y'.repeat(rec.kOut),
    }, 300).catch((err) => err);
    const saw = await waitUntil(() => {
      const parked = rec.parked.some((entry) => entry.msg.correlationId === victimId);
      if (parked) holdPark(rec);
      return parked;
    }, 1_000);
    assert.equal(saw, true, JSON.stringify({
      parked: rec.parked.map((entry) => entry.msg.correlationId),
      pending: pair.sup.pending.size,
    }));
    const err = await victim;
    assert.equal(err.code, 'timeout', err?.code);
    const left = await waitUntil(
      () => !rec.parked.some((entry) => entry.msg.correlationId === victimId)
        && pair.sup.pending.has('echo', victimId, 'call') === false,
      500,
    );
    assert.equal(left, true, 'timed-out call stayed reserved');
    process.kill(rec.child.pid, 'SIGCONT');
    await delay(200);
    assert.equal(written.some((line) => line.includes(victimId)), false);
    const fresh = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 'fresh-after-park',
      port: 'db',
      method: 'get',
      payload: { n: 2 },
    }, 3_000);
    assert.equal(fresh.payload?.n, 2);
    assert.equal(pair.sup.pending.has('echo', victimId, 'call'), false);
    assert.equal(rec.parked.some((entry) => entry.msg.correlationId === victimId), false);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a parked call stays queued when its cancel times out', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, total: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 64,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(granted, true, String(rec.creditSent));
    let releaseWrite = null;
    const stdin = rec.child.stdin;
    const orig = stdin.write.bind(stdin);
    // The filler reaches the kernel, and the supervisor callback stays held
    // so a later cancel cannot skip ahead of that write.
    stdin.write = (chunk, enc, cb) => {
      const done = typeof enc === 'function' ? enc : cb;
      if (releaseWrite == null) {
        orig(chunk, () => {});
        releaseWrite = () => {
          if (typeof done === 'function') done();
        };
        return false;
      }
      return orig(chunk, enc, cb);
    };
    assert.equal(await stopChild(rec.child.pid), true);
    // The filler occupies the single stdin write. The victim fits in K_out on
    // its own, and misses once the filler is still charged, so it parks. A
    // cancel is smaller than that slack and is accepted.
    const fillerId = 'filler-blocked';
    const victimId = 'parked-cancel';
    const fillerPayload = { n: 1 };
    const fillerBytes = Buffer.byteLength(encodeNdjson({
      kind: 'call',
      correlationId: fillerId,
      port: 'db',
      method: 'get',
      payload: fillerPayload,
    }));
    const reserve = stdinControlReserve();
    const cancelBytes = (id) => Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId: id }));
    // The parked call reserves the largest cancel still owed, including the
    // filler's id, not only its own.
    const callReserve = reserve.grant + Math.max(reserve.cancel, cancelBytes(victimId), cancelBytes(fillerId));
    const victimLine = (pad) => encodeNdjson({
      kind: 'call',
      correlationId: victimId,
      port: 'db',
      method: 'get',
      payload: { n: 7, pad },
    });
    let lo = 0;
    let hi = rec.kOut;
    let pad = '';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = 'y'.repeat(mid);
      if (Buffer.byteLength(victimLine(candidate)) + callReserve <= rec.kOut) {
        pad = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const victimBytes = Buffer.byteLength(victimLine(pad));
    assert.ok(victimBytes + callReserve <= rec.kOut, `${victimBytes} reserve ${callReserve} kOut ${rec.kOut}`);
    assert.ok(
      victimBytes + callReserve + fillerBytes > rec.kOut,
      `${victimBytes} + ${fillerBytes} vs ${rec.kOut}`,
    );
    const filler = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: fillerId,
      port: 'db',
      method: 'get',
      payload: fillerPayload,
    }, 8_000).catch((err) => err);
    const victim = pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: victimId,
      port: 'db',
      method: 'get',
      payload: { n: 7, pad },
    }, 8_000);
    const saw = await waitUntil(() => {
      const parked = rec.parked.some((entry) => entry.msg.correlationId === victimId);
      if (parked) holdPark(rec);
      return parked && rec.stdinWriting && pair.sup.pending.has('echo', victimId, 'call');
    }, 1_000);
    assert.equal(saw, true, JSON.stringify({
      parked: rec.parked.map((entry) => entry.msg.correlationId),
      writing: rec.stdinWriting,
      outbound: rec.outbound,
      kOut: rec.kOut,
      pending: pair.sup.pending.has('echo', victimId, 'call'),
      queued: rec.stdinPayload.length,
    }));
    const cancel = await pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: victimId,
    }, 200).catch((err) => err);
    assert.equal(cancel.code, 'timeout', JSON.stringify({ code: cancel?.code, kind: cancel?.kind }));
    const expired = await waitUntil(
      () => pair.sup.pending.has('echo', victimId, 'cancel') === false,
      1_000,
    );
    assert.equal(expired, true, 'cancel lane still pending');
    assert.equal(rec.parked.some((entry) => entry.msg.correlationId === victimId), true);
    assert.equal(pair.sup.pending.has('echo', victimId, 'call'), true);
    if (rec.parkTimer?.held) {
      clearTimeout(rec.parkTimer);
      rec.parkTimer = null;
    }
    rec.parkSince = null;
    rec.parkKernel = null;
    process.kill(rec.child.pid, 'SIGCONT');
    await delay(50);
    assert.equal(typeof releaseWrite, 'function');
    releaseWrite();
    const done = await victim;
    assert.equal(done.payload?.n, 7);
    assert.equal(rec.parked.some((entry) => entry.msg.correlationId === victimId), false);
    assert.equal(pair.sup.pending.has('echo', victimId, 'call'), false);
    await filler;
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a parked call reserves its correlation id', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, total: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 64,
      total: 8 * 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    assert.equal(await stopChild(rec.child.pid), true);
    const calls = [];
    for (let i = 0; i < 12; i++) {
      calls.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: 'z'.repeat(2000),
      }, 5_000).catch((err) => err));
    }
    const parked = await waitUntil(() => {
      if (rec.parked.length > 0) holdPark(rec);
      return rec.parked.length > 0;
    }, 1_000);
    assert.equal(parked, true, String(rec.parked.length));
    const victim = rec.parked[0];
    const victimId = victim.msg.correlationId;
    assert.equal(pair.sup.pending.has('echo', victimId, 'call'), true);
    assert.equal(rec.callPending, pair.sup.pending.size);
    const pendingSize = pair.sup.pending.size;
    const callPending = rec.callPending;
    const parkedCount = rec.parked.length;
    pair.stub.socket.write(encodeMux({
      kind: 'call',
      pluginId: 'echo',
      correlationId: victimId,
      credential: kid.credential,
      port: 'db',
      method: 'get',
      payload: { n: 9 },
      timeoutMs: 300,
    }));
    await delay(30);
    assert.equal(rec.parked.length, parkedCount);
    assert.equal(pair.sup.pending.size, pendingSize);
    assert.equal(rec.callPending, callPending);
    assert.equal(rec.parked.filter((entry) => Object.is(entry.msg.correlationId, victimId)).length, 1);
    if (rec.parkTimer?.held) {
      clearTimeout(rec.parkTimer);
      rec.parkTimer = null;
    }
    process.kill(rec.child.pid, 'SIGCONT');
    await Promise.all(calls);
    const done = await waitUntil(
      () => rec.callPending === 0 && pair.sup.pending.size === 0 && rec.parked.length === 0,
      3_000,
    );
    assert.equal(done, true, JSON.stringify({
      callPending: rec.callPending,
      pending: pair.sup.pending.size,
      parked: rec.parked.length,
    }));
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a mux frame larger than the userspace budget closes the channel', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const globalCap = pair.sup.capsConfig.totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const sample = (payload) => encodeMux({
      kind: 'call',
      pluginId: 'echo',
      correlationId: 1,
      credential: kid.credential,
      port: 'db',
      method: 'get',
      payload,
      timeoutMs: 2_000,
      sendTs: 123456.789012345,
    });
    const overhead = sample('').length;
    const maxFrame = 1024 * 1024 - 256;
    // sendTs's digit count moves the encoded frame by a few bytes.
    const slack = 128;
    assert.ok(globalCap + slack < maxFrame, `globalCap ${globalCap} maxFrame ${maxFrame}`);
    const payload = 'x'.repeat(Math.max(1, globalCap + slack - overhead));
    const frame = sample(payload);
    assert.ok(frame.length > globalCap, `${frame.length} vs ${globalCap}`);
    assert.ok(frame.length < 1024 * 1024, String(frame.length));
    const started = performance.now();
    const err = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload,
    }, 2_000).catch((e) => e);
    const elapsed = performance.now() - started;
    assert.equal(pair.sup.framingFault, 'mux-budget', JSON.stringify({
      code: err?.code,
      elapsed,
      frame: frame.length,
      globalCap,
      bridge: pair.sup.bridge.pendingBytes(),
    }));
    assert.notEqual(err.code, 'timeout');
    assert.ok(err.code === 'closed' || err.code === 'mux-budget', String(err.code));
    assert.ok(elapsed < 1_500, String(elapsed));
    assert.equal(pair.sup.inputPaused, false);
    assert.ok(pair.sup.bridge.pendingBytes() <= pair.sup.readBytes, String(pair.sup.bridge.pendingBytes()));
    const again = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 500).catch((e) => e);
    assert.equal(again.code, 'closed');
  } finally {
    await pair.close();
  }
});

test('a mux frame under the cap that cannot take another full read closes the channel', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const globalCap = pair.sup.capsConfig.totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const drained = await waitUntil(() => pair.sup.bufferedBytes() === 0, 2_000);
    assert.equal(drained, true, String(pair.sup.bufferedBytes()));
    const sample = (payload) => encodeMux({
      kind: 'call',
      pluginId: 'echo',
      correlationId: 1,
      credential: kid.credential,
      port: 'db',
      method: 'get',
      payload,
      timeoutMs: 2_000,
      sendTs: 123456.789012345,
    });
    const overhead = sample('').length;
    // One hundred bytes under the cap, past the last full C-sized read.
    // Default caps on this host are a 1,017,884-byte frame against 1,017,984.
    const target = globalCap - 100;
    assert.ok(target > globalCap - pair.sup.readBytes, `${target} vs ${globalCap}`);
    assert.ok(target < globalCap);
    const payload = 'x'.repeat(Math.max(1, target - overhead));
    const frame = sample(payload);
    assert.ok(frame.length < globalCap, `${frame.length} vs ${globalCap}`);
    assert.ok(frame.length + 64 < pair.stub.byteCap, `${frame.length} vs ${pair.stub.byteCap}`);
    assert.ok(frame.length > globalCap - pair.sup.readBytes, `${frame.length} vs ${globalCap}`);
    const started = performance.now();
    const err = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload,
    }, 2_000).catch((e) => e);
    const elapsed = performance.now() - started;
    assert.equal(pair.sup.framingFault, 'mux-budget', JSON.stringify({
      code: err?.code,
      elapsed,
      frame: frame.length,
      globalCap,
      bridge: pair.sup.bridge.pendingBytes(),
      buffered: pair.sup.bufferedBytes(),
      paused: pair.sup.inputPaused,
    }));
    assert.notEqual(err.code, 'timeout');
    assert.ok(err.code === 'closed' || err.code === 'mux-budget', String(err.code));
    assert.ok(elapsed < 1_500, String(elapsed));
    assert.equal(pair.sup.inputPaused, false);
    const again = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 500).catch((e) => e);
    assert.equal(again.code, 'closed');
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
    const paused = await waitUntil(
      () => pair.sup.inputPaused && pair.sup.bufferedBytes() + pair.sup.readBytes > cap,
      3_000,
    );
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
  const envBytes = pluginEnvBlock({ FLOOD_MODE: 'silent' }, 'partial').length;
  // The encoded block is reserved on the spawn turn. The extra headroom is
  // only the flood frames that fill the low-priority queue.
  const headroom = 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 16, total: 64 * 1024, totalGlobal: envBytes + headroom + reserved.perChild + reserved.muxReserve, partial: 1024 * 1024 },
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
    assert.ok(rec.paused, rec.pauseReason);
    assert.ok(rec.pauseReason === 'bulk' || rec.pauseReason === 'global', rec.pauseReason);
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
  const cap = 80 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      lo: 1000,
      hi: 64,
      pending: 40,
      pendingGlobal: 40,
      total: 8 * 1024 * 1024,
      totalGlobal: cap + reserved.perChild + reserved.muxReserve,
    },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 40,
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
    // The retained id stays charged. A second cancel of a longer id does not
    // fit beside it, and its error frame would also spend the unspent window,
    // so the caller times out instead of receiving that frame.
    const again = await pair.stub.cancel({
      pluginId: 'ig',
      credential: kid.credential,
      correlationId: 'q'.repeat(8_000),
    }, 1_000).catch((err) => err);
    assert.equal(again.code, 'timeout');
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
  const cap = 42_000;
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
      payload: { blob: 'y'.repeat(25_000) },
    }, 1_000).catch((err) => err);
    const paused = await waitUntil(() => pair.sup.inputPaused === true, 1_000);
    assert.equal(paused, true, pair.sup.framingFault);
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
      totalGlobal: reserved.perChild + reserved.muxReserve + pluginEnvBlock({}, 'echo').length,
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
    // The unspent window is reserved beside this fill. Counting it as free
    // bytes would make the deferred reply look larger than B_t.
    const credit = rec.sendWindow > 0 ? rec.sendWindow : 0;
    rec.loBytes = rec.bT - measured + slack - idBytes - other - credit;
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

// The wrapper must exec before SIGSTOP. Waiting here does not return to the
// event loop, so the send-window grant stays unsent and the calls that follow
// are still admitted in this turn.
function waitForRuntime(pid) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('node')) return true;
    } catch {
      return false;
    }
    Atomics.wait(nap, 0, 0, 5);
  }
  return false;
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
    // The environment pipe is still in the sum until the wrapper reads it.
    // Reach the runtime first, then stop and admit before the grant is sent.
    assert.equal(waitForRuntime(sibling.child.pid), true);
    assert.equal(waitForRuntime(kid.pid), true);
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
    // The grant belongs to the wide cap above. The tightened cap is the
    // byte budget under test; a leftover window would be credit against
    // a ceiling this case has already replaced.
    echo.sendWindow = 0;
    sibling.sendWindow = 0;
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
    // The environment pipe is still in the sum until the wrapper reads it.
    // Reach the runtime first, then stop and admit before the grant is sent.
    assert.equal(waitForRuntime(sibling.child.pid), true);
    assert.equal(waitForRuntime(kid.pid), true);
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

test('a terminal frame does not spend a sibling send window', async () => {
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
    assert.equal(waitForRuntime(sibling.child.pid), true);
    assert.equal(waitForRuntime(kid.pid), true);
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
    // The wide-cap grant is not part of this budget. One frame of slack
    // remains, and the sibling's send window is that slack.
    echo.sendWindow = 0;
    sibling.sendWindow = frameLen;
    pair.sup.capsConfig.totalGlobal = reserved.muxReserve + 2 * reserved.perChild + frameLen;
    process.kill(kid.pid, 'SIGKILL');
    const finished = await waitUntil(() => echo.exitFinished === true, 3_000);
    assert.equal(finished, true);
    const settled = await Promise.all(calls);
    assert.ok(settled.every((row) => row?.code === 'timeout'), JSON.stringify(settled.map((row) => row?.code)));
    assert.ok(pair.sup.terminalCoalesced >= 6, String(pair.sup.terminalCoalesced));
    assert.equal(pair.sup.terminal.length, 0);
    assert.ok(
      pair.sup.bufferedBytes() + sibling.sendWindow <= reserved.perChild + frameLen,
      JSON.stringify({ buffered: pair.sup.bufferedBytes(), window: sibling.sendWindow }),
    );
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
    // One rejection frame of slack beside the advertised window. The window
    // stays reserved; the byte fill is the rest of B_t.
    const frame = encodeMux({
      kind: 'rejected',
      code: 'total-cap',
      for: 'call',
      pluginId: 'echo',
      correlationId: 1,
      generation: kid.credential.generation,
    });
    const occupied = Math.max(0, pair.sup.queueDepth('echo').pluginBytes - rec.idBytes);
    const credit = rec.sendWindow > 0 ? rec.sendWindow : 0;
    rec.idBytes = rec.bT - frame.length - credit - occupied;
    assert.ok(rec.idBytes >= 0, JSON.stringify({
      idBytes: rec.idBytes,
      credit,
      occupied,
      ceiling: rec.bT,
      frame: frame.length,
    }));
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
  const envBytes = pluginEnvBlock({ FLOOD_MODE: 'silent' }, 'silent').length;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal: reserved.perChild + reserved.muxReserve + userspace + envBytes,
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

test('mixed-size replies flush credit the half threshold withheld', async () => {
  const totalGlobal = 100_000;
  const small = 10_000;
  const large = 25_000;
  const smallLine = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(small),
  }));
  const largeLine = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 2,
    payload: 'p'.repeat(large),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 32, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('mixed')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'mixed',
      script: responsePath,
      pending: 32,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('mixed');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= smallLine,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    // The first grant covers the small line. Spending it leaves less than
    // the large line, and less than half the room, so the half threshold
    // does not replenish. The sender waits until a later flush.
    assert.ok(rec.sendWindow - smallLine < largeLine, String(rec.sendWindow));
    assert.ok(smallLine * 2 < rec.sendWindow, String(rec.sendWindow));
    const advertised = rec.creditSent;
    const first = await pair.stub.call({
      pluginId: 'mixed',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { pad: small },
    }, 3_000);
    assert.equal(first.payload?.length, small);
    if (rec.creditSent === advertised) {
      assert.ok(rec.sendWindow > 0 && rec.sendWindow < largeLine, String(rec.sendWindow));
    }
    const second = await pair.stub.call({
      pluginId: 'mixed',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { pad: large },
    }, 3_000).catch((err) => err);
    assert.equal(second.payload?.length, large, JSON.stringify({
      code: second.code,
      pause: rec.pauseReason,
      window: rec.sendWindow,
      spent: rec.creditSpent,
      granted: rec.creditSent,
      fault: pair.sup.framingFault,
    }));
    assert.ok(rec.creditSent > advertised, String(rec.creditSent));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    stop();
    await pair.close();
  }
});

// credit-response subtracts only result lines. credit-wait subtracts result
// lines and writes cancelled without subtracting. Neither writes a grant
// line; a grant line is control if one appears. echo keeps no window.
// ignore-cancel and flood are not credit senders (their bytes are data).
// The spend decision is the shared top-level classifier, not a second copy.
function dataSpent(text) {
  const buf = Buffer.from(text);
  let spent = 0;
  let offset = 0;
  while (offset < buf.length) {
    const info = classifyStdoutLine(buf.subarray(offset));
    if (info.complete) {
      if (!info.control) spent += info.length;
      offset += info.length;
      continue;
    }
    if (!info.control && (info.kind != null || info.length > STDOUT_KIND_PREFIX)) spent += info.length;
    break;
  }
  return spent;
}

// Complete lines use JSON.parse's top-level kind. That is not the classifier.
function oracleSpent(text) {
  let spent = 0;
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl < 0) break;
    const body = text.slice(i, nl);
    const bytes = Buffer.byteLength(text.slice(i, nl + 1));
    try {
      const msg = JSON.parse(body);
      const kind = msg && typeof msg === 'object' && typeof msg.kind === 'string' ? msg.kind : '';
      if (kind !== 'cancelled' && kind !== 'grant') spent += bytes;
    } catch {
      spent += bytes;
    }
    i = nl + 1;
  }
  return { spent, tail: text.slice(i) };
}

test('supervisor credit matches the credit senders', async () => {
  const pair = await connectPair({ sweeper: false });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 8000,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    const origin = rec.creditSent;
    const window0 = rec.sendWindow;
    assert.equal(window0, origin);
    const lines = [];
    let state = 0x12345678;
    const kinds = ['result', 'error', 'cancelled', 'grant', 'noop'];
    for (let i = 0; i < 36; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const kind = kinds[state % kinds.length];
      const payload = state % 5 === 0 ? 'p'.repeat(state % 24) : { n: state % 20 };
      lines.push(encodeNdjson({ kind, correlationId: state % 17, payload }));
    }
    lines.push('{"kind":"cancell');
    lines.push('ed","correlationId":3}\n');
    lines.push('{"kin');
    lines.push('d":"result","correlationId":4,"payload":{"n":1}}\n');
    lines.push(encodeNdjson({
      payload: { kind: 'cancelled', text: 'p'.repeat(40), note: 'kind":"grant"' },
      correlationId: 9,
      kind: 'result',
    }));
    lines.push(encodeNdjson({
      payload: { kind: 'result', note: 'kind":"cancelled"' },
      correlationId: 10,
      kind: 'cancelled',
    }));
    lines.push(encodeNdjson({
      kind: 'grant',
      payload: { kind: 'result', text: '"kind":"cancelled"' },
      correlationId: 11,
    }));
    lines.push('a'.repeat(200));
    let text = '';
    for (const piece of lines) {
      text += piece;
      rec.stdoutSocket.emit('data', Buffer.from(piece));
      const spent = dataSpent(text);
      assert.equal(rec.sendWindow, window0 - spent, JSON.stringify({
        spent,
        window: rec.sendWindow,
        window0,
        creditSent: rec.creditSent,
        piece: piece.slice(0, 48),
      }));
      assert.equal(rec.creditSent, origin);
      assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
    }
    const spent = dataSpent(text);
    assert.ok(spent > 0, String(spent));
    const oracle = oracleSpent(text);
    assert.equal(oracle.tail, 'a'.repeat(200));
    assert.equal(spent, oracle.spent + Buffer.byteLength(oracle.tail), JSON.stringify({
      spent,
      oracle: oracle.spent,
      tail: oracle.tail.length,
    }));
    let control = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.kind === 'cancelled' || msg.kind === 'grant') control += Buffer.byteLength(line) + 1;
      } catch {
        // A raw partial is data, not a control ack.
      }
    }
    assert.ok(control > 0, String(control));
    await delay(150);
    assert.ok(rec.creditSent <= origin + spent, JSON.stringify({
      origin,
      sent: rec.creditSent,
      spent,
      control,
    }));
    assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('cancel acks do not recycle data credit', { timeout: 10_000 }, async () => {
  const totalGlobal = 100_000;
  const pending = 8;
  const fitting = 1000;
  const oversized = 80_000;
  const fittingLine = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 100,
    payload: 'p'.repeat(fitting),
  }));
  const oversizedLine = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 101,
    payload: 'p'.repeat(oversized),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, pendingGlobal: 64, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('credit')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'credit',
      script: creditPath,
      pending: 64,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('credit');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= fittingLine,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    const origin = rec.creditSent;
    assert.ok(origin < oversizedLine, `${origin} already covers ${oversizedLine}`);
    assert.ok(origin >= fittingLine, `${origin} < ${fittingLine}`);
    // The quiet flush can still publish a deficit the half threshold was
    // already holding. Ack stdout postpones that flush; it must not add the
    // ack bytes themselves. Sixteen cancelled lines are the ceiling.
    let ackBytes = 0;
    for (let i = 1; i <= 16; i++) {
      ackBytes += Buffer.byteLength(encodeNdjson({ kind: 'cancelled', correlationId: i }));
    }
    const cancels = [];
    for (let i = 0; i < 16; i++) {
      cancels.push(pair.stub.cancel({
        pluginId: 'credit',
        credential: kid.credential,
        correlationId: i + 1,
      }, 2_000).catch((err) => err));
    }
    const acks = await Promise.all(cancels);
    assert.ok(acks.every((row) => row?.kind === 'cancelled'), JSON.stringify(acks.map((row) => row?.kind || row?.code)));
    await delay(150);
    assert.equal(rec.creditSpent, 0, String(rec.creditSpent));
    assert.equal(rec.sendWindow, rec.creditSent);
    assert.ok(rec.creditSent - origin < ackBytes, JSON.stringify({
      origin,
      sent: rec.creditSent,
      window: rec.sendWindow,
      spent: rec.creditSpent,
      ackBytes,
    }));
    const fit = await pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 100,
      port: 'db',
      method: 'get',
      payload: { pad: fitting },
    }, 2_000).catch((err) => err);
    assert.equal(fit.payload?.length, fitting, JSON.stringify({
      code: fit.code,
      pause: rec.pauseReason,
      window: rec.sendWindow,
      sent: rec.creditSent,
    }));
    const beforeOver = rec.creditSent;
    const stall = await pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 101,
      port: 'db',
      method: 'get',
      payload: { pad: oversized },
    }, 400).catch((err) => err);
    assert.equal(stall.code, 'timeout', JSON.stringify({
      code: stall.code,
      pause: rec.pauseReason,
      framer: rec.framer.pendingBytes(),
      window: rec.sendWindow,
      sent: rec.creditSent,
      fault: pair.sup.framingFault,
    }));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assert.ok(rec.framer.pendingBytes() < fittingLine, String(rec.framer.pendingBytes()));
    assert.ok(rec.creditSent < oversizedLine, JSON.stringify({
      origin,
      beforeOver,
      sent: rec.creditSent,
      oversizedLine,
    }));
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    stop();
    await pair.close();
  }
});

test('a reordered result spends credit and refills', { timeout: 15_000 }, async () => {
  const totalGlobal = 100_000;
  const pending = 8;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, pendingGlobal: 64, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('reordered')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  const reorderedLine = (id, n) => encodeNdjson({
    payload: {
      kind: 'cancelled',
      text: 'p'.repeat(n),
      note: 'kind":"grant"',
    },
    correlationId: id,
    kind: 'result',
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'reordered',
      script: responsePath,
      pending,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('reordered');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 0,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    const origin = rec.creditSent;
    // Three lines fit in the first grant. The fourth needs the refill that
    // a nested payload.kind would suppress. A 10_000-byte line does that
    // when the grant is about 30_000; a larger window uses a larger line.
    const target = Math.floor(origin / 3) - 32;
    let pad = Math.max(1, target - 160);
    while (pad > 1 && Buffer.byteLength(reorderedLine(1, pad)) > target) pad--;
    const lineLen = Buffer.byteLength(reorderedLine(1, pad));
    assert.ok(lineLen * 3 <= origin, JSON.stringify({ lineLen, origin, pad }));
    assert.ok(lineLen * 4 > origin, JSON.stringify({ lineLen, origin, pad }));
    assert.equal(JSON.parse(reorderedLine(1, pad)).kind, 'result');
    const calls = [];
    for (let id = 1; id <= 4; id++) {
      calls.push(pair.stub.call({
        pluginId: 'reordered',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: { pad, shape: 'reordered' },
      }, 3_000).catch((err) => err));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((row) => row?.kind === 'result' && row.payload?.text?.length === pad && row.payload?.kind === 'cancelled'), JSON.stringify({
      kinds: results.map((row) => row?.kind || row?.code),
      pause: rec.pauseReason,
      window: rec.sendWindow,
      spent: rec.creditSpent,
      sent: rec.creditSent,
      origin,
      lineLen,
      fault: pair.sup.framingFault,
    }));
    assert.ok(rec.creditSpent > 0, String(rec.creditSpent));
    assert.ok(rec.creditSent > origin, JSON.stringify({ origin, sent: rec.creditSent, spent: rec.creditSpent }));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    stop();
    await pair.close();
  }
});

test('a partial mux frame overlapping an in-credit reply faults', { timeout: 10_000 }, async () => {
  const totalGlobal = 100_000;
  const pending = 8;
  const pad = 57_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('wide')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      pending,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('wide');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    await delay(100);
    assert.equal(await stopChild(rec.child.pid), true);
    const call = pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.has('wide', 1, 'call'), 1_000);
    assert.equal(armed, true);
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const frame = encodeMux({
      kind: 'call',
      pluginId: 'wide',
      correlationId: 2,
      credential: kid.credential,
      port: 'db',
      method: 'get',
      payload: 'm'.repeat(20_000),
      timeoutMs: 2_000,
    });
    assert.ok(frame.length > 16_000, String(frame.length));
    pair.stub.socket.write(frame.subarray(0, 16_000));
    const prefixed = await waitUntil(
      () => pair.sup.bridge.pendingBytes() > 0 && pair.sup.bridge.leadingDeclared() > pair.sup.bridge.pendingBytes(),
      1_000,
    );
    assert.equal(prefixed, true, JSON.stringify({
      mux: pair.sup.bridge.pendingBytes(),
      declared: pair.sup.bridge.leadingDeclared(),
    }));
    const started = performance.now();
    process.kill(rec.child.pid, 'SIGCONT');
    const res = await call;
    const elapsed = performance.now() - started;
    assert.equal(pair.sup.framingFault, 'mux-budget', JSON.stringify({
      code: res.code,
      elapsed,
      pause: rec.pauseReason,
      mux: pair.sup.bridge.pendingBytes(),
      framer: rec.framer.pendingBytes(),
      window: rec.sendWindow,
      buffered: pair.sup.bufferedBytes(),
      globalCap,
    }));
    assert.notEqual(res.code, 'timeout');
    assert.ok(elapsed < 1_500, String(elapsed));
  } finally {
    stop();
    await pair.close();
  }
});

test('overlapping partial mux and stdout frames fault', { timeout: 10_000 }, async () => {
  const totalGlobal = 100_000;
  const pending = 8;
  const pad = 57_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('wide')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      pending,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('wide');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    await delay(80);
    assert.equal(await stopChild(rec.child.pid), true);
    const call = pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.has('wide', 1, 'call'), 1_000);
    assert.equal(armed, true);
    const frame = encodeMux({
      kind: 'call',
      pluginId: 'wide',
      correlationId: 9,
      credential: kid.credential,
      port: 'db',
      method: 'get',
      payload: 'm'.repeat(24_000),
      timeoutMs: 2_000,
    });
    const prefix = frame.subarray(0, 17_024);
    assert.ok(prefix.length < frame.length);
    pair.sup.bridge.feed(prefix);
    assert.ok(pair.sup.bridge.leadingDeclared() > prefix.length);
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    assert.ok(prefix.length + rec.sendWindow > globalCap, JSON.stringify({
      prefix: prefix.length,
      window: rec.sendWindow,
      globalCap,
    }));
    const started = performance.now();
    process.kill(rec.child.pid, 'SIGCONT');
    const err = await call;
    const elapsed = performance.now() - started;
    assert.equal(pair.sup.framingFault, 'mux-budget', JSON.stringify({
      code: err?.code,
      elapsed,
      pause: rec.pauseReason,
      mux: pair.sup.bridge.pendingBytes(),
      framer: rec.framer.pendingBytes(),
      buffered: pair.sup.bufferedBytes(),
      window: rec.sendWindow,
    }));
    assert.notEqual(err.code, 'timeout');
    assert.ok(elapsed < 1_500, String(elapsed));
  } finally {
    stop();
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

test('a stalled mux reader leaves the low-priority queue at its cap', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 32, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 4 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'frames', script: floodPath, total: 1024 * 1024 });
    pair.stub.socket.pause();
    const filled = await waitUntil(() => pair.sup.queueDepth('frames').lo >= 32, 2_000);
    assert.equal(filled, true);
    await delay(400);
    assert.ok(pair.sup.queueDepth('frames').lo >= 32, String(pair.sup.queueDepth('frames').lo));
    assert.equal(pair.sup.flip, null);
  } finally {
    pair.stub.socket.resume();
    await pair.close();
  }
});

test('sibling send windows share one global grant', async () => {
  const totalGlobal = 100_000;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 8, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kidA = pair.sup.spawn({
      pluginId: 'a',
      script: responsePath,
      env: { RESPONSE_PAD: '1024' },
      total: 1024 * 1024,
    });
    const kidB = pair.sup.spawn({
      pluginId: 'b',
      script: responsePath,
      env: { RESPONSE_PAD: '1024' },
      total: 1024 * 1024,
    });
    const recA = pair.sup.children.get('a');
    const recB = pair.sup.children.get('b');
    const granted = await waitUntil(
      () => recA.grantSettled && recB.grantSettled && recA.outbound === 0 && recB.outbound === 0,
      2_000,
    );
    assert.equal(granted, true, JSON.stringify({
      a: recA.sendWindow,
      b: recB.sendWindow,
      settled: [recA.grantSettled, recB.grantSettled],
    }));
    const globalCap = totalGlobal
      - (recA.kIn + recA.kOut + pair.sup.readBytes)
      - (recB.kIn + recB.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    assert.ok(
      recA.sendWindow + recB.sendWindow <= globalCap,
      `windows ${recA.sendWindow}+${recB.sendWindow} exceed ${globalCap}`,
    );
    const [pluginId, kid, rec] = recA.sendWindow >= recB.sendWindow
      ? ['a', kidA, recA]
      : ['b', kidB, recB];
    const lineBytes = Buffer.byteLength(encodeNdjson({
      kind: 'result',
      correlationId: 1,
      payload: 'p'.repeat(1024),
    }));
    assert.ok(rec.sendWindow >= lineBytes, String(rec.sendWindow));
    const res = await pair.stub.call({
      pluginId,
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000);
    assert.equal(res.payload?.length, 1024);
    assert.notEqual(rec.pauseReason, 'global');
  } finally {
    stop('a');
    stop('b');
    await pair.close();
  }
});

test('a compliant response is not stalled by a sibling grant', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const totalGlobal = 100_000;
  const shared = totalGlobal - 2 * reserved.perChild - reserved.muxReserve;
  const pad = 57_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  assert.ok(lineBytes > shared, `${lineBytes} does not exceed the two-child room ${shared}`);
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 8, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'a',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('a');
    const granted = await waitUntil(() => rec.outbound === 0 && rec.sendWindow >= lineBytes, 2_000);
    assert.equal(granted, true, String(rec.sendWindow));
    assert.throws(
      () => pair.sup.spawn({
        pluginId: 'b',
        script: responsePath,
        env: { RESPONSE_PAD: String(pad) },
        total: 1024 * 1024,
      }),
      (err) => err.code === 'spawn-rejected',
    );
    const res = await pair.stub.call({
      pluginId: 'a',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000);
    assert.equal(res.payload?.length, pad);
    assert.notEqual(rec.pauseReason, 'global');
  } finally {
    stop('a');
    stop('b');
    await pair.close();
  }
});

test('advertised credit stays reserved until stdout spends it', async () => {
  const totalGlobal = 100_000;
  const pad = 57_000;
  const muxPartial = 32_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 8, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'a',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('a');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    const advertised = rec.sendWindow;
    assert.equal(rec.creditSent, advertised);
    assert.equal(rec.creditSpent, 0);
    // A retained partial mux frame used to shrink the local window once any
    // stdout had been consumed. The child still holds the unspent grant.
    pair.sup.queuedBytes += muxPartial;
    const noise = Buffer.from('{"kind":"noop"}\n');
    rec.stdoutSocket.emit('data', noise);
    await delay(50);
    const unspent = advertised - noise.length;
    assert.equal(rec.creditSpent, noise.length);
    assert.equal(rec.sendWindow, unspent, JSON.stringify({
      window: rec.sendWindow,
      granted: rec.creditSent,
      spent: rec.creditSpent,
    }));
    assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
    assert.ok(rec.sendWindow >= lineBytes - noise.length);
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    // The old clamp set the window to the room left beside the partial frame.
    assert.ok(
      rec.sendWindow > globalCap - muxPartial,
      `${rec.sendWindow} lost the partial frame from reserved credit (cap ${globalCap})`,
    );
    pair.sup.queuedBytes -= muxPartial;
    assert.throws(
      () => pair.sup.spawn({
        pluginId: 'b',
        script: responsePath,
        env: { RESPONSE_PAD: String(pad) },
        total: 1024 * 1024,
      }),
      (err) => err.code === 'spawn-rejected',
    );
    assert.equal(pair.sup.children.has('b'), false);
    const res = await pair.stub.call({
      pluginId: 'a',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    assert.equal(res.payload?.length, pad, JSON.stringify({
      code: res.code,
      pause: rec.pauseReason,
      window: rec.sendWindow,
      spent: rec.creditSpent,
      granted: rec.creditSent,
    }));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(rec.sendWindow + rec.creditSpent, rec.creditSent);
  } finally {
    stop('a');
    stop('b');
    await pair.close();
  }
});

test('parked calls leave a sibling send window usable', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pad = 40_000;
  const pending = 64;
  const correlationId = 100;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId,
    payload: 'p'.repeat(pad),
  }));
  // A is granted alone. Its ceiling holds the window at the result line,
  // so the pending-sized hole stays outside that window. The global cap
  // leaves B a usable grant after A's window and the second kernel reserve.
  // B is spawned afterwards. The advertised window is not pulled back, and
  // parked calls on B have to leave it usable.
  const hole = 1209 * pending;
  const stampRoom = 1024;
  const margin = 2_048;
  const callSlack = 16_000;
  const childTotal = lineBytes + hole + stampRoom + margin + reserved.perChild;
  const totalGlobal = lineBytes + hole + stampRoom + USABLE_RESPONSE + callSlack + margin
    + 2 * reserved.perChild + reserved.muxReserve;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending,
      pendingGlobal: 128,
      partial: 1024 * 1024,
      total: 1024 * 1024,
      totalGlobal,
    },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kidA = pair.sup.spawn({
      pluginId: 'a',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      pending,
      total: childTotal,
    });
    const recA = pair.sup.children.get('a');
    const granted = await waitUntil(
      () => recA.grantSettled && recA.outbound === 0 && recA.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, JSON.stringify({
      window: recA.sendWindow,
      lineBytes,
      settled: recA.grantSettled,
    }));
    const advertised = recA.sendWindow;
    const kidB = pair.sup.spawn({
      pluginId: 'b',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      pending,
      total: 1024 * 1024,
    });
    const recB = pair.sup.children.get('b');
    assert.equal(recA.sendWindow, advertised, JSON.stringify({
      before: advertised,
      after: recA.sendWindow,
    }));
    const envClear = await waitUntil(() => pair.sup.bufferedBytes() < 1024, 2_000);
    assert.equal(envClear, true, String(pair.sup.bufferedBytes()));
    const globalCap = totalGlobal
      - (recA.kIn + recA.kOut + pair.sup.readBytes)
      - (recB.kIn + recB.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const rejections = [];
    for (let i = 0; i < 40; i++) {
      pair.stub.call({
        pluginId: 'b',
        credential: kidB.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: 'p'.repeat(3000),
      }, 5_000).catch((err) => {
        rejections.push(err?.code ?? 'error');
      });
    }
    const flooded = await waitUntil(() => {
      if (recB.parked.length > 0) holdPark(recB);
      return recB.rejectsCoalesced > 0;
    }, 2_000);
    assert.equal(flooded, true, JSON.stringify({
      parked: recB.parkedBytes,
      rejections: rejections.length,
      window: recA.sendWindow,
      bWindow: recB.sendWindow,
      buffered: pair.sup.bufferedBytes(),
      globalCap,
      coalesced: recB.rejectsCoalesced,
      pending: pair.sup.pending.size,
      paused: pair.sup.inputPaused,
      fault: pair.sup.framingFault,
      mux: pair.sup.bridge.pendingBytes(),
      declared: pair.sup.bridge.leadingDeclared(),
    }));
    assert.ok(recB.rejectsCoalesced > 0, String(recB.rejectsCoalesced));
    assert.ok(rejections.every((code) => code === 'total-cap'), JSON.stringify(rejections));
    assert.ok(
      pair.sup.bufferedBytes() + recA.sendWindow <= globalCap,
      `buffered ${pair.sup.bufferedBytes()} + window ${recA.sendWindow} exceeds ${globalCap}`,
    );
    const res = await pair.stub.call({
      pluginId: 'a',
      credential: kidA.credential,
      correlationId,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    assert.equal(res.payload?.length, pad, JSON.stringify({
      code: res.code,
      pause: recA.pauseReason,
      framer: recA.framer.pendingBytes(),
      buffered: pair.sup.bufferedBytes(),
      window: recA.sendWindow,
      parked: recB.parkedBytes,
      globalCap,
    }));
    assert.notEqual(recA.pauseReason, 'global');
  } finally {
    stop('a');
    stop('b');
    await pair.close();
  }
});

test('a child admitted after earlier grants have settled can obtain usable credit', async () => {
  const pad = 4_000;
  assert.equal(USABLE_RESPONSE, Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  })));
  const pair = await connectPair({ sweeper: false });
  const kids = [];
  const ids = [];
  const stop = () => {
    for (const id of ids) {
      const proc = pair.sup.children.get(id)?.child;
      if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    }
  };
  let held = null;
  try {
    let rejected = null;
    for (let i = 0; i < 8; i++) {
      const pluginId = `late-${i}`;
      let kid;
      try {
        kid = pair.sup.spawn({
          pluginId,
          script: responsePath,
          env: { RESPONSE_PAD: String(pad) },
        });
      } catch (err) {
        assert.equal(err.code, 'spawn-rejected', err.message);
        assert.equal(pair.sup.children.has(pluginId), false);
        rejected = pluginId;
        break;
      }
      ids.push(pluginId);
      kids.push(kid);
      const rec = pair.sup.children.get(pluginId);
      const granted = await waitUntil(
        () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= USABLE_RESPONSE,
        3_000,
      );
      assert.equal(granted, true, JSON.stringify({
        pluginId,
        window: rec.sendWindow,
        settled: rec.grantSettled,
        outbound: rec.outbound,
      }));
    }
    assert.equal(rejected, 'late-5');
    assert.equal(ids.length, 5);
    for (const id of ids) {
      const rec = pair.sup.children.get(id);
      assert.equal(rec.dead, false);
      assert.ok(rec.sendWindow >= USABLE_RESPONSE, `${id} ${rec.sendWindow}`);
      assertAccountingInvariants(pair.sup, rec);
    }
    const last = ids.length - 1;
    const answered = await pair.stub.call({
      pluginId: ids[last],
      credential: kids[last].credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    assert.equal(answered.payload?.length, pad, JSON.stringify({
      code: answered.code,
      pause: pair.sup.children.get(ids[last]).pauseReason,
      window: pair.sup.children.get(ids[last]).sendWindow,
    }));
    const crashed = ids[last];
    const before = pair.sup.children.get(crashed);
    before.child.kill('SIGKILL');
    const next = await pair.sup.respawn(crashed);
    ids.push(crashed);
    const respawned = pair.sup.children.get(crashed);
    const respawnGrant = await waitUntil(
      () => respawned.grantSettled
        && respawned.outbound === 0
        && respawned.sendWindow >= USABLE_RESPONSE
        && respawned.credential.generation === next.credential.generation,
      3_000,
    );
    assert.equal(respawnGrant, true, JSON.stringify({
      window: respawned.sendWindow,
      generation: respawned.credential.generation,
      dead: respawned.dead,
    }));
    const afterCrash = await pair.stub.call({
      pluginId: crashed,
      credential: next.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { n: 2 },
    }, 3_000).catch((err) => err);
    assert.equal(afterCrash.payload?.length, pad, JSON.stringify({
      code: afterCrash.code,
      pause: respawned.pauseReason,
      window: respawned.sendWindow,
    }));
    const victimId = ids[0];
    const victim = pair.sup.children.get(victimId);
    held = dupFd(victim.stdoutWriter);
    victim.child.kill('SIGKILL');
    const draining = await waitUntil(() => victim.exited === true && victim.exitFinished === false, 2_000);
    assert.equal(draining, true);
    assert.throws(
      () => pair.sup.spawn({
        pluginId: 'during-drain',
        script: responsePath,
        env: { RESPONSE_PAD: String(pad) },
      }),
      (err) => err.code === 'spawn-rejected',
    );
    assert.equal(pair.sup.children.has('during-drain'), false);
    closeFd(held);
    held = null;
    const released = await waitUntil(() => victim.dead === true && victim.exitFinished === true, 3_000);
    assert.equal(released, true);
    const born = pair.sup.spawn({
      pluginId: 'after-exit',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
    });
    ids.push('after-exit');
    const bornRec = pair.sup.children.get('after-exit');
    const bornGrant = await waitUntil(
      () => bornRec.grantSettled && bornRec.outbound === 0 && bornRec.sendWindow >= USABLE_RESPONSE,
      3_000,
    );
    assert.equal(bornGrant, true, String(bornRec.sendWindow));
    const afterExit = await pair.stub.call({
      pluginId: 'after-exit',
      credential: born.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { n: 3 },
    }, 3_000).catch((err) => err);
    assert.equal(afterExit.payload?.length, pad, JSON.stringify({
      code: afterExit.code,
      pause: bornRec.pauseReason,
      window: bornRec.sendWindow,
    }));
    for (const id of new Set(ids)) {
      const rec = pair.sup.children.get(id);
      if (!rec || rec.dead || rec.exited) continue;
      assert.ok(rec.sendWindow >= USABLE_RESPONSE, `${id} ${rec.sendWindow}`);
    }
  } finally {
    closeFd(held);
    stop();
    await pair.close();
  }
});

test('children admitted together can each obtain usable credit', async () => {
  const pad = 4_000;
  const counts = [1, 4, 8];
  for (const n of counts) {
    const pair = await connectPair({ sweeper: false });
    const ids = [];
    const stop = () => {
      for (const id of ids) {
        const proc = pair.sup.children.get(id)?.child;
        if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
      }
    };
    try {
      for (let i = 0; i < n; i++) {
        const pluginId = `idle-${i}`;
        ids.push(pluginId);
        pair.sup.spawn({
          pluginId,
          script: responsePath,
          env: { RESPONSE_PAD: String(pad) },
        });
      }
      const records = ids.map((id) => pair.sup.children.get(id));
      const granted = await waitUntil(
        () => records.every((rec) => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= USABLE_RESPONSE),
        3_000,
      );
      const windows = records.map((rec) => rec.sendWindow);
      assert.equal(granted, true, JSON.stringify({ n, windows }));
      const min = Math.min(...windows);
      const max = Math.max(...windows);
      assert.ok(min >= USABLE_RESPONSE, JSON.stringify({ n, windows }));
      assert.ok(min * 2 >= max, JSON.stringify({ n, windows }));
      for (const rec of records) assertAccountingInvariants(pair.sup, rec);
      const follower = `idle-${n}`;
      let followerKid = null;
      try {
        followerKid = pair.sup.spawn({
          pluginId: follower,
          script: responsePath,
          env: { RESPONSE_PAD: String(pad) },
        });
      } catch (err) {
        assert.equal(err.code, 'spawn-rejected', err.message);
        assert.equal(pair.sup.children.has(follower), false);
        assert.equal(n, 8);
        continue;
      }
      ids.push(follower);
      const rec = pair.sup.children.get(follower);
      const followed = await waitUntil(
        () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= USABLE_RESPONSE,
        3_000,
      );
      assert.equal(followed, true, JSON.stringify({ n, window: rec.sendWindow }));
      assert.notEqual(n, 8);
      const res = await pair.stub.call({
        pluginId: follower,
        credential: followerKid.credential,
        correlationId: 1,
        port: 'db',
        method: 'get',
        payload: { n: 1 },
      }, 3_000).catch((err) => err);
      assert.equal(res.payload?.length, pad, JSON.stringify({ n, code: res.code, window: rec.sendWindow }));
    } finally {
      stop();
      await pair.close();
    }
  }
});

test('every live child receives a fair send window', async () => {
  const pad = 4_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const counts = [2, 7];
  for (const n of counts) {
    const pair = await connectPair({ sweeper: false });
    const ids = [];
    const stop = () => {
      for (const id of ids) {
        const proc = pair.sup.children.get(id)?.child;
        if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
      }
    };
    try {
      const kids = [];
      for (let i = 0; i < n; i++) {
        const pluginId = `child-${i}`;
        ids.push(pluginId);
        kids.push(pair.sup.spawn({
          pluginId,
          script: responsePath,
          env: { RESPONSE_PAD: String(pad) },
        }));
      }
      const records = ids.map((id) => pair.sup.children.get(id));
      const granted = await waitUntil(
        () => records.every((rec) => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= lineBytes),
        3_000,
      );
      const windows = records.map((rec) => rec.sendWindow);
      assert.equal(granted, true, JSON.stringify({ n, windows, lineBytes }));
      const min = Math.min(...windows);
      const max = Math.max(...windows);
      assert.ok(min >= lineBytes, JSON.stringify({ n, windows, lineBytes }));
      assert.ok(min * 2 >= max, JSON.stringify({ n, windows }));
      for (const rec of records) assertAccountingInvariants(pair.sup, rec);
      const last = n - 1;
      const res = await pair.stub.call({
        pluginId: ids[last],
        credential: kids[last].credential,
        correlationId: 1,
        port: 'db',
        method: 'get',
        payload: { n: 1 },
      }, 3_000).catch((err) => err);
      assert.equal(res.payload?.length, pad, JSON.stringify({
        n,
        code: res.code,
        pause: records[last].pauseReason,
        window: records[last].sendWindow,
      }));
      assert.notEqual(records[last].pauseReason, 'global');
    } finally {
      stop();
      await pair.close();
    }
  }
});

test('reply metadata is charged beside sibling send windows', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pad = 4_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 7,
    payload: 'p'.repeat(pad),
  }));
  const totalGlobal = 100_000;
  const pending = 32;
  const globalCap2 = totalGlobal - 2 * reserved.perChild - reserved.muxReserve;
  // The ack stays under B_g on its own, and clears B_g once the sibling
  // window is added. Any window that can carry the result line is enough.
  const versionLen = globalCap2 - lineBytes - 1_500;
  assert.ok(versionLen > 20_000, JSON.stringify({ versionLen, globalCap2, lineBytes }));
  assert.ok(versionLen + 512 < globalCap2, JSON.stringify({ versionLen, globalCap2 }));
  const version = 'v'.repeat(versionLen);
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kidA = pair.sup.spawn({
      pluginId: 'a',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      pending,
      total: 1024 * 1024,
    });
    const recA = pair.sup.children.get('a');
    const granted = await waitUntil(
      () => recA.grantSettled && recA.outbound === 0 && recA.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, String(recA.sendWindow));
    const kidB = pair.sup.spawn({
      pluginId: 'b',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      version,
      pending,
      total: 1024 * 1024,
    });
    const recB = pair.sup.children.get('b');
    assert.equal(recB.credential.version.length, versionLen);
    const globalCap = totalGlobal
      - (recA.kIn + recA.kOut + pair.sup.readBytes)
      - (recB.kIn + recB.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const ack = encodeMux({
      kind: 'cancelled',
      for: 'cancel',
      pluginId: 'b',
      correlationId: 1,
      version,
      generation: kidB.credential.generation,
      grants: [...kidB.credential.grants],
    });
    assert.ok(ack.length <= globalCap, `${ack.length} would miss even with no window (cap ${globalCap})`);
    assert.ok(
      recA.sendWindow + ack.length > globalCap,
      JSON.stringify({ window: recA.sendWindow, ack: ack.length, globalCap }),
    );
    const cancel = pair.stub.cancel({
      pluginId: 'b',
      credential: kidB.credential,
      correlationId: 1,
    }, 3_000).catch((err) => err);
    const pendingCancel = await waitUntil(() => pair.sup.pending.has('b', 1, 'cancel'), 1_000);
    assert.equal(pendingCancel, true, JSON.stringify({
      fault: pair.sup.framingFault,
      paused: pair.sup.inputPaused,
      mux: pair.sup.bridge.pendingBytes(),
      declared: pair.sup.bridge.leadingDeclared(),
      buffered: pair.sup.bufferedBytes(),
      window: recA.sendWindow,
      globalCap,
    }));
    const before = pair.sup.bufferedBytes();
    recB.stdoutSocket.emit('data', Buffer.from(encodeNdjson({ kind: 'cancelled', correlationId: 1 })));
    const cancelDone = await cancel;
    assert.equal(cancelDone.code, 'total-cap', JSON.stringify({
      kind: cancelDone.kind,
      code: cancelDone.code,
      buffered: pair.sup.bufferedBytes(),
      before,
      window: recA.sendWindow,
      ack: ack.length,
      globalCap,
    }));
    assert.ok(pair.sup.bufferedBytes() < before + ack.length, JSON.stringify({
      before,
      after: pair.sup.bufferedBytes(),
      ack: ack.length,
    }));
    const res = await pair.stub.call({
      pluginId: 'a',
      credential: kidA.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { n: 7 },
    }, 3_000).catch((err) => err);
    assert.equal(res.payload?.length, pad, JSON.stringify({
      code: res.code,
      pause: recA.pauseReason,
      window: recA.sendWindow,
      buffered: pair.sup.bufferedBytes(),
      globalCap,
    }));
    assert.notEqual(recA.pauseReason, 'global');
    assert.equal(recA.sendWindow + recA.creditSpent, recA.creditSent);
  } finally {
    stop('a');
    stop('b');
    await pair.close();
  }
});

test('reply expansion reserves the replying child remaining credit', async () => {
  const totalGlobal = 100_000;
  const pending = 8;
  const version = 'v'.repeat(20_000);
  const pair = await connectPair({
    sweeper: false,
    caps: { pending, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  const stop = () => {
    const proc = pair.sup.children.get('wide')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  const lineBytes = (id, pad) => Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: id,
    payload: 'p'.repeat(pad),
  }));
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      version,
      pending,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('wide');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 0,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    assertAccountingInvariants(pair.sup, rec);
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const stamp = encodeMux({
      kind: 'result',
      for: 'call',
      pluginId: 'wide',
      correlationId: 0,
      payload: '',
      sendTs: 1e15,
      ingressTs: 1e15,
      egressTs: 1e15,
      version,
      generation: kid.credential.generation,
      grants: [...kid.credential.grants],
    }).length - Buffer.byteLength(encodeNdjson({
      kind: 'result',
      correlationId: 0,
      payload: '',
    }));
    // Headroom for the stamp is outside the advertised window. A 57000-byte
    // line fitted the old grant and then stalled once a smaller stamped reply
    // had occupied the remainder.
    assert.ok(rec.sendWindow + stamp <= globalCap, JSON.stringify({
      window: rec.sendWindow,
      stamp,
      globalCap,
    }));
    assert.ok(lineBytes(1, 57_000) > rec.sendWindow, JSON.stringify({
      window: rec.sendWindow,
      line: lineBytes(1, 57_000),
    }));
    let fit = 1;
    let hi = Math.min(64 * 1024, rec.sendWindow);
    while (fit < hi) {
      const mid = Math.ceil((fit + hi) / 2);
      if (lineBytes(2, mid) <= rec.sendWindow) fit = mid;
      else hi = mid - 1;
    }
    assert.ok(fit > 1_000, String(fit));
    assert.ok(lineBytes(2, fit) <= rec.sendWindow);
    pair.stub.socket.pause();
    const spentAtGrant = rec.creditSpent;
    const cancel = pair.stub.cancel({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 9,
    }, 3_000).catch((err) => err);
    const cancelPending = await waitUntil(() => pair.sup.pending.has('wide', 9, 'cancel'), 1_000);
    assert.equal(cancelPending, true, 'cancel was not admitted beside the window');
    assertAccountingInvariants(pair.sup, rec);
    const beforeAck = pair.sup.bufferedBytes();
    rec.stdoutSocket.emit('data', Buffer.from(encodeNdjson({ kind: 'cancelled', correlationId: 9 })));
    const acked = await waitUntil(() => pair.sup.pending.has('wide', 9, 'cancel') === false, 1_000);
    assert.equal(acked, true, JSON.stringify({
      pause: rec.pauseReason,
      framer: rec.framer.pendingBytes(),
      buffered: pair.sup.bufferedBytes(),
      window: rec.sendWindow,
    }));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assert.equal(rec.creditSpent, spentAtGrant);
    assertAccountingInvariants(pair.sup, rec);
    assert.ok(pair.sup.bufferedBytes() + rec.sendWindow <= globalCap);
    const call = pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 2,
      port: 'db',
      method: 'get',
      payload: { pad: fit },
    }, 3_000).catch((err) => err);
    const read = await waitUntil(
      () => pair.sup.pending.has('wide', 2, 'call') === false && rec.framer.pendingBytes() === 0,
      2_000,
    );
    assert.equal(read, true, JSON.stringify({
      pending: pair.sup.pending.has('wide', 2, 'call'),
      pause: rec.pauseReason,
      framer: rec.framer.pendingBytes(),
      buffered: pair.sup.bufferedBytes(),
      window: rec.sendWindow,
      spent: rec.creditSpent,
      beforeAck,
    }));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assertAccountingInvariants(pair.sup, rec);
    const windowAfter = rec.sendWindow;
    pair.stub.socket.resume();
    const cancelDone = await cancel;
    const done = await call;
    assert.equal(cancelDone.kind, 'cancelled', JSON.stringify({
      kind: cancelDone.kind,
      code: cancelDone.code,
    }));
    assert.equal(done.payload?.length, fit, JSON.stringify({
      code: done.code,
      pause: rec.pauseReason,
      window: rec.sendWindow,
      buffered: pair.sup.bufferedBytes(),
    }));
    assert.notEqual(rec.pauseReason, 'global');
    assertAccountingInvariants(pair.sup, rec);
    const spentAfterFit = rec.creditSpent;
    const oversized = await pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 3,
      port: 'db',
      method: 'get',
      payload: { pad: 57_000 },
    }, 400).catch((err) => err);
    assert.equal(oversized.code, 'timeout', oversized.code);
    assert.ok(rec.creditSpent - spentAfterFit < 57_000, String(rec.creditSpent));
    assert.ok(rec.sendWindow >= windowAfter - (rec.creditSpent - spentAfterFit));
    assert.notEqual(rec.pauseReason, 'global');
    assert.equal(pair.sup.framingFault, null);
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    stop();
    await pair.close();
  }
});

test('parked calls leave the replying child its advertised credit', async () => {
  const pending = 128;
  const replyPad = 40_000;
  const total = 256 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending,
      pendingGlobal: 256,
      partial: 1024 * 1024,
      total,
      totalGlobal: 8 * 1024 * 1024,
    },
  });
  const stop = () => {
    const proc = pair.sup.children.get('credit')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  const callLine = (id, pad) => Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId: id,
    port: 'db',
    method: 'get',
    payload: 'q'.repeat(pad),
  }));
  const replyLine = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(replyPad),
  }));
  const fillers = [];
  const settled = [];
  try {
    const kid = pair.sup.spawn({
      pluginId: 'credit',
      script: responsePath,
      pending,
      total,
    });
    const rec = pair.sup.children.get('credit');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > replyLine,
      2_000,
    );
    assert.equal(granted, true, JSON.stringify({
      window: rec.sendWindow,
      replyLine,
      ceiling: rec.bT,
    }));
    assert.equal(await stopChild(rec.child.pid), true);
    const reply = pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { pad: replyPad },
    }, 3_000).catch((err) => err);
    const armed = await waitUntil(() => pair.sup.pending.has('credit', 1, 'call'), 1_000);
    assert.equal(armed, true, 'the compliant call was not admitted');
    for (let id = 2; id <= pending; id++) {
      fillers.push(pair.stub.call({
        pluginId: 'credit',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: 'q'.repeat(4_000),
      }, 3_000).then((row) => {
        settled.push(row);
        return row;
      }, (err) => {
        settled.push(err);
        return err;
      }));
    }
    const parked = await waitUntil(() => {
      if (rec.parked.length > 0) holdPark(rec);
      return rec.parkedBytes > 0;
    }, 2_000);
    assert.equal(parked, true, JSON.stringify({
      parkedBytes: rec.parkedBytes,
      window: rec.sendWindow,
      ceiling: rec.bT,
    }));
    const rejected = await waitUntil(
      () => settled.some((row) => row?.code === 'total-cap' || row?.code === 'timeout'),
      2_000,
    );
    assert.equal(rejected, true, 'no call was rejected once the window was reserved');
    assertAccountingInvariants(pair.sup, rec);
    const pluginBytes = pair.sup.queueDepth('credit').pluginBytes;
    const gap = rec.bT - pluginBytes - rec.sendWindow;
    const oldRoom = rec.bT - pluginBytes;
    assert.ok(oldRoom > gap, JSON.stringify({ pluginBytes, window: rec.sendWindow, ceiling: rec.bT }));
    assert.ok(replyLine <= rec.sendWindow, JSON.stringify({ replyLine, window: rec.sendWindow }));
    let probePad = 1;
    while (probePad < 8_000 && callLine(pending + 1, probePad) <= gap) probePad += 1;
    const probeLen = callLine(pending + 1, probePad);
    assert.ok(probeLen > gap, JSON.stringify({ probeLen, gap, oldRoom }));
    assert.ok(probeLen < oldRoom, JSON.stringify({ probeLen, gap, oldRoom, window: rec.sendWindow }));
    const beforeParked = rec.parkedBytes;
    const probe = await pair.stub.call({
      pluginId: 'credit',
      credential: kid.credential,
      correlationId: pending + 1,
      port: 'db',
      method: 'get',
      payload: 'q'.repeat(probePad),
    }, 400).catch((err) => err);
    assert.ok(probe.code === 'total-cap' || probe.code === 'timeout', JSON.stringify({
      code: probe.code,
      parked: rec.parkedBytes,
      window: rec.sendWindow,
      bytes: pluginBytes,
    }));
    assert.equal(rec.parkedBytes, beforeParked, 'the probe was parked into advertised credit');
    assert.equal(rec.dead, false);
    assertAccountingInvariants(pair.sup, rec);
    rec.stdoutSocket.emit('data', Buffer.from(encodeNdjson({
      kind: 'result',
      correlationId: 1,
      payload: 'p'.repeat(replyPad),
    })));
    const done = await reply;
    assert.equal(done.payload?.length, replyPad, JSON.stringify({
      code: done.code,
      kind: done.kind,
      pause: rec.pauseReason,
      dead: rec.dead,
      fault: pair.sup.faults.at(-1)?.code,
      parked: rec.parkedBytes,
      window: rec.sendWindow,
      bytes: pair.sup.queueDepth('credit').pluginBytes,
      ceiling: rec.bT,
    }));
    assert.equal(rec.dead, false);
    assert.equal(rec.child.signalCode, null);
    assert.notEqual(rec.pauseReason, 'total');
    assert.equal(pair.sup.faults.some((row) => row.code === 'total-cap'), false);
    assertAccountingInvariants(pair.sup, rec);
  } finally {
    stop();
    await Promise.allSettled(fillers);
    await pair.close();
  }
});

// Checked after every scripted and seeded admission step:
// admitKeep === max(admitFloor, live admitted costs), and that value fits B_t and B_g.
// Each parked id is pending once, and a parked id whose cancel is still pending
// is not sitting in the stdin payload queue.
// A call line is not written after its cancel line while that cancel is in force.
// sendWindow + creditSpent === creditSent. bufferedBytes plus every live window
// fits B_g. Each live child's plugin bytes plus its own unspent window fit
// B_t: pending is a count, and parked, buffered, and admitted bytes are
// inside that sum. A grant that runs while every peer is already live leaves
// each child a window that can carry a small result; a window advertised
// before the peer existed stays as advertised. Reply expansion counts the
// replying child's remaining window as well as every sibling. A quiet flush
// adds withheld data credit and does not shrink sendWindow. Cancel acks and
// grant lines are not that data, so the flush does not advertise them again.
function assertAccountingInvariants(sup, rec) {
  const ceiling = rec.flowOk ? rec.bT : rec.limits.total;
  let kernel = 0;
  for (const child of sup.children.values()) {
    if (!child.dead && child.flowOk) kernel += child.kIn + child.kOut + sup.readBytes;
  }
  const globalCap = sup.capsConfig.totalGlobal - kernel - (sup.kMuxIn + sup.kMuxOut + sup.readBytes);
  assert.ok(rec.admitKeep <= ceiling, `admitKeep ${rec.admitKeep} above B_t ${ceiling}`);
  assert.ok(rec.admitKeep <= globalCap, `admitKeep ${rec.admitKeep} above B_g ${globalCap}`);
  assert.ok(rec.sendWindow >= 0, String(rec.sendWindow));
  let parkedBytes = 0;
  let live = rec.admitFloor || 0;
  const seen = new Set();
  for (const entry of rec.parked) {
    parkedBytes += entry.bytes;
    const id = entry.msg.correlationId;
    assert.equal(seen.has(id), false, `parked twice ${id}`);
    seen.add(id);
    assert.equal(sup.pending.has(rec.credential.pluginId, id, 'call'), true, `parked ${id} is not pending`);
    const idCost = Buffer.byteLength(JSON.stringify(rec.credential.pluginId))
      + Buffer.byteLength(JSON.stringify(id));
    assert.ok(
      (entry.idReserve || 0) >= idCost,
      `parked ${id} reserves ${entry.idReserve} identifier bytes, needs ${idCost}`,
    );
    if (sup.pending.has(rec.credential.pluginId, id, 'cancel')) {
      assert.equal(
        rec.stdinPayload.some((item) => Object.is(item.correlationId, id)),
        false,
        `call ${id} is queued while its cancel is pending`,
      );
    }
  }
  assert.equal(rec.parkedBytes, parkedBytes);
  for (const pending of sup.pending.values()) {
    if (pending.cancel || !(pending.admitCost > live)) continue;
    if (!Object.is(pending.pluginId, rec.credential.pluginId)) continue;
    if (pending.generation !== rec.credential.generation) continue;
    live = pending.admitCost;
  }
  assert.equal(rec.admitKeep, Math.max(rec.admitFloor || 0, live), JSON.stringify({
    admitKeep: rec.admitKeep,
    floor: rec.admitFloor,
    live,
  }));
  assert.equal(
    rec.sendWindow + rec.creditSpent,
    rec.creditSent,
    `window ${rec.sendWindow} + spent ${rec.creditSpent} != granted ${rec.creditSent}`,
  );
  let windows = 0;
  for (const child of sup.children.values()) {
    if (child.dead || !child.flowOk || !(child.sendWindow > 0)) continue;
    windows += child.sendWindow;
  }
  assert.ok(sup.bufferedBytes() + windows <= globalCap, JSON.stringify({
    buffered: sup.bufferedBytes(),
    windows,
    globalCap,
  }));
  for (const child of sup.children.values()) {
    if (child.dead || !child.flowOk) continue;
    const bytes = sup.queueDepth(child.credential.pluginId).pluginBytes;
    const credit = child.sendWindow > 0 ? child.sendWindow : 0;
    assert.ok(bytes + credit <= child.bT, JSON.stringify({
      plugin: child.credential.pluginId,
      bytes,
      credit,
      ceiling: child.bT,
      parked: child.parkedBytes,
    }));
  }
}

function stdinMessages(written) {
  const out = [];
  for (const chunk of written) {
    for (const line of String(chunk).split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a partial write is not a frame */ }
    }
  }
  return out;
}

function assertNoCallAfterItsCancel(written) {
  const cancelled = new Set();
  for (const msg of stdinMessages(written)) {
    if (msg.kind === 'cancel') cancelled.add(msg.correlationId);
    assert.equal(
      msg.kind === 'call' && cancelled.has(msg.correlationId),
      false,
      `stdin wrote call ${msg.correlationId} after its cancel`,
    );
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('admission accounting holds across a seeded mix of calls and cancels', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, pendingGlobal: 128, total: 256 * 1024, totalGlobal: 4 * 1024 * 1024 },
  });
  const stop = () => {
    const proc = pair.sup.children.get('silent')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      pending: 32,
      total: 256 * 1024,
    });
    const rec = pair.sup.children.get('silent');
    const granted = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(granted, true, String(rec.creditSent));
    const written = [];
    const stdin = rec.child.stdin;
    const orig = stdin.write.bind(stdin);
    stdin.write = (chunk, enc, cb) => {
      written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (typeof enc === 'function') return orig(chunk, enc);
      return orig(chunk, enc, cb);
    };
    assert.equal(await stopChild(rec.child.pid), true);
    const rejected = new Set();
    const issue = (id, pad) => {
      pair.stub.call({
        pluginId: 'silent',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: 'p'.repeat(pad),
      }, 4_000).then(() => {}, (err) => {
        if (err?.code) rejected.add(`${id}:${err.code}`);
      });
    };
    const parkPad = rec.kOut;
    const steps = [
      { op: 'call', id: 1, pad: 32 },
      { op: 'call', id: 2, pad: parkPad },
      { op: 'call', id: 3, pad: 1800 },
      { op: 'call', id: 4, pad: 300000 },
      { op: 'cancel', id: 2 },
      { op: 'call', id: 5, pad: 64 },
    ];
    const rng = mulberry32(0xC0FFEE);
    const sizes = [8, 64, 1500, 4000, 300000];
    for (let n = 0; n < 8; n++) steps.push({ op: 'call', id: 100 + n, pad: sizes[Math.floor(rng() * sizes.length)] });
    let keptBeforeReject = null;
    for (const step of steps) {
      if (step.op === 'cancel') {
        const parked = rec.parked.some((entry) => Object.is(entry.msg.correlationId, step.id));
        assert.equal(parked, true, `cancel target ${step.id} was not parked`);
        pair.stub.cancel({
          pluginId: 'silent',
          credential: kid.credential,
          correlationId: step.id,
        }, 4_000).catch(() => {});
        const pendingCancel = await waitUntil(
          () => pair.sup.pending.has('silent', step.id, 'cancel'),
          1_000,
        );
        assert.equal(pendingCancel, true, `cancel ${step.id} was not admitted`);
        await delay(80);
        assert.equal(
          rec.stdinPayload.some((entry) => Object.is(entry.correlationId, step.id)),
          false,
          `call ${step.id} moved to stdin while its cancel was pending`,
        );
        assert.equal(
          rec.parked.some((entry) => Object.is(entry.msg.correlationId, step.id)),
          true,
          `call ${step.id} left the park while its cancel was pending`,
        );
      } else {
        if (step.pad === 300000) keptBeforeReject = rec.admitKeep;
        issue(step.id, step.pad);
        const saw = await waitUntil(() => {
          if ([...rejected].some((item) => item.startsWith(`${step.id}:`))) return true;
          if (rec.parked.some((entry) => Object.is(entry.msg.correlationId, step.id))) {
            holdPark(rec);
            return true;
          }
          return pair.sup.pending.has('silent', step.id, 'call');
        }, 1_000);
        assert.equal(saw, true, JSON.stringify({ id: step.id, pad: step.pad, parked: rec.parked.length }));
        if (step.pad === 300000) {
          assert.equal(rejected.has(`${step.id}:total-cap`), true, `oversized ${step.id} was admitted`);
          assert.equal(pair.sup.pending.has('silent', step.id, 'call'), false);
          assert.equal(rec.admitKeep, keptBeforeReject);
          assert.ok(rec.admitKeep <= rec.bT, `${rec.admitKeep} > ${rec.bT}`);
        }
      }
      assertAccountingInvariants(pair.sup, rec);
      assertNoCallAfterItsCancel(written);
    }
  } finally {
    stop();
    await pair.close();
  }
});

test('a rejected oversized call does not pin send credit', { timeout: 20_000 }, async () => {
  const pad = 40_000;
  const pair = await connectPair({ sweeper: false });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
    });
    const rec = pair.sup.children.get('wide');
    const granted = await waitUntil(() => rec.grantSettled && rec.outbound === 0 && rec.sendWindow > 0, 2_000);
    assert.equal(granted, true, String(rec.sendWindow));
    assert.ok(rec.bT < 300_000, String(rec.bT));
    const before = rec.admitKeep;
    const rejected = await pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 99,
      port: 'db',
      method: 'get',
      payload: 'x'.repeat(300_000),
    }, 2_000).catch((err) => err);
    assert.equal(rejected.code, 'total-cap', JSON.stringify({ code: rejected?.code, keep: rec.admitKeep, bT: rec.bT }));
    assert.equal(rec.admitKeep, before);
    assert.ok(rec.admitKeep <= rec.bT, `${rec.admitKeep} > ${rec.bT}`);
    assertAccountingInvariants(pair.sup, rec);
    for (let id = 1; id <= 8; id++) {
      const res = await pair.stub.call({
        pluginId: 'wide',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload: { n: id },
      }, 4_000).catch((err) => err);
      assert.equal(res.payload?.length, pad, JSON.stringify({
        id,
        code: res.code,
        keep: rec.admitKeep,
        floor: rec.admitFloor,
        window: rec.sendWindow,
        credit: rec.creditSent,
        bT: rec.bT,
      }));
      assertAccountingInvariants(pair.sup, rec);
    }
  } finally {
    await pair.close();
  }
});

test('a cancel acknowledgement is applied before a parked call is promoted', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 8, total: 1024 * 1024, totalGlobal: 4 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      pending: 8,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(granted, true, String(rec.creditSent));
    const written = [];
    const stdin = rec.child.stdin;
    const orig = stdin.write.bind(stdin);
    stdin.write = (chunk, enc, cb) => {
      written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (typeof enc === 'function') return orig(chunk, enc);
      return orig(chunk, enc, cb);
    };
    assert.equal(await stopChild(rec.child.pid), true);
    const call = (id, pad) => pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: id,
      port: 'db',
      method: 'get',
      payload: pad == null ? { n: id } : 'y'.repeat(pad),
    }, 4_000).catch((err) => err);
    const first = call(1);
    const armed = await waitUntil(() => pair.sup.pending.has('echo', 1, 'call') && rec.outbound === 0, 1_000);
    assert.equal(armed, true, JSON.stringify({ outbound: rec.outbound, pending: pair.sup.pending.size }));
    const victim = call(2, rec.kOut);
    const parked = await waitUntil(() => {
      const held = rec.parked.some((entry) => entry.msg.correlationId === 2);
      if (held) holdPark(rec);
      return held;
    }, 1_000);
    assert.equal(parked, true, JSON.stringify({
      parked: rec.parked.map((entry) => entry.msg.correlationId),
      window: rec.sendWindow,
      plugin: rec.framer.pendingBytes(),
    }));
    const cancel = pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 2,
    }, 4_000);
    const cancelQueued = await waitUntil(
      () => stdinMessages(written).some((msg) => msg.kind === 'cancel' && msg.correlationId === 2),
      1_000,
    );
    assert.equal(cancelQueued, true, stdinMessages(written).map((msg) => msg.kind).join(','));
    const chunk = Buffer.from(
      encodeNdjson({ kind: 'result', correlationId: 1, payload: { n: 1 } })
      + encodeNdjson({ kind: 'cancelled', correlationId: 2 }),
    );
    rec.child.stdout.emit('data', chunk);
    assert.equal(
      stdinMessages(written).some((msg) => msg.kind === 'call' && msg.correlationId === 2),
      false,
      stdinMessages(written).map((msg) => `${msg.kind}:${msg.correlationId}`).join(','),
    );
    assert.equal(rec.parked.some((entry) => entry.msg.correlationId === 2), false);
    const cancelDone = await cancel;
    const victimDone = await victim;
    assert.equal(cancelDone.kind, 'cancelled');
    assert.equal(victimDone.kind, 'cancelled');
    const firstDone = await first;
    assert.equal(firstDone.payload?.n, 1);
    const third = call(3);
    const thirdArmed = await waitUntil(() => pair.sup.pending.has('echo', 3, 'call'), 1_000);
    assert.equal(thirdArmed, true);
    const fourth = call(4, rec.kOut);
    const fourthParked = await waitUntil(() => {
      const held = rec.parked.some((entry) => entry.msg.correlationId === 4);
      if (held) holdPark(rec);
      return held;
    }, 1_000);
    assert.equal(fourthParked, true, String(rec.sendWindow));
    const cancelFour = pair.stub.cancel({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 4,
    }, 4_000);
    const cancelFourWritten = await waitUntil(
      () => stdinMessages(written).some((msg) => msg.kind === 'cancel' && msg.correlationId === 4),
      1_000,
    );
    assert.equal(cancelFourWritten, true);
    const ack = encodeNdjson({ kind: 'cancelled', correlationId: 4 });
    // The ack is admitted only while the window covers it. The assignment
    // is the test's budget, so the spent total stays equal to the grant.
    rec.sendWindow = Buffer.byteLength(ack);
    rec.creditSpent = rec.creditSent - rec.sendWindow;
    rec.child.stdout.emit('data', Buffer.from(ack));
    assert.equal(
      stdinMessages(written).some((msg) => msg.kind === 'call' && msg.correlationId === 4),
      false,
      stdinMessages(written).map((msg) => `${msg.kind}:${msg.correlationId}`).join(','),
    );
    assert.equal((await cancelFour).kind, 'cancelled');
    assert.equal((await fourth).kind, 'cancelled');
    third.catch(() => {});
    assertAccountingInvariants(pair.sup, rec);
    assertNoCallAfterItsCancel(written);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a parked long correlation id can still be cancelled', { timeout: 10_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pluginId = 'echo';
  const longId = 'c'.repeat(1100);
  const payload = { n: 1 };
  const idBytes = (correlationId) => Buffer.byteLength(JSON.stringify(pluginId))
    + Buffer.byteLength(JSON.stringify(correlationId));
  const callBytes = Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId: longId,
    port: 'db',
    method: 'get',
    payload,
  }));
  const numericBytes = Buffer.byteLength(encodeNdjson({
    kind: 'call',
    correlationId: 1,
    port: 'db',
    method: 'get',
    payload,
  }));
  const grant = stdinControlReserve().grant;
  const cancelFrame = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId: longId }));
  const wire = grant + Math.max(stdinControlReserve().cancel, cancelFrame);
  const base = numericBytes + idBytes(1);
  const withWire = base + callBytes + idBytes(longId) + wire;
  const withIds = withWire + idBytes(longId);
  assert.ok(idBytes(longId) > 1000);
  assert.ok(withIds > withWire + 1000);
  const tight = withWire + 200;
  const open = withIds + 200;
  assert.ok(tight < withIds);
  const spawnTotal = (userspace) => userspace + reserved.kIn + reserved.kOut + reserved.readBytes;
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 8, partial: 1024 * 1024, total: spawnTotal(open), totalGlobal: 4 * 1024 * 1024 },
  });
  const stop = () => {
    const proc = pair.sup.children.get(pluginId)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    const kid = pair.sup.spawn({
      pluginId,
      script: echoPath,
      pending: 4,
      total: spawnTotal(tight),
    });
    const rec = pair.sup.children.get(pluginId);
    const granted = await waitUntil(() => rec.grantSettled && rec.outbound === 0, 2_000);
    assert.equal(granted, true, String(rec.creditSent));
    assert.equal(rec.bT, tight);
    assert.equal(await stopChild(rec.child.pid), true);
    const numeric = pair.stub.call({
      pluginId,
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload,
    }, 4_000).catch((err) => err);
    const numericArmed = await waitUntil(() => pair.sup.pending.has(pluginId, 1, 'call'), 1_000);
    assert.equal(numericArmed, true);
    const charged = pair.sup.queueDepth(pluginId).pluginBytes;
    assert.ok(charged + callBytes + idBytes(longId) + wire <= rec.bT, `${charged} wire fits ${rec.bT}`);
    assert.ok(
      charged + callBytes + idBytes(longId) + wire + idBytes(longId) > rec.bT,
      `${charged} identifiers do not fit ${rec.bT}`,
    );
    const rejected = await pair.stub.call({
      pluginId,
      credential: kid.credential,
      correlationId: longId,
      port: 'db',
      method: 'get',
      payload,
    }, 1_000).catch((err) => err);
    assert.equal(rejected.code, 'total-cap');
    assert.equal(rec.parked.length, 0);
    assert.equal(pair.sup.pending.has(pluginId, longId, 'call'), false);
    numeric.catch(() => {});
    process.kill(rec.child.pid, 'SIGKILL');
    await pair.close();

    const openPair = await connectPair({
      sweeper: false,
      caps: { pending: 8, partial: 1024 * 1024, total: spawnTotal(open), totalGlobal: 4 * 1024 * 1024 },
    });
    try {
      const openKid = openPair.sup.spawn({
        pluginId,
        script: echoPath,
        pending: 4,
        total: spawnTotal(open),
      });
      const openRec = openPair.sup.children.get(pluginId);
      const openGrant = await waitUntil(() => openRec.grantSettled && openRec.outbound === 0, 2_000);
      assert.equal(openGrant, true, String(openRec.creditSent));
      // This half is the identifier budget. The window already granted would
      // occupy the bytes the long id has to fit in, so it is not part of
      // the figure under test. Refill stays armed so the window is not
      // advertised again before the cancel.
      openRec.creditSpent = openRec.creditSent;
      openRec.sendWindow = 0;
      openRec.refillArmed = true;
      if (openRec.creditFlush) clearTimeout(openRec.creditFlush);
      openRec.creditFlush = null;
      openRec.creditFlushDue = null;
      assert.equal(await stopChild(openRec.child.pid), true);
      const filler = openPair.stub.call({
        pluginId,
        credential: openKid.credential,
        correlationId: 1,
        port: 'db',
        method: 'get',
        payload,
      }, 4_000).catch((err) => err);
      const armed = await waitUntil(() => openPair.sup.pending.has(pluginId, 1, 'call'), 1_000);
      assert.equal(armed, true);
      const parkedCall = openPair.stub.call({
        pluginId,
        credential: openKid.credential,
        correlationId: longId,
        port: 'db',
        method: 'get',
        payload,
      }, 4_000).catch((err) => err);
      const parked = await waitUntil(() => {
        const held = openRec.parked.some((entry) => entry.msg.correlationId === longId);
        if (held) holdPark(openRec);
        return held || openPair.sup.pending.has(pluginId, longId, 'call');
      }, 1_000);
      assert.equal(parked, true, JSON.stringify({
        parked: openRec.parked.map((entry) => entry.msg.correlationId),
        pending: openPair.sup.pending.has(pluginId, longId, 'call'),
      }));
      const kept = openRec.admitKeep;
      const cancel = openPair.stub.cancel({
        pluginId,
        credential: openKid.credential,
        correlationId: longId,
      }, 4_000).catch((err) => err);
      const cancelPending = await waitUntil(
        () => openPair.sup.pending.has(pluginId, longId, 'cancel'),
        1_000,
      );
      assert.equal(cancelPending, true, 'cancel was not admitted');
      cancel.catch(() => {});
      assert.equal(
        openRec.stdinPayload.some((entry) => entry.correlationId === longId),
        false,
      );
      assert.ok(openRec.admitKeep <= openRec.bT, `${openRec.admitKeep} > ${openRec.bT}`);
      assert.ok(openRec.admitKeep >= kept);
      assertAccountingInvariants(openPair.sup, openRec);
      filler.catch(() => {});
      parkedCall.catch(() => {});
    } finally {
      const proc = openPair.sup.children.get(pluginId)?.child;
      if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
      if (!openPair.sup.closed) await openPair.close();
    }
  } finally {
    stop();
    if (!pair.sup.closed) await pair.close();
  }
});

test('a stdout read stays inside the cap while send credit is open', { timeout: 15_000 }, async () => {
  const totalGlobal = 100_000;
  const pad = 16_000;
  const lineBytes = Buffer.byteLength(encodeNdjson({
    kind: 'result',
    correlationId: 1,
    payload: 'p'.repeat(pad),
  }));
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('wide');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && rec.sendWindow >= lineBytes,
      2_000,
    );
    assert.equal(granted, true, String(rec.sendWindow));
    // The grant is in the kernel. Let the child read it before it is stopped,
    // so the later response is credit-compliant.
    await delay(100);
    assert.equal(await stopChild(rec.child.pid), true);
    let settled = null;
    const call = pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 8_000).then((res) => {
      settled = res;
      return res;
    }, (err) => {
      settled = err;
      return err;
    });
    const armed = await waitUntil(() => pair.sup.pending.has('wide', 1, 'call'), 1_000);
    assert.equal(armed, true, 'call was not admitted beside the open window');
    const globalCap = totalGlobal
      - (rec.kIn + rec.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const slack = 8_000;
    const occupy = globalCap - pair.sup.bufferedBytes() - slack;
    assert.ok(occupy > lineBytes, `${occupy} should exceed the ${lineBytes}-byte response`);
    pair.sup.queuedBytes += occupy;
    const occupied = pair.sup.bufferedBytes();
    assert.ok(occupied + lineBytes > globalCap, `${occupied} + ${lineBytes} vs ${globalCap}`);
    assert.ok(occupied <= globalCap, `${occupied} already over ${globalCap}`);
    const promised = Math.min(pair.sup.readBytes, rec.sendWindow);
    assert.ok(
      occupied + pair.sup.readBytes - promised <= globalCap,
      'the old read check would already refuse this slice',
    );
    process.kill(rec.child.pid, 'SIGCONT');
    let peak = occupied;
    const started = performance.now();
    while (performance.now() - started < 400) {
      peak = Math.max(peak, pair.sup.bufferedBytes());
      await delay(20);
    }
    assert.ok(peak <= globalCap, `buffered ${peak} exceeded ${globalCap}`);
    assert.equal(settled, null, 'the response completed while the mux occupancy was held');
    pair.sup.queuedBytes = Math.max(0, pair.sup.queuedBytes - occupy);
    // The occupancy stands in for a retained mux frame. Releasing it is the
    // drain completion that unpauses a global hold.
    rec.paused = false;
    rec.pauseReason = null;
    rec.readHeld = false;
    rec.readPosted = false;
    rec.stdoutSocket?.resume();
    const done = await call;
    assert.equal(done.payload?.length, pad);
  } finally {
    const proc = pair.sup.children.get('wide')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('calls beside a full send window are admitted for both children', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 64, total: 8 * 1024 * 1024 },
  });
  try {
    const kids = [0, 1].map((n) => pair.sup.spawn({ pluginId: `echo-${n}`, script: echoPath }));
    // One completed call spends the grant. Later calls then see the hole
    // the grant left, which is the steady state of a throughput run.
    for (const kid of kids) {
      const primed = await pair.stub.call({
        pluginId: kid.credential.pluginId,
        credential: kid.credential,
        correlationId: 1,
        port: 'db',
        method: 'get',
        payload: 'x'.repeat(1024),
      }, 3_000).catch((err) => err);
      assert.equal(primed.payload, 'x'.repeat(1024), primed.code);
    }
    const calls = [];
    for (let n = 0; n < 40; n++) {
      const kid = kids[n % 2];
      calls.push(pair.stub.call({
        pluginId: kid.credential.pluginId,
        credential: kid.credential,
        correlationId: n + 10,
        port: 'db',
        method: 'get',
        payload: 'x'.repeat(1024),
      }, 3_000).catch((err) => err));
    }
    const results = await Promise.all(calls);
    const codes = {};
    for (const row of results) {
      const code = row?.code || (row?.payload === 'x'.repeat(1024) ? 'ok' : 'other');
      codes[code] = (codes[code] || 0) + 1;
    }
    assert.equal(codes.ok, 40, JSON.stringify(codes));
    for (const id of ['echo-0', 'echo-1']) {
      assertAccountingInvariants(pair.sup, pair.sup.children.get(id));
    }
  } finally {
    for (const rec of pair.sup.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    }
    await pair.close();
  }
});

test('a rejection frame does not spend a sibling send window', async () => {
  const totalGlobal = 100_000;
  const pad = 16_000;
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'wide',
      script: responsePath,
      env: { RESPONSE_PAD: String(pad) },
      total: 1024 * 1024,
    });
    const other = pair.sup.spawn({ pluginId: 'echo', script: echoPath, total: 1024 * 1024 });
    const recA = pair.sup.children.get('wide');
    const recB = pair.sup.children.get('echo');
    const granted = await waitUntil(
      () => recA.grantSettled && recA.outbound === 0 && recA.sendWindow > 0,
      2_000,
    );
    assert.equal(granted, true, String(recA.sendWindow));
    const globalCap = totalGlobal
      - (recA.kIn + recA.kOut + pair.sup.readBytes)
      - (recB.kIn + recB.kOut + pair.sup.readBytes)
      - (pair.sup.kMuxIn + pair.sup.kMuxOut + pair.sup.readBytes);
    const lineBytes = Buffer.byteLength(encodeNdjson({
      kind: 'result',
      correlationId: 1,
      payload: 'p'.repeat(pad),
    }));
    assert.ok(recA.sendWindow >= lineBytes, `${recA.sendWindow} < ${lineBytes}`);
    // The echo child would answer before the duplicate calls are issued.
    // Stopped, the anchor stays pending and those duplicates are rejections.
    assert.equal(waitForRuntime(recB.child.pid), true);
    assert.equal(await stopChild(recB.child.pid), true);
    const anchor = pair.stub.call({
      pluginId: 'echo',
      credential: other.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 3_000).catch((err) => err);
    const armed = await waitUntil(
      () => pair.sup.pending.has('echo', 1, 'call') && recB.outbound === 0 && !recA.refillArmed && !recB.refillArmed,
      1_000,
    );
    assert.equal(armed, true);
    // The grant follow clamps the window back to the free room. Let that
    // follow finish, then reserve the whole userspace cap as send credit.
    await delay(30);
    const stamp = encodeMux({
      kind: 'result',
      for: 'call',
      pluginId: 'wide',
      correlationId: 0,
      payload: '',
      sendTs: 1e15,
      ingressTs: 1e15,
      egressTs: 1e15,
      version: kid.credential.version,
      generation: kid.credential.generation,
      grants: [...kid.credential.grants],
    }).length - Buffer.byteLength(encodeNdjson({
      kind: 'result',
      correlationId: 0,
      payload: '',
    }));
    const hole = 1209 * 8;
    recB.sendWindow = 0;
    recA.sendWindow = Math.max(0, globalCap - pair.sup.bufferedBytes() - stamp - hole);
    assert.ok(recA.sendWindow > lineBytes, `${recA.sendWindow} < ${lineBytes}`);
    const write = pair.sup.socket.write.bind(pair.sup.socket);
    pair.sup.socket.write = () => false;
    const before = pair.sup.queuedBytes + pair.sup.socketOutbound;
    const heldWindow = recA.sendWindow;
    // The kernel stub rejects a repeated id locally. These frames are the
    // supervisor's own duplicate path, which is what emits the rejection.
    const dup = encodeMux({
      kind: 'call',
      pluginId: 'echo',
      correlationId: 1,
      credential: other.credential,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
      timeoutMs: 1_000,
      sendTs: performance.now(),
    });
    for (let n = 0; n < 30; n++) pair.stub.socket.write(dup);
    const coalesced = await waitUntil(() => recB.rejectsCoalesced > 0, 1_000);
    const rejectionBytes = pair.sup.queuedBytes + pair.sup.socketOutbound - before;
    assert.equal(coalesced, true, JSON.stringify({
      coalesced: recB.rejectsCoalesced,
      buffered: pair.sup.bufferedBytes(),
      window: recA.sendWindow,
      heldWindow,
      globalCap,
      rejectionBytes,
      total: pair.sup.caps.total,
    }));
    assert.equal(recA.sendWindow, heldWindow);
    assert.ok(pair.sup.bufferedBytes() + recA.sendWindow <= globalCap, JSON.stringify({
      buffered: pair.sup.bufferedBytes(),
      window: recA.sendWindow,
      globalCap,
      fault: pair.sup.framingFault,
      paused: pair.sup.inputPaused,
      mux: pair.sup.bridge.pendingBytes(),
      outbound: pair.sup.socketOutbound,
      queued: pair.sup.queuedBytes,
    }));
    pair.sup.socket.write = write;
    pair.sup.socket.emit('drain');
    const response = await pair.stub.call({
      pluginId: 'wide',
      credential: kid.credential,
      correlationId: 7,
      port: 'db',
      method: 'get',
      payload: { n: 7 },
    }, 3_000).catch((err) => err);
    assert.equal(response.payload?.length, pad, JSON.stringify({
      code: response.code,
      pause: recA.pauseReason,
      buffered: pair.sup.bufferedBytes(),
      window: recA.sendWindow,
    }));
    anchor.catch(() => {});
  } finally {
    for (const rec of pair.sup.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
    }
    await pair.close();
  }
});

test('send credit is granted from accounted room while the mux is unread', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 4 * 1024 * 1024 },
  });
  try {
    // A posted read with bytes still queued used to re-arm forever and never grant.
    pair.sup.muxPending = () => 1;
    pair.sup.muxReadPosted = true;
    pair.sup.spawn({ pluginId: 'credit', script: creditPath });
    const rec = pair.sup.children.get('credit');
    const granted = await waitUntil(() => rec.creditSent > 0, 500);
    assert.equal(granted, true, String(rec.creditSent));
    assert.ok(rec.sendWindow < rec.bT, `${rec.sendWindow} filled ${rec.bT}`);
    const sent = rec.creditSent;
    await delay(80);
    assert.equal(rec.creditSent, sent);
  } finally {
    await pair.close();
  }
});

test('a cancelled environment write does not close a reused descriptor', async () => {
  const ends = openEnvPipe();
  assert.ok(ends);
  const buf = Buffer.alloc(8_192, 0x71);
  const owner = { writeFd: ends.writeFd, aborted: false, writing: false };
  const pending = writePluginEnv(ends.writeFd, buf, owner);
  const opened = [];
  let reused = -1;
  try {
    assert.equal(owner.writing, true);
    const fd = owner.writeFd;
    owner.aborted = true;
    owner.writeFd = -1;
    closeSync(fd);
    for (let i = 0; i < 128 && reused < 0; i++) {
      const n = openSync('/dev/null', 'r');
      if (n === fd) reused = n;
      else opened.push(n);
    }
    assert.equal(reused, fd);
    await pending;
    assert.doesNotThrow(() => fstatSync(reused), 'environment writer closed a reused descriptor');
  } finally {
    closeFd(reused);
    for (const n of opened) closeFd(n);
    closeFd(ends.readFd);
    closeFd(ends.probe);
    closeFd(ends.writeFd);
  }
});

test('an environment write yields while the pipe is still full', async () => {
  const ends = openEnvPipe();
  assert.ok(ends);
  const buf = Buffer.alloc(192 * 1024, 0x62);
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const writing = writePluginEnv(ends.writeFd, buf);
  const yielded = await Promise.race([
    delay(200).then(() => ticked),
    writing.then(() => ticked),
  ]);
  assert.equal(yielded, true);
  closeFd(ends.readFd);
  closeFd(ends.probe);
  await writing;
});

test('close leaves an in-flight environment write owning its descriptor', async () => {
  const env = { PAD: 'p'.repeat(100_000) };
  assert.ok(pluginEnvBlock(env, 'echo').length > 4096);
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 1024 * 1024 },
  });
  try {
    pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      env,
      total: 1024 * 1024,
    });
    const rec = pair.sup.children.get('echo');
    const fd = rec.envHold.writeFd;
    assert.equal(rec.envHold.writing, true);
    const closing = pair.close();
    assert.doesNotThrow(
      () => fstatSync(fd),
      'clearEnv closed the environment fd while the write was in flight',
    );
    await closing;
    assert.throws(() => fstatSync(fd), (err) => err.code === 'EBADF');
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    if (!pair.sup.closed) await pair.close();
  }
});

test('a spawn error settles while a large environment is still queued', async () => {
  const env = { A: 'a'.repeat(100_000), B: 'b'.repeat(100_000) };
  assert.ok(pluginEnvBlock(env, 'echo').length > 128 * 1024);
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 1024 * 1024 },
  });
  try {
    const started = Date.now();
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      env,
      total: 1024 * 1024,
    });
    assert.ok(Date.now() - started < 500, 'spawn blocked on the environment pipe');
    const rec = pair.sup.children.get('echo');
    rec.child.emit('error', Object.assign(new Error('eagain'), { code: 'EAGAIN' }));
    assert.equal(rec.exitFinished, true);
    const next = await Promise.race([
      pair.sup.respawn('echo'),
      delay(2_000).then(() => null),
    ]);
    assert.ok(next?.pid, 'respawn hung after a spawn error with a large environment');
    assert.notEqual(next.pid, kid.pid);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('close reaps a descendant that dies with the plugin group', async () => {
  const pair = await connectPair({ sweeper: false });
  let sleeper = null;
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    assert.equal(waitForRuntime(kid.pid), true);
    sleeper = spawnSleeper(kid.pid);
    assert.equal(typeof sleeper, 'number');
    const joined = await waitUntil(() => processGroup(sleeper) === kid.pid, 2_000);
    assert.equal(joined, true);
  } finally {
    const started = Date.now();
    await pair.close();
    assert.ok(Date.now() - started >= 150, 'close returned before the quiet reap');
    if (sleeper != null) {
      let reaped = false;
      try { process.kill(sleeper, 0); }
      catch (err) { reaped = err.code === 'ESRCH'; }
      if (!reaped) {
        try { process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
      }
      assert.equal(reaped, true);
    }
  }
});

test('an echo child does not turn a grant into more send credit', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 32, total: 1024 * 1024 },
  });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(
      () => rec.grantSettled && rec.outbound === 0 && !rec.creditFlush && pair.sup.bufferedBytes() < 64,
      2_000,
    );
    assert.equal(granted, true);
    await delay(60);
    const sent = rec.creditSent;
    const window = rec.sendWindow;
    await delay(150);
    assert.equal(rec.creditSent, sent);
    assert.equal(rec.sendWindow, window);
  } finally {
    await pair.close();
  }
});

test('overlapping calls on a wide budget are admitted beside send credit', async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 512, total: 8 * 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('echo');
    const granted = await waitUntil(() => rec.creditSent > 0 && rec.outbound === 0, 2_000);
    assert.equal(granted, true);
    const payload = 'x'.repeat(1024);
    const pending = [];
    for (let id = 1; id <= 8; id++) {
      pending.push(pair.stub.call({
        pluginId: 'echo',
        credential: kid.credential,
        correlationId: id,
        port: 'db',
        method: 'get',
        payload,
      }, 2_000).catch((err) => err));
    }
    const rows = await Promise.all(pending);
    const codes = rows.map((row) => (row?.code ? row.code : 'ok'));
    assert.deepEqual(codes, Array(8).fill('ok'), codes.join(','));
    assert.ok(rec.sendWindow < rec.bT, `${rec.sendWindow} filled ${rec.bT}`);
    assert.equal(pair.sup.flip, null);
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

test('plugin environment rejects one entry the kernel cannot exec', () => {
  const key = 'PAD';
  const overhead = Buffer.byteLength(`${key}=\0`);
  const valueBytes = PLUGIN_ENV_ENTRY_MAX - 1 - overhead;
  assert.ok(valueBytes > 0);
  const accepted = pluginEnvBlock({ PAD: 'x'.repeat(valueBytes) }, 'echo');
  assert.ok(accepted.length < PLUGIN_ENV_MAX);
  assert.throws(
    () => pluginEnvBlock({ PAD: 'x'.repeat(valueBytes + 1) }, 'echo'),
    (err) => err.code === 'env-rejected',
  );
});

test('plugin environment rejects a block the wrapper cannot finish reading', () => {
  const env = {};
  for (let guard = 0; guard < 8; guard++) {
    const len = pluginEnvBlock(env, 'echo').length;
    const room = PLUGIN_ENV_MAX - 1 - len;
    if (room === 0) break;
    const key = `P${Object.keys(env).length}`;
    const overhead = Buffer.byteLength(`${key}=\0`);
    const valueBytes = Math.min(PLUGIN_ENV_ENTRY_MAX - 1 - overhead, room - overhead);
    assert.ok(valueBytes > 0);
    env[key] = 'x'.repeat(valueBytes);
  }
  const accepted = pluginEnvBlock(env, 'echo');
  assert.equal(accepted.length, PLUGIN_ENV_MAX - 1);
  const last = Object.keys(env).at(-1);
  assert.throws(
    () => pluginEnvBlock({ ...env, [last]: env[last] + 'x' }, 'echo'),
    (err) => err.code === 'env-rejected',
  );
});

test('the largest accepted environment block starts the plugin', async () => {
  // One kernel string cannot reach the wrapper cap (MAX_ARG_STRLEN). Several
  // short variables fill the block to exactly one byte under that cap.
  const env = {};
  for (let guard = 0; guard < 16; guard++) {
    const len = pluginEnvBlock(env, 'echo').length;
    const room = PLUGIN_ENV_MAX - 1 - len;
    if (room === 0) break;
    const key = `P${Object.keys(env).length}`;
    const overhead = Buffer.byteLength(`${key}=\0`);
    if (room < overhead) {
      const last = Object.keys(env).at(-1);
      env[last] = env[last].slice(0, -(overhead - room));
      continue;
    }
    env[key] = 'x'.repeat(Math.min(100_000, room - overhead));
  }
  assert.equal(pluginEnvBlock(env, 'echo').length, PLUGIN_ENV_MAX - 1);
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 1024 * 1024 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'echo',
      script: echoPath,
      env,
      total: 1024 * 1024,
    });
    const res = await pair.stub.call({
      pluginId: 'echo',
      credential: kid.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 2_000);
    assert.equal(res.payload?.ok, true);
  } finally {
    const proc = pair.sup.children.get('echo')?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
    await pair.close();
  }
});

test('a spawn burst reserves each unread environment pipe inside totalGlobal', async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved);
  const pad = 'y'.repeat(32_000);
  const block = pluginEnvBlock({ PAD: pad }, 'wide');
  const slack = 8_192;
  const total = reserved.perChild + slack;
  const totalGlobal = reserved.muxReserve + 2 * reserved.perChild + block.length + slack;
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 1024 * 1024, total, totalGlobal },
  });
  const stop = (id) => {
    const proc = pair.sup.children.get(id)?.child;
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL');
  };
  try {
    pair.sup.spawn({
      pluginId: 'wide',
      script: echoPath,
      env: { PAD: pad },
      total,
    });
    const held = pair.sup.bufferedBytes();
    assert.ok(held >= block.length, String(held));
    assert.throws(
      () => pair.sup.spawn({
        pluginId: 'other',
        script: echoPath,
        env: { PAD: pad },
        total,
      }),
      (err) => err.code === 'spawn-rejected',
    );
    assert.equal(pair.sup.children.has('other'), false);
    const released = await waitUntil(() => pair.sup.bufferedBytes() < block.length, 2_000);
    assert.equal(released, true, String(pair.sup.bufferedBytes()));
    pair.sup.spawn({
      pluginId: 'other',
      script: echoPath,
      env: { PAD: pad },
      total,
    });
    assert.equal(pair.sup.children.has('other'), true);
  } finally {
    stop('wide');
    stop('other');
    await pair.close();
  }
});

test('respawn and close right after spawn do not wait for the group-kill fallback', async () => {
  const script = `
    import { performance } from 'node:perf_hooks';
    import { fileURLToPath } from 'node:url';
    import { connectPair } from './src/supervisor.mjs';
    const echoPath = fileURLToPath(new URL('./src/children/echo.mjs', import.meta.url));
    const real = process.kill.bind(process);
    let armed = false;
    let esrch = 0;
    process.kill = (pid, signal) => {
      if (armed && typeof pid === 'number' && pid < 0 && esrch < 1) {
        esrch += 1;
        const err = new Error('esrch');
        err.code = 'ESRCH';
        throw err;
      }
      return real(pid, signal);
    };
    const pair = await connectPair({ sweeper: false });
    try {
      const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
      armed = true;
      const t0 = performance.now();
      const next = await pair.sup.respawn('echo');
      const respawnMs = performance.now() - t0;
      if (!(respawnMs < 1500)) throw new Error('respawn ' + respawnMs);
      if (esrch !== 1) throw new Error('respawn esrch ' + esrch);
      if (next.pid === kid.pid) throw new Error('same pid');
      let dead = false;
      try { real(kid.pid, 0); } catch { dead = true; }
      if (!dead) throw new Error('leader still alive');
      pair.sup.spawn({ pluginId: 'other', script: echoPath });
      esrch = 0;
      const t1 = performance.now();
      await pair.close();
      const closeMs = performance.now() - t1;
      if (!(closeMs < 1500)) throw new Error('close ' + closeMs);
      if (esrch !== 1) throw new Error('close esrch ' + esrch);
      console.log('ok ' + Math.round(respawnMs) + ' ' + Math.round(closeMs));
    } finally {
      process.kill = real;
    }
  `;
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 15_000,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout });
    });
  });
  assert.match(stdout, /ok/);
});
