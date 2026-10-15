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
  for (const dir of dirs) {
    try {
      const [quota, period] = readFileSync(`${dir}/cpu.max`, 'utf8').trim().split(/\s+/);
      if (quota === 'max') return { unlimited: true, period: Number(period) };
      return { unlimited: false, quota: Number(quota), period: Number(period) };
    } catch {
      // Parent cgroup may be the one that carries the quota.
    }
  }
  return { unlimited: true };
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

// Fixed-rate open loop. Missed slots are not burst-replayed.
export async function openLoop({ ms, rate, tick }) {
  const start = performance.now();
  const period = 1000 / rate;
  let next = start;
  let sent = 0;
  while (performance.now() - start < ms) {
    const now = performance.now();
    let budget = 0;
    while (next <= now && budget < 128 && performance.now() - start < ms) {
      tick();
      next += period;
      sent++;
      budget++;
    }
    if (now - next > 50) next = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return sent;
}
