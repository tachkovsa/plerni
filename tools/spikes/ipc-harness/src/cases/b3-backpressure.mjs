// b3-backpressure.mjs — named caps trip under open-loop overload, and RSS growth
// stays ≤64 MiB across the measurement window (plan §4 B3).

import { fileURLToPath } from 'node:url';
import { connectPair, partialCapHolds, totalCapHolds } from '../supervisor.mjs';
import { assessFlow } from '../flow_budget.mjs';
import { measureFlowReserve } from '../flow_socket.mjs';
import { CONTRACT, RSS_GROWTH_LIMIT, delay, measureSeries, openLoop, preflight, treeRss, waitUntil } from '../measure.mjs';

const floodPath = fileURLToPath(new URL('../children/flood.mjs', import.meta.url));
const echoPath = fileURLToPath(new URL('../children/echo.mjs', import.meta.url));
const forgerPath = fileURLToPath(new URL('../children/identity-forger.mjs', import.meta.url));

function until(fn, ms) {
  return waitUntil(fn, ms);
}

// Framer residual, the unprocessed rest of the read, and FIONREAD. A missing
// tail or unread count is not zero: the sum cannot be scored without them.
export function partialFrameHighWater(pendingBytes, inFlightTailBytes, stdoutUnread = 0) {
  if (!Number.isFinite(pendingBytes) || !Number.isFinite(inFlightTailBytes) || !Number.isFinite(stdoutUnread)) {
    return null;
  }
  if (inFlightTailBytes < 0 || stdoutUnread < 0) return null;
  return pendingBytes + inFlightTailBytes + stdoutUnread;
}

// A null probe is an invalid run. A measured count is scored, including a
// count that misses the cap. afterCleanup is refused even when it is 0.
export function scoreTotalProbe(row) {
  const stdoutUnread = row.stdoutUnread ?? row.pipeUnread;
  const stdinQueued = row.stdinQueued ?? 0;
  const kIn = row.kIn ?? row.pipeCapacity;
  const kOut = row.kOut ?? row.pipeCapacity;
  const measured = Number.isInteger(stdoutUnread)
    && stdoutUnread >= 0
    && Number.isInteger(kIn)
    && kIn > 0
    && row.accounted != null;
  const vacuity = totalCapHolds(row.afterCleanup, row.cap, { afterCleanup: true }) === false;
  if (!measured) return { outcome: 'invalid', bound: null, vacuity };
  return {
    outcome: 'scored',
    bound: totalCapHolds(row.accounted, row.cap, { stdoutUnread, stdinQueued, kIn, kOut }),
    vacuity,
  };
}

// A partial fault whose FIONREAD terms are missing cannot be scored. A missing
// fault is a cap result, not an invalid run.
export function partialSnapshotInvalid(enforceFlow, fault) {
  if (!enforceFlow || !fault) return false;
  return fault.stdoutUnread == null
    || fault.kIn == null
    || fault.pendingBytes == null
    || fault.inFlightTailBytes == null;
}

function probeOpts(pipeProbe) {
  if (typeof pipeProbe !== 'function') return {};
  return {
    pipeProbe,
    flowPending: (fd) => {
      const row = pipeProbe(fd);
      if (!row || !Number.isInteger(row.unread) || row.unread < 0) return null;
      return row.unread;
    },
  };
}

const TRIP_PARTIAL = 32 * 1024;
const TRIP_TOTAL = 48 * 1024;

