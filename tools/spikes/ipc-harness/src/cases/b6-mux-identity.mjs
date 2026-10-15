// b6-mux-identity.mjs — shared mux, supervisor-stamped identity, hostile battery,
// and the flood bound (plan §4 B6). stampIdentity:false is the vacuity variant.

import { fileURLToPath } from 'node:url';
import { connectPair } from '../supervisor.mjs';
import { CONTRACT, delay, measureSeries, openLoop, percentile, preflight, waitUntil } from '../measure.mjs';

function child(name) {
  return fileURLToPath(new URL(`../children/${name}.mjs`, import.meta.url));
}

const echoPath = child('echo');
const forgerPath = child('identity-forger');
const ignorePath = child('ignore-cancel');
const floodPath = child('flood');

const CANCEL_RATE = 20;
const CANCEL_BOUND_MS = 500;
const CANCEL_TIMEOUT = 1_000;
const MIN_FLOOD_RATE = 10_000;

async function call(stub, credential, correlationId, payload, timeoutMs = 1_500) {
  return stub.call({
    pluginId: credential.pluginId,
    credential,
    correlationId,
    port: 'db',
    method: 'get',
    payload,
  }, timeoutMs).catch((err) => err);
}

export async function hostileBattery({ stampIdentity = true } = {}) {
  const pair = await connectPair({ sweeper: false, stampIdentity });
  const checks = {};
  try {
    const a = pair.sup.spawn({ pluginId: 'a', script: echoPath });
    const b = pair.sup.spawn({ pluginId: 'b', script: echoPath });
    const [ra, rb] = await Promise.all([
      call(pair.stub, a.credential, 1, { who: 'a' }),
      call(pair.stub, b.credential, 1, { who: 'b' }),
    ]);
    checks.routing = ra.payload?.who === 'a' && rb.payload?.who === 'b'
      && ra.pluginId === 'a' && rb.pluginId === 'b';

    const forger = pair.sup.spawn({
      pluginId: 'forger',
      script: forgerPath,
      env: { SIBLING_ID: 'b' },
    });
    const forged = await call(pair.stub, forger.credential, 2, { who: 'x' });
    checks.forged = forged.code === 'forged-plugin-id';

    const mismatch = await call(pair.stub, { ...a.credential, secret: 'not-the-secret' }, 3, { who: 'a' });
    checks.mismatch = mismatch.code === 'credential-mismatch';

    const holder = pair.sup.spawn({ pluginId: 'holder', script: ignorePath });
    const holderP = call(pair.stub, holder.credential, 42, { from: 'holder' }, 1_500);
    const collide = pair.sup.spawn({
      pluginId: 'collide',
      script: forgerPath,
      env: { SIBLING_ID: 'holder' },
    });
    const collideRes = await call(pair.stub, collide.credential, 42, { from: 'x' }, 1_500);
    const holderRes = await holderP;
    checks.collision = holderRes.payload?.from === 'holder' && collideRes.code === 'forged-plugin-id';
    const exploit = holderRes.payload?.from === 'forger';

    const previous = a.credential;
    const respawned = await pair.sup.respawn('a');
    const stale = await call(pair.stub, previous, 4, { who: 'a' });
    const fresh = await call(pair.stub, respawned.credential, 5, { who: 'a' });
    checks.stale = stale.code === 'stale-credential' && fresh.payload?.who === 'a' && fresh.pluginId === 'a';

    const pass = Object.values(checks).every(Boolean);
    return { pass, checks, exploit, stampIdentity };
  } finally {
    await pair.close();
  }
}

async function floodRep({ warmupMs, windowMs }) {
  const pair = await connectPair({ sweeper: false });
  const samples = [];
  let timeouts = 0;
  let offered = 0;
  let issued = 0;
  try {
    pair.sup.spawn({ pluginId: 'flood', script: floodPath });
    const sibling = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    const started = performance.now();
    let seq = 0;
    const noteDrop = () => samples.push(CANCEL_TIMEOUT);
    await openLoop({
      ms: warmupMs + windowMs,
      rate: CANCEL_RATE,
      onSkip: (missed) => {
        if (performance.now() - started < warmupMs) return;
        offered += missed;
        for (let i = 0; i < missed; i++) noteDrop();
      },
      tick: () => {
        const record = performance.now() - started >= warmupMs;
        if (record) {
          offered++;
          issued++;
        }
        const correlationId = ++seq;
        pair.stub.cancel({
          pluginId: 'sib',
          credential: sibling.credential,
          correlationId,
        }, CANCEL_TIMEOUT).then((res) => {
          if (record && res.rttMs != null) samples.push(res.rttMs);
        }, () => {
          if (record) timeouts++;
        });
      },
    });
    await delay(1_100);
    const seconds = windowMs / 1000;
    return {
      p99: percentile(samples, 99),
      samples: samples.length,
      timeouts,
      offered,
      issued,
      bulk: pair.sup.bulkSeen,
      floodFrames: pair.stub.floodFrames,
      bulkRate: pair.sup.bulkSeen / seconds,
      floodRate: pair.stub.floodFrames / seconds,
    };
  } finally {
    await pair.close();
  }
}

