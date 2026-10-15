// b3-backpressure.mjs — named caps trip under open-loop overload, and RSS growth
// stays ≤64 MiB across the measurement window (plan §4 B3).

import { fileURLToPath } from 'node:url';
import { connectPair } from '../supervisor.mjs';
import { CONTRACT, RSS_GROWTH_LIMIT, delay, measureSeries, preflight, treeRss, waitUntil } from '../measure.mjs';

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

  const partialPair = await connectPair({
    sweeper: false,
    caps: { pending: 32, partial: 32 * 1024, total: 8 * 1024 * 1024 },
  });
  try {
    partialPair.sup.spawn({ pluginId: 'partial', script: floodPath, env: { FLOOD_MODE: 'partial' } });
    const tripped = await until(() => partialPair.sup.caps.partial, 3_000);
    const pendingBytes = partialPair.sup.children.get('partial').framer.pendingBytes();
    detail.partial = { tripped, pendingBytes, bound: pendingBytes <= 32 * 1024 + 3 * 4096 };
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
    detail.total = { tripped, buffered, bound: buffered <= 48 * 1024 + 3 * 4096 };
  } finally {
    await totalPair.close();
  }

  const pass = detail.pending.tripped && detail.pending.rejected > 0 && detail.pending.admitted === 4
    && detail.partial.tripped && detail.partial.bound
    && detail.total.tripped && detail.total.bound;
  return { pass, detail };
}

const PARTIAL_MARK = 32 * 1024;
const BYTE_CAP = 16 * 1024;
const PENDING_CAP = 8;
const LO_CAP = 32;

async function holdRep({ warmupMs, windowMs }) {
  const pair = await connectPair({
    sweeper: false,
    caps: {
      pending: PENDING_CAP,
      pendingGlobal: 64,
      partial: PARTIAL_MARK,
      total: 1024 * 1024,
      totalGlobal: 1024 * 1024,
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
      const partialBytes = pair.sup.queueDepth('partial').partial >= PARTIAL_MARK;
      const byteBytes = pair.sup.queueDepth('bytes').pluginBytes >= BYTE_CAP;
      const lo = pair.sup.queueDepth('frames').lo >= LO_CAP;
      const hi = pair.sup.faults.some((fault) => fault.pluginId === 'forger' && fault.code === 'hi-cap');
      return pending && partialBytes && byteBytes && lo && hi;
    }, Math.max(warmupMs, 5_000));
    const rss0 = treeRss(pids);
    let maxRss = rss0;
    const samples = [];
    const windowDeadline = performance.now() + windowMs;
    let arrivals = 0;
    while (performance.now() < windowDeadline) {
      arrivals++;
      pair.stub.call({
        pluginId: 'sib',
        credential: sibling.credential,
        correlationId: 1000 + arrivals,
        port: 'db',
        method: 'get',
        payload: { n: arrivals },
      }, 120_000).catch(() => {});
      const depth = {
        pending: pair.sup.queueDepth('silent').pending,
        partial: pair.sup.queueDepth('partial').partial,
        bytes: pair.sup.queueDepth('bytes').pluginBytes,
        lo: pair.sup.queueDepth('frames').lo,
        hi: pair.sup.faults.some((fault) => fault.code === 'hi-cap'),
        outbound: pair.sup.queueDepth('sib').outbound,
      };
      samples.push(depth);
      maxRss = Math.max(maxRss, treeRss(pids));
      await delay(200);
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
      answered: answered?.payload?.who === 'sib',
      caps: { ...pair.sup.caps },
      near: {
        pending: near((row) => row.pending >= PENDING_CAP),
        partial: near((row) => row.partial >= PARTIAL_MARK),
        bytes: near((row) => row.bytes >= BYTE_CAP && row.bytes <= BYTE_CAP + 3 * 4096),
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
  const tripped = await tripCaps();
  if (opts.hold === false) return tripped;
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const repsN = opts.reps ?? CONTRACT.reps;
  const preflightFn = opts.preflight ?? preflight;
  const series = await measureSeries({
    reps: repsN,
    preflightFn,
    runRep: () => holdRep({ warmupMs, windowMs }),
  });
  if (series.outcome === 'invalid') {
    return { pass: null, outcome: 'invalid', detail: { env: series.env, caps: tripped, holds: series.rows, rerun: series.rerun } };
  }
  const holds = series.rows;
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