export async function tripCaps(opts = {}) {
  const detail = {};
  const enforceFlow = opts.enforceFlow !== false;
  if (enforceFlow && opts.pipeProbe == null) {
    const measured = opts.reserve ?? measureFlowReserve();
    if (!measured) {
      return { pass: null, outcome: 'invalid', detail: { reason: 'reservation-unavailable' } };
    }
    const verdict = assessFlow({
      partialCap: TRIP_PARTIAL,
      totalCap: TRIP_TOTAL,
      totalGlobal: 1024 * 1024,
      sndbufIn: measured.sndbufIn,
      sndbufOut: measured.sndbufOut,
      readBytes: measured.readBytes,
      childCount: 1,
    });
    if (verdict.outcome !== 'ok') {
      return {
        pass: false,
        outcome: 'unsatisfiable',
        detail: {
          protocol: '3.0',
          cause: verdict.reason,
          flip: 'unsatisfiable budget on the shipping runtime',
          ...verdict,
        },
      };
    }
    detail.reserve = verdict;
  }
  const probe = { ...probeOpts(opts.pipeProbe), enforceFlow };
  if (typeof opts.flowPending === 'function') probe.flowPending = opts.flowPending;
  const pendingPair = await connectPair({ ...probe, sweeper: false, caps: { pending: 4, partial: 1024 * 1024, total: 8 * 1024 * 1024 } });
  try {
    const silent = pendingPair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
    });
    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(pendingPair.stub.call({
        pluginId: 'silent',
        credential: silent.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 300).catch((err) => err));
    }
    const settled = await Promise.all(results);
    const rejected = settled.filter((result) => result.code === 'pending-cap').length;
    const admitted = settled.length - rejected;
    detail.pending = { tripped: pendingPair.sup.caps.pending, admitted, rejected };
  } finally {
    await pendingPair.close();
  }

  const partialCap = TRIP_PARTIAL;
  const partialPair = await connectPair({
    ...probe,
    sweeper: false,
    caps: { pending: 32, partial: partialCap, total: 8 * 1024 * 1024 },
  });
  try {
    partialPair.sup.spawn({ pluginId: 'partial', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const tripped = await until(
      () => partialPair.sup.faults.some((fault) => fault.pluginId === 'partial'),
      5_000,
    );
    const fault = partialPair.sup.faults.find((row) => row.pluginId === 'partial');
    const pendingBytes = fault?.pendingBytes ?? null;
    const inFlightTailBytes = fault?.inFlightTailBytes ?? null;
    const stdoutUnread = fault?.stdoutUnread ?? null;
    const kIn = fault?.kIn ?? null;
    const highWater = stdoutUnread == null
      ? null
      : partialFrameHighWater(pendingBytes, inFlightTailBytes, stdoutUnread);
    const withinKernel = kIn != null && stdoutUnread != null && stdoutUnread <= kIn;
    detail.partial = {
      tripped: tripped && partialPair.sup.caps.partial === true,
      pendingBytes,
      inFlightTailBytes,
      stdoutUnread,
      kIn,
      highWater,
      code: fault?.code ?? null,
      // The historical 36864 + 32768 snapshot is not ≤ 32768. Dropping the
      // tail, or allowing one extra 4096, fails partialCapHolds.
      bound: Boolean(fault)
        && fault.code === 'partial-cap'
        && withinKernel
        && partialCapHolds(highWater, partialCap)
        && partialCapHolds(36864 + 32768, partialCap) === false,
    };
  } finally {
    await partialPair.close();
  }
  const partialFault = detail.partial.code == null ? null : {
    stdoutUnread: detail.partial.stdoutUnread,
    kIn: detail.partial.kIn,
    pendingBytes: detail.partial.pendingBytes,
    inFlightTailBytes: detail.partial.inFlightTailBytes,
  };
  if (partialSnapshotInvalid(enforceFlow, partialFault)) {
    return {
      pass: null,
      outcome: 'invalid',
      detail: { reason: 'partial-probe-unavailable', partial: detail.partial },
    };
  }

  const totalCap = TRIP_TOTAL;
  const totalPair = await connectPair({
    ...probe,
    sweeper: false,
    caps: { pending: 64, partial: 1024 * 1024, total: totalCap },
    partialHighWater: 1024 * 1024,
  });
  try {
    totalPair.sup.spawn({ pluginId: 'total', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const tripped = await until(
      () => totalPair.sup.faults.some((fault) => fault.pluginId === 'total' && fault.code === 'total-cap'),
      3_000,
    );
    const fault = totalPair.sup.faults.find((row) => row.pluginId === 'total' && row.code === 'total-cap');
    const buffered = fault?.bufferedBytes ?? null;
    const inFlightTailBytes = fault?.inFlightTailBytes ?? null;
    const pipeUnread = fault?.pipeUnread ?? null;
    const pipeCapacity = fault?.pipeCapacity ?? null;
    const accounted = fault?.accountedBytes ?? null;
    const afterCleanup = totalPair.sup.bufferedBytes();
    const scored = scoreTotalProbe({
      pipeUnread,
      pipeCapacity,
      stdoutUnread: fault?.stdoutUnread ?? pipeUnread,
      stdinQueued: fault?.stdinQueued ?? 0,
      kIn: fault?.kIn ?? pipeCapacity,
      kOut: fault?.kOut ?? pipeCapacity,
      accounted,
      cap: totalCap,
      afterCleanup,
    });
    detail.total = {
      tripped: tripped && totalPair.sup.caps.total === true,
      buffered,
      inFlightTailBytes,
      pipeUnread,
      pipeCapacity,
      accounted,
      afterCleanup,
      // High-water, including the chunk tail, plus the measured unread socket.
      // An unavailable probe leaves bound null; it is not a scored miss.
      bound: scored.bound,
      // The post-cleanup count is the old oracle. It must not satisfy the bound.
      vacuity: scored.vacuity,
    };
    if (scored.outcome === 'invalid') {
      return { pass: null, outcome: 'invalid', detail };
    }
  } finally {
    await totalPair.close();
  }

  const kernelPair = await connectPair({
    ...probe,
    sweeper: false,
    kernel: { pendingCap: 4, byteCap: 64 * 1024 },
  });
  try {
    const echo = kernelPair.sup.spawn({ pluginId: 'echo', script: echoPath });
    kernelPair.sup.socket.pause();
    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(kernelPair.stub.call({
        pluginId: 'echo',
        credential: echo.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 300).catch((err) => err));
    }
    const occupied = kernelPair.stub.calls.size + kernelPair.stub.cancels.size;
    const buffered = kernelPair.stub.bufferedBytes();
    const settled = await Promise.all(results);
    const rejected = settled.filter((result) => result.code === 'pending-cap' || result.code === 'total-cap').length;
    detail.kernel = {
      tripped: rejected > 0,
      occupied,
      buffered,
      bound: occupied <= kernelPair.stub.pendingCap && buffered <= kernelPair.stub.byteCap && occupied > 0,
    };
  } finally {
    kernelPair.sup.socket.resume();
    await kernelPair.close();
  }

  const bytePair = await connectPair({
    ...probe,
    sweeper: false,
    kernel: { pendingCap: 32, byteCap: 32 },
  });
  try {
    const echo = bytePair.sup.spawn({ pluginId: 'echo', script: echoPath });
    bytePair.sup.socket.pause();
    const rejected = await bytePair.stub.call({
      pluginId: 'echo',
      credential: echo.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { n: 1 },
    }, 300).catch((err) => err);
    detail.kernelBytes = {
      tripped: rejected.code === 'total-cap',
      buffered: bytePair.stub.bufferedBytes(),
      bound: bytePair.stub.bufferedBytes() <= bytePair.stub.byteCap && bytePair.stub.calls.size === 0,
    };
  } finally {
    bytePair.sup.socket.resume();
    await bytePair.close();
  }

  const pass = detail.pending.tripped && detail.pending.rejected > 0 && detail.pending.admitted === 4
    && detail.partial.tripped && detail.partial.bound
    && detail.total.tripped && detail.total.bound && detail.total.vacuity
    && detail.kernel.tripped && detail.kernel.bound
    && detail.kernelBytes.tripped && detail.kernelBytes.bound;
  return { pass, outcome: 'scored', detail };
}

const PARTIAL_MARK = 32 * 1024;
const PENDING_CAP = 8;
const LO_CAP = 32;
const OFFERED_RATE = 5;
const FILL_MS = 10_000;

// Unterminated output trips total-cap only while B_t < B_p. The byte child
// therefore sits just above the kernel reserve and strictly under the partial
// trip: total ∈ [K_in + K_out + C, PARTIAL_MARK + K_out).
function holdByteCap(reserved) {
  if (!reserved) return 16 * 1024;
  const floor = reserved.perChild;
  const exclusive = PARTIAL_MARK + reserved.kOut;
  if (!Number.isInteger(floor) || floor >= exclusive) return 16 * 1024;
  return Math.min(floor + reserved.readBytes, exclusive - 1);
}

async function holdRep({ warmupMs, windowMs, readRss }) {
  const byteCap = holdByteCap(measureFlowReserve());
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending: PENDING_CAP,
      pendingGlobal: 64,
      partial: PARTIAL_MARK,
      total: 1024 * 1024,
      totalGlobal: 4 * 1024 * 1024,
      hi: 8,
      lo: LO_CAP,
    },
    partialHighWater: PARTIAL_MARK,
  });
  const pids = [];
  try {
    const silent = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
      pending: PENDING_CAP,
    });
    const sibling = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    const partial = pair.sup.spawn({
      pluginId: 'partial',
      script: floodPath,
      env: { FLOOD_MODE: 'partial' },
      total: 1024 * 1024,
    });
    const bytes = pair.sup.spawn({
      pluginId: 'bytes',
      script: floodPath,
      env: { FLOOD_MODE: 'partial' },
      total: byteCap,
    });
    const frames = pair.sup.spawn({
      pluginId: 'frames',
      script: floodPath,
      total: 1024 * 1024,
    });
    pair.sup.spawn({
      pluginId: 'forger',
      script: forgerPath,
      env: { SIBLING_ID: 'sib', FORGE_FLOOD: '1' },
      total: 1024 * 1024,
    });
    pids.push(silent.pid, sibling.pid, partial.pid, bytes.pid, frames.pid);
    // Stop the kernel from reading so each mux queue sits at its cap.
    pair.stub.socket.pause();
    for (let i = 0; i < PENDING_CAP; i++) {
      pair.stub.call({
        pluginId: 'silent',
        credential: silent.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 120_000).catch(() => {});
    }
    const siblingCall = pair.stub.call({
      pluginId: 'sib',
      credential: sibling.credential,
      correlationId: 1,
      port: 'db',
      method: 'get',
      payload: { who: 'sib' },
    }, 120_000).catch((err) => err);
    const filled = await until(() => {
      const pending = pair.sup.queueDepth('silent').pending >= PENDING_CAP;
      const partialBytes = pair.sup.faults.some((fault) => fault.pluginId === 'partial' && fault.code === 'partial-cap');
      const byteFault = pair.sup.faults.some((fault) => fault.pluginId === 'bytes' && fault.code === 'total-cap');
      const byteBytes = byteFault || pair.sup.queueDepth('bytes').pluginBytes >= byteCap;
      const lo = pair.sup.queueDepth('frames').lo >= LO_CAP;
      const hi = pair.sup.faults.some((fault) => fault.pluginId === 'forger' && fault.code === 'hi-cap');
      return pending && partialBytes && byteBytes && lo && hi;
    }, FILL_MS);
    for (const spawned of [partial, bytes]) {
      const rec = pair.sup.children.get(spawned.credential.pluginId);
      if (!rec?.dead) continue;
      const idx = pids.indexOf(spawned.pid);
      if (idx >= 0) pids.splice(idx, 1);
    }
    const warmStart = performance.now();
    if (filled) await delay(warmupMs);
    const warmedMs = performance.now() - warmStart;
    const rss0 = readRss(pids);
    if (rss0 == null) {
      return {
        growth: null,
        measurable: false,
        rss0: null,
        maxRss: null,
        arrivals: 0,
        filled,
        warmedMs,
        offered: 0,
        issued: 0,
        skipped: 0,
        answered: false,
        caps: { ...pair.sup.caps },
        near: { pending: false, partial: false, bytes: false, lo: false },
        samples: 0,
      };
    }
    let maxRss = rss0;
    const samples = [];
    let arrivals = 0;
    let rssLost = false;
    const loop = await openLoop({
      ms: windowMs,
      rate: OFFERED_RATE,
      tick: () => {
        if (rssLost) return;
        arrivals++;
        pair.stub.call({
          pluginId: 'sib',
          credential: sibling.credential,
          correlationId: 1000 + arrivals,
          port: 'db',
          method: 'get',
          payload: { n: arrivals },
        }, 120_000).catch(() => {});
        samples.push({
          pending: pair.sup.queueDepth('silent').pending,
          partial: pair.sup.queueDepth('partial').partial,
          partialFault: pair.sup.faults.some((fault) => fault.pluginId === 'partial' && fault.code === 'partial-cap'),
          bytes: pair.sup.queueDepth('bytes').pluginBytes,
          bytesFault: pair.sup.faults.some((fault) => fault.pluginId === 'bytes' && fault.code === 'total-cap'),
          lo: pair.sup.queueDepth('frames').lo,
          hi: pair.sup.faults.some((fault) => fault.code === 'hi-cap'),
          outbound: pair.sup.queueDepth('sib').outbound,
        });
        const sampleRss = readRss(pids);
        if (sampleRss == null) {
          rssLost = true;
          return;
        }
        maxRss = Math.max(maxRss, sampleRss);
      },
    });
    if (rssLost) {
      return {
        growth: null,
        measurable: false,
        rss0,
        maxRss: null,
        arrivals,
        filled,
        warmedMs,
        offered: loop.offered,
        issued: loop.issued,
        skipped: loop.skipped,
        answered: false,
        caps: { ...pair.sup.caps },
        near: { pending: false, partial: false, bytes: false, lo: false },
        samples: samples.length,
      };
    }
    pair.stub.socket.resume();
    const answered = await Promise.race([
      siblingCall,
      delay(2_000).then(() => null),
    ]);
    const near = (pred) => samples.length > 0 && samples.filter(pred).length / samples.length >= 0.8;
    return {
      growth: maxRss - rss0,
      rss0,
      maxRss,
      arrivals,
      filled,
      warmedMs,
      offered: loop.offered,
      issued: loop.issued,
      skipped: loop.skipped,
      answered: answered?.payload?.who === 'sib',
      caps: { ...pair.sup.caps },
      near: {
        pending: near((row) => row.pending >= PENDING_CAP),
        partial: near((row) => row.partialFault && row.partial === 0),
        bytes: near((row) => row.bytesFault || (row.bytes >= byteCap && row.bytes <= byteCap + 192 * 1024)),
        lo: near((row) => row.lo >= LO_CAP),
      },
      samples: samples.length,
    };
  } finally {
    pair.stub.socket.resume();
    await pair.close();
  }
}

