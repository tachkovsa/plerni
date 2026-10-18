// b3-backpressure.mjs — named caps trip under open-loop overload, and RSS growth
// stays ≤64 MiB across the measurement window (plan §4 B3).

import { fileURLToPath } from 'node:url';
import { connectPair, partialCapHolds } from '../supervisor.mjs';
import { CONTRACT, RSS_GROWTH_LIMIT, delay, measureSeries, openLoop, preflight, treeRss, waitUntil } from '../measure.mjs';

const floodPath = fileURLToPath(new URL('../children/flood.mjs', import.meta.url));
const echoPath = fileURLToPath(new URL('../children/echo.mjs', import.meta.url));
const forgerPath = fileURLToPath(new URL('../children/identity-forger.mjs', import.meta.url));

function until(fn, ms) {
  return waitUntil(fn, ms);
}

export async function tripCaps() {
  const detail = {};
  const pendingPair = await connectPair({ sweeper: false, caps: { pending: 4, partial: 1024 * 1024, total: 8 * 1024 * 1024 } });
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

  const partialCap = 32 * 1024;
  const partialPair = await connectPair({
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
    detail.partial = {
      tripped: tripped && partialPair.sup.caps.partial === true,
      pendingBytes: fault?.pendingBytes ?? null,
      code: fault?.code ?? null,
      bound: Boolean(fault) && fault.code === 'partial-cap' && partialCapHolds(fault.pendingBytes, partialCap),
    };
  } finally {
    await partialPair.close();
  }

  const totalPair = await connectPair({
    sweeper: false,
    caps: { pending: 64, partial: 1024 * 1024, total: 48 * 1024 },
    partialHighWater: 1024 * 1024,
  });
  try {
    totalPair.sup.spawn({ pluginId: 'total', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const tripped = await until(() => totalPair.sup.caps.total, 3_000);
    const buffered = totalPair.sup.bufferedBytes();
    // readableLength holds stdout already pulled when pause() takes effect.
    // That tail is counted, so the ceiling is the cap plus one pipe burst.
    detail.total = { tripped, buffered, bound: buffered <= 48 * 1024 + 192 * 1024 };
  } finally {
    await totalPair.close();
  }

  const kernelPair = await connectPair({
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
    && detail.total.tripped && detail.total.bound
    && detail.kernel.tripped && detail.kernel.bound
    && detail.kernelBytes.tripped && detail.kernelBytes.bound;
  return { pass, detail };
}

const PARTIAL_MARK = 32 * 1024;
const BYTE_CAP = 16 * 1024;
const PENDING_CAP = 8;
const LO_CAP = 32;
const OFFERED_RATE = 5;
const FILL_MS = 10_000;

async function holdRep({ warmupMs, windowMs, readRss }) {
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
      total: BYTE_CAP,
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
      const byteBytes = byteFault || pair.sup.queueDepth('bytes').pluginBytes >= BYTE_CAP;
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
        bytes: near((row) => row.bytesFault || (row.bytes >= BYTE_CAP && row.bytes <= BYTE_CAP + 192 * 1024)),
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
  const tripped = await tripCaps();
  if (opts.hold === false) return tripped;
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
  const pass = tripped.pass && holds.every(holdOk);
  return {
    pass,
    outcome: 'scored',
    detail: {
      env: series.env,
      limit: RSS_GROWTH_LIMIT,
      caps: tripped.detail,
      growth: holds.map((row) => row.growth),
      holds,
      frozen: { warmupMs, windowMs, reps: repsN },
    },
  };
}