export async function floodBound(opts = {}) {
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const reps = opts.reps ?? CONTRACT.reps;
  const preflightFn = opts.preflight ?? preflight;
  const series = await measureSeries({
    reps,
    preflightFn,
    runRep: () => floodRep({ warmupMs, windowMs }),
  });
  if (series.outcome === 'invalid') {
    return { pass: null, outcome: 'invalid', detail: { env: series.env, results: series.rows, rerun: series.rerun, boundMs: CANCEL_BOUND_MS } };
  }
  const results = series.rows;
  const pass = results.every((rep) => rep.p99 != null && rep.p99 <= CANCEL_BOUND_MS && rep.timeouts === 0 && rep.samples > 0
    && rep.bulkRate >= MIN_FLOOD_RATE && rep.floodRate >= MIN_FLOOD_RATE);
  return {
    pass,
    outcome: 'scored',
    detail: {
      env: series.env,
      boundMs: CANCEL_BOUND_MS,
      minFloodRate: MIN_FLOOD_RATE,
      p99s: results.map((rep) => rep.p99),
      bulkRate: results.map((rep) => rep.bulkRate),
      floodRate: results.map((rep) => rep.floodRate),
      reps: results,
      frozen: { children: 2, cancelRate: CANCEL_RATE, warmupMs, windowMs, reps },
      endpoints: 'kernel send → supervisor ingress → sibling egress → kernel return',
    },
  };
}

export async function starvation() {
  const pair = await connectPair({
    sweeper: false,
    caps: { pending: 2, pendingGlobal: 32 },
  });
  try {
    const silent = pair.sup.spawn({
      pluginId: 'silent',
      script: floodPath,
      env: { FLOOD_MODE: 'silent' },
    });
    const sib = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    const held = [];
    for (let i = 0; i < 4; i++) {
      held.push(pair.stub.call({
        pluginId: 'silent',
        credential: silent.credential,
        correlationId: i + 1,
        port: 'db',
        method: 'get',
        payload: { i },
      }, 400).catch((err) => err));
    }
    const first = await call(pair.stub, sib.credential, 10, { who: 'sib' });
    const settled = await Promise.all(held);
    await delay(50);
    const reclaimed = await pair.stub.call({
      pluginId: 'silent',
      credential: silent.credential,
      correlationId: 99,
      port: 'db',
      method: 'get',
      payload: { i: 99 },
    }, 300).catch((err) => err);
    const second = await call(pair.stub, sib.credential, 11, { who: 'sib' });
    const rejected = settled.filter((row) => row.code === 'pending-cap').length;
    const detail = {
      rejected,
      first: first.payload?.who ?? first.code ?? null,
      second: second.payload?.who ?? second.code ?? null,
      reclaimed: reclaimed.code ?? null,
    };
    const pass = rejected >= 1
      && detail.first === 'sib'
      && detail.second === 'sib'
      && detail.reclaimed === 'timeout';
    return { pass, detail };
  } finally {
    await pair.close();
  }
}

export async function forgedFlood() {
  const hiCap = 8;
  const pair = await connectPair({ sweeper: false, caps: { hi: hiCap } });
  try {
    pair.stub.socket.pause();
    const sib = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    pair.sup.spawn({
      pluginId: 'forger',
      script: forgerPath,
      env: { SIBLING_ID: 'sib', FORGE_FLOOD: '1' },
    });
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'forger' && fault.code === 'hi-cap'),
      3_000,
    );
    const depth = pair.sup.queueDepth('forger').hi;
    pair.stub.socket.resume();
    const res = await call(pair.stub, sib.credential, 1, { who: 'sib' }, 2_000);
    const detail = {
      faulted,
      depth,
      hiCap,
      who: res.payload?.who ?? res.code ?? null,
    };
    return { pass: faulted && depth <= hiCap && detail.who === 'sib', detail };
  } finally {
    pair.stub.socket.resume();
    await pair.close();
  }
}

export async function b6(opts = {}) {
  const stampIdentity = opts.stampIdentity !== false;
  const hostile = await hostileBattery({ stampIdentity });
  if (!stampIdentity) {
    return {
      pass: hostile.pass,
      exploit: hostile.exploit,
      checks: hostile.checks,
      detail: { mode: 'vacuity', hostile },
    };
  }
  if (opts.flood === false) return { pass: hostile.pass, exploit: hostile.exploit, checks: hostile.checks, detail: { hostile } };
  const starved = await starvation();
  const forged = await forgedFlood();
  const flood = await floodBound(opts);
  let pass = hostile.pass && starved.pass && forged.pass && flood.pass === true;
  if (flood.outcome === 'invalid') pass = null;
  if (!hostile.pass || !starved.pass || !forged.pass) pass = false;
  return { pass, outcome: flood.outcome, detail: { hostile, starved, forged, flood } };
}