function holdOk(row) {
  return row.growth <= RSS_GROWTH_LIMIT
    && row.filled
    && row.answered
    && row.caps.pending && row.caps.partial && row.caps.total && row.caps.lo && row.caps.hi
    && row.near.pending && row.near.partial && row.near.bytes && row.near.lo;
}

export async function b3(opts = {}) {
  const readRss = opts.readRss ?? treeRss;
  if (readRss([process.pid]) == null) {
    return { pass: null, outcome: 'invalid', detail: { reason: 'rss-unreadable', limit: RSS_GROWTH_LIMIT } };
  }
  // Same host, same trip caps. Enforcement off must score FAIL. It is not
  // invalid and not unsatisfiable. The enforced run is the pass candidate.
  let vacuity = null;
  if (opts.pipeProbe == null && opts.enforceFlow !== false) {
    vacuity = await tripCaps({ enforceFlow: false });
    if (vacuity.outcome === 'invalid') {
      return { pass: null, outcome: 'invalid', detail: { reason: 'unenforced-unscored', vacuity: vacuity.detail } };
    }
    if (vacuity.outcome === 'unsatisfiable' || vacuity.pass !== false) {
      return { pass: false, outcome: 'scored', detail: { reason: 'vacuity-pair', vacuity } };
    }
  }
  const tripped = await tripCaps({ pipeProbe: opts.pipeProbe, enforceFlow: opts.enforceFlow });
  if (tripped.outcome === 'invalid') {
    return { pass: null, outcome: 'invalid', detail: { reason: 'pipe-probe-unavailable', caps: tripped.detail, vacuity } };
  }
  if (tripped.outcome === 'unsatisfiable') return { ...tripped, detail: { ...tripped.detail, vacuity } };
  if (opts.hold === false) {
    return vacuity ? { ...tripped, detail: { ...tripped.detail, vacuityPass: vacuity.pass } } : tripped;
  }
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const repsN = opts.reps ?? CONTRACT.reps;
  const preflightFn = opts.preflight ?? preflight;
  const series = await measureSeries({
    reps: repsN,
    preflightFn,
    runRep: () => holdRep({ warmupMs, windowMs, readRss }),
  });
  if (series.outcome === 'invalid') {
    return { pass: null, outcome: 'invalid', detail: { env: series.env, caps: tripped, holds: series.rows, rerun: series.rerun } };
  }
  const holds = series.rows;
  if (holds.some((row) => row.measurable === false || row.growth == null)) {
    return { pass: null, outcome: 'invalid', detail: { env: series.env, reason: 'rss-unreadable', caps: tripped, holds, limit: RSS_GROWTH_LIMIT } };
  }
  const pass = tripped.pass && holds.every(holdOk) && (vacuity == null || vacuity.pass === false);
  return {
    pass,
    outcome: 'scored',
    detail: {
      env: series.env,
      limit: RSS_GROWTH_LIMIT,
      caps: tripped.detail,
      vacuityPass: vacuity ? vacuity.pass : null,
      growth: holds.map((row) => row.growth),
      holds,
      frozen: { warmupMs, windowMs, reps: repsN },
    },
  };
}
