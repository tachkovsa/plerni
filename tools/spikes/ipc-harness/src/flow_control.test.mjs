import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPair } from './supervisor.mjs';
import { assessFlow, classifyWriterOverrun, PROBE_INTERVAL_MS, OVERRUN_DEADLINE_MS } from './flow_budget.mjs';
import { measureFlowReserve } from './flow_socket.mjs';
import { b3, partialSnapshotInvalid, scoreUnenforced, tripCaps } from './cases/b3-backpressure.mjs';
import { b4 } from './cases/b4-bounds.mjs';
import { encodeMux, encodeNdjson } from './framing.mjs';
import { waitUntil } from './measure.mjs';

const enlargePath = fileURLToPath(new URL('./children/enlarge-stdout.mjs', import.meta.url));
const echoPath = fileURLToPath(new URL('./children/echo.mjs', import.meta.url));

function block(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) { /* hold the event loop across the crossing */ }
  return Date.now() - start;
}

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
  const mark = join(dir, 'mark');
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({
      pluginId: 'enlarge',
      script: enlargePath,
      env: { ENLARGE_GO: go, ENLARGE_MARK: mark, RESERVED_K: String(reserved.kIn) },
    });
    const rec = pair.sup.children.get('enlarge');
    // Pause before the event loop reads. The 20 ms probe is what has to see
    // the enlarged queue; a read callback would consume the crossing.
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.child.stdout.pause();
    writeFileSync(go, '1');
    const lag = block(50);
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'enlarge' && fault.code === 'buffer-enlarged'),
      1_000,
    );
    assert.equal(faulted, true, JSON.stringify(pair.sup.faults));
    const observed = Date.now();
    const text = readFileSync(mark, 'utf8').trim().split(/\s+/);
    assert.equal(classifyWriterOverrun(text[0]), 'enlarger');
    const marked = Number(text[1]);
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
  const userspace = callBytes + 64;
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
    flowPending: () => reserved.kIn + 1,
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
  // Unread is injected above K. The buffer size is the live getsockopt on
  // the writer dup, which the child has not raised, so the fault is
  // thread-writer rather than buffer-enlarged.
  const pair = await connectPair({
    sweeper: false,
    flowPending: () => reserved.kIn + 1,
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
