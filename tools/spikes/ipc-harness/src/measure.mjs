// measure.mjs — measurement contract for Spike B performance cases (plan §4).
// Open-loop arrivals, warm-up ≥5 s, window ≥60 s, ≥3 reps. p99 is per repetition.
// A CPU-throttled environment invalidates the run; the caller reruns rather than scoring it.

import { readFileSync } from 'node:fs';
import os from 'node:os';

export const CONTRACT = Object.freeze({
  warmupMs: 5_000,
  windowMs: 60_000,
  reps: 3,
});

export const RSS_GROWTH_LIMIT = 64 * 1024 * 1024;

function cpuQuota() {
  let rel = '';
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').pop() || '';
    const slash = line.indexOf('/');
    rel = slash >= 0 ? line.slice(slash) : '';
  } catch {
    return { unlimited: true };
  }
  const parts = rel.split('/').filter(Boolean);
  const dirs = [];
  for (let i = parts.length; i >= 0; i--) {
    dirs.push(`/sys/fs/cgroup/${parts.slice(0, i).join('/')}`);
  }
  // `max` is only "no limit at this level". A parent can still set the quota.
  let tightest = null;
  for (const dir of dirs) {
    try {
      const [quota, periodText] = readFileSync(`${dir}/cpu.max`, 'utf8').trim().split(/\s+/);
      if (quota === 'max') continue;
      const period = Number(periodText);
      const limit = Number(quota);
      if (!Number.isFinite(limit) || !Number.isFinite(period) || period <= 0) continue;
      if (!tightest || limit / period < tightest.quota / tightest.period) {
        tightest = { quota: limit, period };
      }
    } catch {
      // This level may not expose cpu.max.
    }
  }
  return tightest ? { unlimited: false, ...tightest } : { unlimited: true };
}

// Records the environment. Does not include cgroup paths or host identifiers.
export function preflight() {
  const cpu = cpuQuota();
  const cpus = os.cpus()?.length || 1;
  const load = os.loadavg()[0];
  const cores = !cpu.unlimited && cpu.period ? cpu.quota / cpu.period : cpus;
  const throttled = !cpu.unlimited && cores < 1;
  const overloaded = Number.isFinite(load) && load > cpus * 1.5;
  return {
    cpus,
    load: Number.isFinite(load) ? Math.round(load * 100) / 100 : null,
    cpuUnlimited: cpu.unlimited === true,
    throttled,
    overloaded,
    valid: !throttled && !overloaded,
  };
}

// Nearest-rank percentile. `values` is copied; the caller's array is left intact.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx];
}

export function treeRss(pids) {
  let total = 0;
  const ids = [process.pid, ...pids];
  for (const pid of ids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (match) total += Number(match[1]) * 1024;
    } catch {
      // Child already exited.
    }
  }
  return total;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitUntil(fn, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const step = () => {
      if (fn()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(step, 10);
    };
    step();
  });
}

// Fixed-rate open loop. Missed slots are not burst-replayed.
// `skipped` counts schedule slots jumped after falling more than 50 ms behind.
export async function openLoop({ ms, rate, tick, onSkip }) {
  const start = performance.now();
  const period = 1000 / rate;
  let next = start;
  let issued = 0;
  let skipped = 0;
  while (performance.now() - start < ms) {
    const now = performance.now();
    let budget = 0;
    while (next <= now && budget < 128 && performance.now() - start < ms) {
      tick();
      next += period;
      issued++;
      budget++;
    }
    const lag = performance.now() - next;
    if (lag > 50) {
      const missed = Math.floor(lag / period);
      skipped += missed;
      if (onSkip) onSkip(missed);
      next = performance.now();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { issued, skipped, offered: issued + skipped };
}

// Rerun once when the environment is invalid. Thresholds are the caller's job
// and run only on a scored attempt.
export async function measureSeries({ reps, preflightFn, runRep }) {
  const attempt = async () => {
    const rows = [];
    let invalid = false;
    const before = preflightFn();
    if (!before.valid) invalid = true;
    for (let i = 0; i < reps; i++) {
      const row = await runRep(i);
      const after = preflightFn();
      row.envAfter = after;
      if (!before.valid || !after.valid) {
        invalid = true;
        row.invalid = true;
      }
      rows.push(row);
    }
    return { before, rows, invalid };
  };
  const first = await attempt();
  if (!first.invalid) return { outcome: 'scored', env: first.before, rows: first.rows };
  const second = await attempt();
  if (second.invalid) {
    return { outcome: 'invalid', pass: null, env: second.before, rows: first.rows, rerun: second.rows };
  }
  return { outcome: 'scored', env: second.before, rows: second.rows };
}
