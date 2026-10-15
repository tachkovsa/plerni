// supervisor.test.mjs — deterministic B4/B5/B6 checks. Performance windows stay in the spike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b4, childAlive } from './cases/b4-bounds.mjs';
import { b5 } from './cases/b5-crash.mjs';
import { b2 } from './cases/b2-fencing.mjs';
import { b3, tripCaps } from './cases/b3-backpressure.mjs';
import { fileURLToPath } from 'node:url';
import { b1 } from './cases/b1-throughput.mjs';
import { floodBound, forgedFlood, hostileBattery, starvation } from './cases/b6-mux-identity.mjs';
import { assessEnvironment, delay, measureSeries, openLoop, preflight, waitUntil } from './measure.mjs';
import { NdjsonFramer, encodeMux } from './framing.mjs';
import { connectPair, dbConfigured } from './supervisor.mjs';

const echoPath = fileURLToPath(new URL('./children/echo.mjs', import.meta.url));
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
  assert.equal(result.pass, true, JSON.stringify(result.detail));
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
      total: 12_345,
    });
    const next = await pair.sup.respawn('echo');
    const rec = pair.sup.children.get('echo');
    assert.equal(next.credential.generation, 2);
    assert.equal(rec.credential.version, '1.2.3');
    assert.deepEqual([...rec.credential.grants], ['db']);
    assert.equal(rec.limits.pending, 3);
    assert.equal(rec.limits.total, 12_345);
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

test('partial pause resumes after the buffer drops without another stdout event', { timeout: 10_000 }, async () => {
  const pair = await connectPair({
    sweeper: false,
    caps: { partial: 4_096, total: 8 * 1024 * 1024 },
    partialHighWater: 4_096,
  });
  try {
    pair.sup.spawn({ pluginId: 'partial', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const echo = pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const rec = pair.sup.children.get('partial');
    const paused = await waitUntil(() => rec.paused && rec.pauseReason === 'partial', 3_000);
    assert.equal(paused, true);
    rec.child.kill('SIGSTOP');
    rec.child.stdout.removeAllListeners('data');
    rec.stash = null;
    rec.framer = new NdjsonFramer();
    const res = await pair.stub.call({
      pluginId: 'echo',
      credential: echo.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { ok: true },
    }, 1_000);
    assert.equal(res.payload?.ok, true);
    assert.equal(rec.paused, false);
  } finally {
    const rec = pair.sup.children.get('partial');
    if (rec && rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
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
