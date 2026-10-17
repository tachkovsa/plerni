// SPDX-License-Identifier: Apache-2.0
// measure.mjs N — tsc --noEmit wall time and peak RSS for one band.
// RSS comes from /usr/bin/time -v (extendedDiagnostics reports heap, not RSS).
// Three repetitions. A failed pre-flight or an unreadable timing is invalid
// and retried once; an invalid environment is not a ceiling verdict.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import pg from 'pg';
import {
  ACCEPTANCE_BAND,
  CEILING_RSS_KIB,
  CEILING_WALL_MS,
  REPETITIONS,
  assertBand,
  spikeRoot,
} from './band.mjs';
import { lintFile, reportFindings } from './corpus-lint.mjs';
import { renderCorpus } from './gen-corpus.mjs';

const MIN_AVAILABLE_KIB = 6 * 1024 * 1024;
const TIME_BIN = '/usr/bin/time';

export function parseTimeReport(stderr) {
  const wall = stderr.match(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([0-9:.]+)/);
  const rss = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  if (!wall || !rss) return null;
  const parts = wall[1].split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  let seconds;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else return null;
  return { wall_ms: Math.round(seconds * 1000), rss_kib: Number(rss[1]) };
}

function readMemAvailableKib() {
  if (!existsSync('/proc/meminfo')) return null;
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) : null;
}

function readCpuQuota() {
  if (!existsSync('/sys/fs/cgroup/cpu.max')) return { raw: null, cores: null };
  const raw = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
  const [quota, period] = raw.split(/\s+/);
  if (quota === 'max' || !period) return { raw, cores: null };
  const cores = Number(quota) / Number(period);
  return { raw, cores: Number.isFinite(cores) ? cores : null };
}

export function preflightSync() {
  const mem = readMemAvailableKib();
  const cpu = readCpuQuota();
  const cpus = os.cpus().length;
  const reasons = [];
  if (!existsSync(TIME_BIN)) reasons.push('gnu-time-missing');
  if (mem === null || mem < MIN_AVAILABLE_KIB) reasons.push('low-memory');
  if (cpus < 2) reasons.push('few-cpus');
  if (cpu.cores !== null && cpu.cores < 1.5) reasons.push('cpu-quota');
  return {
    ok: reasons.length === 0,
    reasons,
    mem_available_kib: mem,
    cpus,
    cpu_quota: cpu.raw,
    loadavg: os.loadavg(),
    node: process.version,
    ci: process.env.GITHUB_ACTIONS === 'true',
    runner_os: process.env.RUNNER_OS ?? null,
    image_os: process.env.ImageOS ?? null,
  };
}

