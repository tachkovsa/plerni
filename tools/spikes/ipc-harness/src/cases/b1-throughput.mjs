// b1-throughput.mjs — open-loop framed round trips (plan §4 B1).
// Pass: ≥5,000 completed round-trips/s, 1 KiB payload, p99 ≤10 ms, zero corruption.
// Each repetition is scored on its own. p99 is not averaged across reps.

import { fileURLToPath } from 'node:url';
import { connectPair } from '../supervisor.mjs';
import { CONTRACT, delay, measureSeries, openLoop, percentile, preflight } from '../measure.mjs';

const echoPath = fileURLToPath(new URL('../children/echo.mjs', import.meta.url));
const PAYLOAD = 'x'.repeat(1024);
const CHILDREN = 2;
const IN_FLIGHT = 128;
const OFFERED_RATE = 8_000;
const TARGET_RATE = 5_000;
const P99_MS = 10;
const CALL_TIMEOUT = 2_000;

async function rep({ warmupMs, windowMs, script, callTimeout }) {
  const pair = await connectPair({ sweeper: false, caps: { pending: 512, total: 8 * 1024 * 1024 } });
  const childScript = script ?? echoPath;
  const timeout = callTimeout ?? CALL_TIMEOUT;
  const kids = [];
  for (let i = 0; i < CHILDREN; i++) {
    kids.push(pair.sup.spawn({ pluginId: `echo-${i}`, script: childScript }));
  }
  const samples = [];
  const ingress = [];
  const child = [];
  const ret = [];
  let completions = 0;
  let corrupt = 0;
  let errors = 0;
  let drops = 0;
  let offered = 0;
  let issued = 0;
  let inFlight = 0;
  let seq = 0;
  try {
    const started = performance.now();
    const windowEnd = started + warmupMs + windowMs;
    const noteDrop = () => {
      drops++;
      samples.push(CALL_TIMEOUT);
    };
    await openLoop({
      ms: warmupMs + windowMs,
      rate: OFFERED_RATE,
      onSkip: (missed) => {
        if (performance.now() - started < warmupMs) return;
        offered += missed;
        for (let i = 0; i < missed; i++) noteDrop();
      },
      tick: () => {
        const record = performance.now() - started >= warmupMs;
        if (record) offered++;
        if (inFlight >= IN_FLIGHT) {
          if (record) noteDrop();
          return;
        }
        if (record) issued++;
        inFlight++;
        const kid = kids[seq % kids.length];
        const correlationId = ++seq;
        pair.stub.call({
          pluginId: kid.credential.pluginId,
          credential: kid.credential,
          correlationId,
          port: 'db',
          method: 'get',
          payload: PAYLOAD,
        }, timeout).then((res) => {
          inFlight--;
          if (!record) return;
          if (res.payload !== PAYLOAD) corrupt++;
          if (performance.now() > windowEnd) return;
          completions++;
          if (res.rttMs != null) samples.push(res.rttMs);
          if (res.ingressTs != null && res.sendTs != null) ingress.push(res.ingressTs - res.sendTs);
          if (res.egressTs != null && res.ingressTs != null) child.push(res.egressTs - res.ingressTs);
          if (res.returnedAt != null && res.egressTs != null) ret.push(res.returnedAt - res.egressTs);
        }, () => {
          inFlight--;
          if (record) errors++;
        });
      },
    });
    const drainDeadline = Date.now() + 3_000;
    while (inFlight > 0 && Date.now() < drainDeadline) await delay(10);
    const seconds = windowMs / 1000;
    return {
      achieved: completions / seconds,
      p99: percentile(samples, 99),
      p99Ingress: percentile(ingress, 99),
      p99Child: percentile(child, 99),
      p99Return: percentile(ret, 99),
      completions,
      corrupt,
      errors,
      drops,
      offered,
      issued,
    };
  } finally {
    await pair.close();
  }
}

export async function b1(opts = {}) {
  const warmupMs = opts.warmupMs ?? CONTRACT.warmupMs;
  const windowMs = opts.windowMs ?? CONTRACT.windowMs;
  const repsN = opts.reps ?? CONTRACT.reps;
  const preflightFn = opts.preflight ?? preflight;
  const series = await measureSeries({
    reps: repsN,
    preflightFn,
    runRep: () => rep({ warmupMs, windowMs, script: opts.script, callTimeout: opts.callTimeout }),
  });
  if (series.outcome === 'invalid') {
    return { pass: null, outcome: 'invalid', detail: { env: series.env, results: series.rows, rerun: series.rerun } };
  }
  const results = series.rows;
  const pass = results.every((row) => row.achieved >= TARGET_RATE && row.p99 != null && row.p99 <= P99_MS && row.corrupt === 0 && row.errors === 0);
  return {
    pass,
    outcome: 'scored',
    detail: {
      env: series.env,
      targetRate: TARGET_RATE,
      p99Ms: P99_MS,
      payloadBytes: PAYLOAD.length,
      achieved: results.map((row) => row.achieved),
      p99s: results.map((row) => row.p99),
      offered: results.map((row) => row.offered),
      issued: results.map((row) => row.issued),
      drops: results.map((row) => row.drops),
      reps: results,
      frozen: { children: CHILDREN, inFlight: IN_FLIGHT, offeredRate: OFFERED_RATE, warmupMs, windowMs, reps: repsN },
      endpoints: 'kernel send → supervisor ingress → child egress → kernel return',
      topology: 'in-process kernel stub, one socket pair, spawned children',
    },
  };
}
