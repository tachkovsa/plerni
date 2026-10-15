// b6-mux-identity.mjs — shared mux, supervisor-stamped identity, hostile battery,
// and the flood bound (plan §4 B6). stampIdentity:false is the vacuity variant.

import { fileURLToPath } from 'node:url';
import { connectPair } from '../supervisor.mjs';
import { CONTRACT, delay, openLoop, percentile, preflight } from '../measure.mjs';

function child(name) {
  return fileURLToPath(new URL(`../children/${name}.mjs`, import.meta.url));
}

const echoPath = child('echo');
const forgerPath = child('identity-forger');
const ignorePath = child('ignore-cancel');
const floodPath = child('flood');

const CANCEL_RATE = 20;
const CANCEL_BOUND_MS = 500;

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

    const previous = a.credential;
    const respawned = await pair.sup.respawn('a');
    const stale = await call(pair.stub, previous, 4, { who: 'a' });
    const fresh = await call(pair.stub, respawned.credential, 5, { who: 'a' });
    checks.stale = stale.code === 'stale-credential' && fresh.payload?.who === 'a' && fresh.pluginId === 'a';

    const pass = Object.values(checks).every(Boolean);
    return { pass, checks, stampIdentity };
  } finally {
    await pair.close();
  }
}

async function floodRep({ warmupMs, windowMs }) {
  const pair = await connectPair({ sweeper: false });
  const samples = [];
  let timeouts = 0;
  try {
    pair.sup.spawn({ pluginId: 'flood', script: floodPath });
    const sibling = pair.sup.spawn({ pluginId: 'sib', script: echoPath });
    const started = performance.now();
    let seq = 0;
    await openLoop({
      ms: warmupMs + windowMs,
      rate: CANCEL_RATE,
      tick: () => {
        const record = performance.now() - started >= warmupMs;
        const correlationId = ++seq;
        pair.stub.cancel({
          pluginId: 'sib',
          credential: sibling.credential,
          correlationId,
        }, 1_000).then((res) => {
          if (record && res.rttMs != null) samples.push(res.rttMs);
        }, () => {
          if (record) timeouts++;
        });
      },
    });
    await delay(1_100);
    return {
      p99: percentile(samples, 99),
      samples: samples.length,
      timeouts,
      bulk: pair.sup.bulkSeen,
    };
  } finally {
    await pair.close();
  }
}

export async function floodBound(opts = {}) {
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const reps = opts.reps ?? CONTRACT.reps;
  let env = preflight();
  const measure = async () => {
    const out = [];
    for (let i = 0; i < reps; i++) out.push(await floodRep({ warmupMs, windowMs }));
    return out;
  };
  let results = await measure();
  if (!env.valid) {
    env = preflight();
    const rerun = await measure();
    if (!env.valid) {
      return { pass: null, outcome: 'invalid', detail: { env, results, rerun, boundMs: CANCEL_BOUND_MS } };
    }
    results = rerun;
  }
  const pass = results.every((rep) => rep.p99 != null && rep.p99 <= CANCEL_BOUND_MS && rep.timeouts === 0 && rep.samples > 0);
  return {
    pass,
    outcome: 'scored',
    detail: {
      env,
      boundMs: CANCEL_BOUND_MS,
      p99s: results.map((rep) => rep.p99),
      reps: results,
      frozen: { children: 2, cancelRate: CANCEL_RATE, warmupMs, windowMs, reps },
      endpoints: 'kernel send → supervisor ingress → sibling egress → kernel return',
    },
  };
}

export async function b6(opts = {}) {
  const stampIdentity = opts.stampIdentity !== false;
  const hostile = await hostileBattery({ stampIdentity });
  if (!stampIdentity) {
    return { pass: hostile.pass, detail: { mode: 'vacuity', hostile } };
  }
  if (opts.flood === false) return { pass: hostile.pass, detail: { hostile } };
  const flood = await floodBound(opts);
  let pass = hostile.pass && flood.pass === true;
  if (flood.outcome === 'invalid') pass = null;
  if (!hostile.pass) pass = false;
  return { pass, outcome: flood.outcome, detail: { hostile, flood } };
}