async function databaseReady() {
  if (process.env.BENCH_REQUIRE_DB !== '1') return { required: false, ok: true };
  const host = process.env.BENCH_PG_HOST ?? '127.0.0.1';
  const port = Number(process.env.BENCH_PG_PORT ?? '54320');
  const user = process.env.BENCH_PG_USER ?? 'postgres';
  const password = process.env.BENCH_PG_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? '';
  if (!password) return { required: true, ok: false, reason: 'password-missing' };
  const client = new pg.Client({ host, port, user, password, database: 'postgres', connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('select 1 as ok');
    return { required: true, ok: true };
  } catch {
    return { required: true, ok: false, reason: 'connect-failed' };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function preflight() {
  const sync = preflightSync();
  const db = await databaseReady();
  const reasons = [...sync.reasons];
  if (db.required && !db.ok) reasons.push(db.reason ?? 'database');
  return { ...sync, ok: reasons.length === 0, reasons, database: db.required ? db.ok : null };
}

function runTimed(tscBin, tsconfig) {
  return new Promise((resolveRun) => {
    const child = spawn(TIME_BIN, ['-v', tscBin, '--noEmit', '-p', tsconfig], {
      cwd: spikeRoot,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => {
      const parsed = parseTimeReport(stderr);
      resolveRun({
        measured: parsed !== null,
        wall_ms: parsed?.wall_ms ?? null,
        rss_kib: parsed?.rss_kib ?? null,
        exit_code: code,
        signal: signal ?? null,
        detail: parsed ? null : `${stdout}\n${stderr}`.slice(-2000),
      });
    });
  });
}

export function classifyTarget(band, reps) {
  const ceilingApplies = band === ACCEPTANCE_BAND;
  if (reps.some((rep) => !rep.measured)) {
    return { outcome: 'invalid', ceiling_applies: ceilingApplies, wall_ms_max: null, rss_kib_max: null, killed: false };
  }
  const wall = Math.max(...reps.map((rep) => rep.wall_ms));
  const rss = Math.max(...reps.map((rep) => rep.rss_kib));
  const killed = reps.some((rep) => rep.signal === 'SIGKILL' || rep.exit_code === 137);
  const compilerError = reps.some((rep) => rep.exit_code !== 0 && rep.exit_code !== 137 && rep.signal !== 'SIGKILL');
  if (compilerError) {
    return { outcome: 'compiler-error', ceiling_applies: ceilingApplies, wall_ms_max: wall, rss_kib_max: rss, killed };
  }
  const over = killed || wall > CEILING_WALL_MS || rss > CEILING_RSS_KIB;
  if (ceilingApplies) {
    return {
      outcome: over ? 'over-ceiling' : 'within-ceiling',
      ceiling_applies: true,
      wall_ms_max: wall,
      rss_kib_max: rss,
      killed,
    };
  }
  return { outcome: 'stress', ceiling_applies: false, over_ceiling: over, wall_ms_max: wall, rss_kib_max: rss, killed };
}

function evidencePath() {
  const dir = join(spikeRoot, 'evidence');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'bench.jsonl');
}

function writeEvidence(row) {
  appendFileSync(evidencePath(), `${JSON.stringify(row)}\n`);
}

async function timeTarget(band, target, tsconfig, environment) {
  const tscBin = join(spikeRoot, 'node_modules', '.bin', 'tsc');
  const reps = [];
  for (let rep = 1; rep <= REPETITIONS; rep++) {
    let result = await runTimed(tscBin, tsconfig);
    let rerun = false;
    if (!result.measured) {
      result = await runTimed(tscBin, tsconfig);
      rerun = true;
    }
    const row = {
      band,
      kind: 'rep',
      target,
      rep,
      rerun,
      ...result,
      detail: undefined,
    };
    if (!result.measured) row.outcome = 'invalid';
    writeEvidence(row);
    console.log(`[${result.measured ? 'measured' : 'invalid'}] band ${band} ${target} rep ${rep} wall_ms=${result.wall_ms} rss_kib=${result.rss_kib} exit=${result.exit_code}`);
    reps.push(result);
    if (!result.measured && result.detail) console.error(result.detail);
  }
  const summary = classifyTarget(band, reps);
  writeEvidence({ band, kind: 'target', target, ...summary, environment });
  console.log(`[${summary.outcome}] band ${band} ${target} wall_ms_max=${summary.wall_ms_max} rss_kib_max=${summary.rss_kib_max}`);
  return summary;
}

export async function measureBand(n) {
  assertBand(n);
  let environment = await preflight();
  if (!environment.ok) environment = await preflight();
  const rendered = renderCorpus(n);
  const findings = lintFile(rendered.corpusPath);
  if (findings.length) {
    reportFindings(findings);
    throw new Error(`corpus-lint failed for band ${n}`);
  }
  if (!environment.ok) {
    const summary = { band: n, kind: 'summary', outcome: 'invalid', environment };
    writeEvidence(summary);
    console.log(`[invalid] band ${n} preflight ${environment.reasons.join(',')}`);
    return summary;
  }
  const corpus = await timeTarget(n, 'corpus', join(rendered.dir, 'tsconfig.corpus.json'), environment);
  const baseline = await timeTarget(n, 'baseline', join(rendered.dir, 'tsconfig.baseline.json'), environment);
  const outcomes = [corpus.outcome, baseline.outcome];
  let outcome = 'measured';
  if (outcomes.includes('invalid')) outcome = 'invalid';
  else if (outcomes.includes('compiler-error')) outcome = 'compiler-error';
  else if (n === ACCEPTANCE_BAND && outcomes.includes('over-ceiling')) outcome = 'over-ceiling';
  else if (n === ACCEPTANCE_BAND) outcome = 'within-ceiling';
  else outcome = 'stress';
  const summary = { band: n, kind: 'summary', outcome, corpus, baseline };
  writeEvidence(summary);
  console.log(`[${outcome}] band ${n} summary`);
  return summary;
}

function failClosed(summary) {
  if (!summary) return true;
  if (summary.outcome === 'invalid' || summary.outcome === 'compiler-error') return true;
  if (summary.band === ACCEPTANCE_BAND && summary.outcome === 'over-ceiling') return true;
  return false;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  const n = Number(process.argv[2]);
  measureBand(n)
    .then((summary) => {
      if (failClosed(summary)) process.exit(1);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
