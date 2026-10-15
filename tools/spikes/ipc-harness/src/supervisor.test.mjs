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
import { assessEnvironment, delay, measureSeries, openLoop, preflight, treeRss, waitUntil } from './measure.mjs';
import { MuxFramer, NdjsonFramer, encodeMux, encodeNdjson } from './framing.mjs';
import { FencedError } from './authority.mjs';
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
  const pair = await connectPair({
    sweeper: false,
    caps: { total: 4_096, totalGlobal: 8_192, pending: 8 },
  });
  try {
    const kid = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      total: 4_096,
    });
    const big = 'y'.repeat(3_000);
    const settled = await Promise.all([0, 1, 2, 3].map((n) => pair.stub.cancel({
      pluginId: 'silent',
      credential: kid.credential,
      correlationId: `${big}-${n}`,
    }, 400).catch((err) => err)));
    assert.ok(settled.some((row) => row.code === 'total-cap'));
    assert.ok(pair.sup.bufferedBytes() <= 8_192);
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
    assert.ok(buffered <= cap + 16 * 1024, String(buffered));
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
    await delay(40);
    rec.child.emit('error', Object.assign(new Error('emfile'), { code: 'EMFILE' }));
    const settled = await callP;
    assert.equal(settled.code, 'EMFILE');
    assert.equal(rec.dead, true);
    assert.equal(pair.sup.retiredTokens.has(kid.token), true);
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
  const cap = 8 * 1024;
  const pair = await connectPair({
    sweeper: false,
    caps: { total: cap, totalGlobal: cap, partial: 1024 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    pair.sup.spawn({
      pluginId: 'partial',
      script: floodPath,
      env: { FLOOD_MODE: 'partial' },
      total: cap,
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
  const pair = await connectPair({ sweeper: false, caps: { lo: 4, hi: 8, partial: 1024 * 1024, total: 8 * 1024 * 1024 } });
  try {
    const kid = pair.sup.spawn({ pluginId: 'echo', script: echoPath, total: 8 * 1024 * 1024 });
    pair.stub.socket.pause();
    const payload = 'p'.repeat(60_000);
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
    assert.ok(lengths.every((len) => len === 60_000), JSON.stringify(lengths));
  } finally {
    pair.stub.socket.resume();
    await pair.close();
  }
});

test('faulting a child does not drive the outbound count negative', { timeout: 10_000 }, async () => {
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
    const writes = [];
    for (let i = 0; i < 40; i++) {
      writes.push(pair.stub.call({
        pluginId: 'silent',
        credential: kid.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { blob: 'x'.repeat(20_000) },
      }, 2_000).catch((err) => err));
    }
    const held = await waitUntil(() => rec.outbound > 100_000, 2_000);
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
    assert.equal(pair.sup.pending.has('echo\u00007'), true);
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

test('an unfinished mux frame counts toward the global ceiling', async () => {
  const pair = await connectPair({ sweeper: false, caps: { totalGlobal: 64 } });
  try {
    pair.sup.spawn({ pluginId: 'echo', script: echoPath });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(200, 0);
    pair.stub.socket.write(Buffer.concat([prefix, Buffer.alloc(80, 0x61)]));
    await delay(30);
    assert.ok(pair.sup.bufferedBytes() >= 84, String(pair.sup.bufferedBytes()));
    assert.equal(pair.sup.caps.total, true);
  } finally {
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
