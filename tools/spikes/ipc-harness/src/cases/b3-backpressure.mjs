// b3-backpressure.mjs — named caps trip under open-loop overload, and RSS growth
// stays ≤64 MiB across the measurement window (plan §4 B3).

import { fileURLToPath } from 'node:url';
import { connectPair } from '../supervisor.mjs';
import { CONTRACT, RSS_GROWTH_LIMIT, delay, preflight, treeRss } from '../measure.mjs';

const floodPath = fileURLToPath(new URL('../children/flood.mjs', import.meta.url));

async function until(fn, ms) {
  const deadline = Date.now() + ms;
  while (!fn() && Date.now() < deadline) await delay(10);
  return fn();
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

async function holdRep({ warmupMs, windowMs }) {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 4, partial: 32 * 1024, total: 64 * 1024 },
  });
  try {
    const silent = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'partial' },
    });
    const warmupDeadline = performance.now() + warmupMs;
    let seq = 0;
    while (performance.now() < warmupDeadline) {
      seq++;
      pair.stub.call({
        pluginId: 'silent',
        credential: silent.credential,
        correlationId: seq,
        port: 'db',
        method: 'get',
        payload: { n: seq },
      }, 200).catch(() => {});
      await delay(20);
    }
    const rss0 = treeRss([silent.pid]);
    let maxRss = rss0;
    const windowDeadline = performance.now() + windowMs;
    let arrivals = 0;
    while (performance.now() < windowDeadline) {
      for (let i = 0; i < 50; i++) {
        seq++;
        arrivals++;
        pair.stub.call({
          pluginId: 'silent',
          credential: silent.credential,
          correlationId: seq,
          port: 'db',
          method: 'get',
          payload: { n: seq },
        }, 200).catch(() => {});
      }
      maxRss = Math.max(maxRss, treeRss([silent.pid]));
      await delay(200);
    }
    return {
      growth: maxRss - rss0,
      rss0,
      maxRss,
      arrivals,
      caps: { ...pair.sup.caps },
    };
  } finally {
    await pair.close();
  }
}

export async function b3(opts = {}) {
  const tripped = await tripCaps();
  if (opts.hold === false) return tripped;
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const repsN = opts.reps ?? CONTRACT.reps;
  let env = preflight();
  const measure = async () => {
    const out = [];
    for (let i = 0; i < repsN; i++) out.push(await holdRep({ warmupMs, windowMs }));
    return out;
  };
  let holds = await measure();
  if (!env.valid) {
    env = preflight();
    const rerun = await measure();
    if (!env.valid) {
      return { pass: null, outcome: 'invalid', detail: { env, caps: tripped, holds, rerun } };
    }
    holds = rerun;
  }
  const within = holds.every((row) => row.growth <= RSS_GROWTH_LIMIT);
  const pass = tripped.pass && within ? true : false;
  return {
    pass,
    outcome: 'scored',
    detail: {
      env,
      limit: RSS_GROWTH_LIMIT,
      caps: tripped.detail,
      growth: holds.map((row) => row.growth),
      holds,
      frozen: { warmupMs, windowMs, reps: repsN },
    },
  };
}
