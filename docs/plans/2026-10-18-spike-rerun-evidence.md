# Spike rerun evidence (2026-10-18)

Backing lines for `2026-10-18-spike-a-report.md` and `2026-10-18-spike-b-report.md`. Dev SHA `3de0b5b28130960eb8a3df5bc7ea28c4164b9766`. Node v24.22.0. PostgreSQL 18.6, PgBouncer 1.26.0, `pool_mode=transaction`, `max_prepared_statements=0`. JSONL stays gitignored. Passwords are not recorded.

Review receipt: pending (δ, cross-family).

## Suite commands

From a clean worktree of that SHA, after the four harness passwords are exported:

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/db-invariant spike
```

Scored result: exit 0, 6766 ms, 0 failing cases. An earlier invocation on the same SHA exited 1 with `client_login_timeout (server down)` before any pooled case. That run is the invalid-run record in the A report. It is not a verdict.

```bash
cd tools/harness && ./reset.sh && cd ../.. && node tools/harness/seed.mjs && pnpm --filter @plerni-spike/ipc-harness spike && pnpm --filter @plerni-spike/ipc-harness test && pnpm --filter @plerni-spike/ipc-harness test:races
```

`spike` exit 0. `test` 107 pass, 0 fail, 0 skipped, duration_ms 23004.388287. `test:races` 24 pass, 0 fail, duration_ms 92138.945849, then the B6 vacuity control 1 pass, duration_ms 1666.445785.

## A1–A4 and the battery

```text
[PASS] A1 @ direct — {"via":"kysely","runs":[[1008,1008,1008],[1009,1009,1009],[1010,1010,1010],[1011,1011,1011],[1014,1014,1014],[1012,1012,1012],[1015,1015,1015],[1013,1013,1013]]}
[PASS] A1 @ pooled — {"via":"kysely","runs":[[1021,1021,1021],[1022,1022,1022],[1019,1019,1019],[1018,1018,1018],[1018,1018,1018],[1023,1023,1023],[1020,1020,1020],[1019,1019,1019]]}
[PASS] A1 @ direct (raw-pg control) — {"via":"raw-pg","runs":[[1024,1024,1024],[1031,1031,1031],[1025,1025,1025],[1026,1026,1026],[1029,1029,1029],[1027,1027,1027],[1028,1028,1028],[1030,1030,1030]]}
[PASS] A2a clean-deny @ direct — {"rowsWithoutContext":0,"guardRaised":true}
[PASS] A2a clean-deny @ pooled — {"rowsWithoutContext":0,"guardRaised":true}
[PASS] A2b valid-context positive control @ pooled — {"read":["assignment","goal","review"],"want":["assignment","goal","review"]}
[PASS] A2c leak-freedom on reused connection @ pooled — {"contextAbsentAfterCommit":true,"rowsWithoutContextFollowUp":0}
[PASS] A3 A1 pinning @ pooled — {"statementsPerTransaction":3,"concurrent":8,"runs":[[1018,1018,1018],[1018,1018,1018],[1022,1022,1022],[1020,1020,1020],[1022,1022,1022],[1021,1021,1021],[1021,1021,1021],[1020,1020,1020]]}
[PASS] A3 mid-transaction error rollback @ pooled — {"code":"22012","installedPid":1048,"after":{"pid":1048,"absent":true,"rows":0,"guard":true}}
[PASS] A3 contamination lifecycle @ pooled — {"detectedOnExecutingBackend":true,"terminatedAndGone":true,"absenceOnReplacement":true,"positiveControl":true,"retries":1,"boundedRetry":true,"cleanupMs":24,"deadPid":1050,"backendGoneMs":5,"replacementPid":1052}
[PASS] A4 unnamed statement names @ direct+pooled — {"observed":75,"extended":34,"simple":41,"nonempty":[],"loadError":null}
[PASS] A4 unnamed-vs-named overhead @ direct — {"overheadPct":[31.2,30.9,29.3,29.7,37.1,30.2,34.2,37.9,24.6,30.1],"spread":{"min":24.6,"median":30.5,"p95":37.9,"mean":31.5,"meanUnrounded":31.51816343036557,"ci95Low":28.7,"ci95High":34.3},"decision":"mean-exceeds-20","a4bRequired":true}
[PASS] battery terminations == injected @ pooled(1) — {"injected":8,"terminated":8,"warmTailTerminations":0}
evidence: tools/spikes/db-invariant/evidence/run-2026-10-18T18-39-10-809Z.jsonl (6766ms) — 0 failing case(s)
```

The pooled A1 row is Kysely. There is no `A1 @ pooled (raw-pg control)` line. That is why the pooled raw-pg claim is NOT DEMONSTRATED.

## B1–B6 scored spike

Fields below are taken from the scored lines. They are the same run, not a second one.

```text
[PASS] b2-fencing — {"lost":"lost","lostStatus":"COMMITTED","ack":"cancelled","ackStatus":"CANCELLED","fenceAck":"cancelled","fenced":true,"fenceStatus":"CANCELLED","ignoreResult":"ignore","ignoreCancelCode":"timeout"}
[PASS] b1-throughput — {"achieved":[7998.233333333334,8000,7999.883333333333],"p99s":[0.48769500001799315,0.36533000000054017,0.38552399998297915],"offered":[480000,480000,480000],"issued":[479894,480000,479993],"drops":[106,0,7]}
[PASS] b3-backpressure — {"limit":67108864,"caps":{"pending":{"tripped":true,"admitted":4,"rejected":4},"partial":{"tripped":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","bound":true},"total":{"tripped":true,"buffered":0,"bound":true},"kernel":{"tripped":true,"occupied":1,"buffered":270,"bound":true},"kernelBytes":{"tripped":true,"buffered":0,"bound":true}},"growth":[778240,290816,10981376]}
[PASS] b4-bounds — {"malformed":{"code":"NdjsonFramingError","processAlive":true,"siblingRoundTrip":true},"neverTerminated":{"code":"NdjsonOversizeError","pendingBytes":1049600,"bounded":true,"siblingRoundTrip":true},"oversize":{"code":"MuxOversizeError","limit":1048576,"processAlive":true,"reachable":false}}
[PASS] b5-crash — {"crash":{"code":"child-exited","exitCode":1},"token":{"refused":true,"newTokenFenced":true,"status":"ACTIVE","distinct":true}}
[PASS] b6-mux-identity — {"hostile":{"pass":true,"checks":{"routing":true,"forged":true,"mismatch":true,"collision":true,"stale":true}},"flood":{"p99s":[84.60772300000099,69.99451699999918,86.12858599997708],"floodRate":[179614.88333333333,181371.36666666667,179893.51666666666]}}
[PASS] smoke — {"mainPath":"pooled","authority":"PASS"}
SPIKE_EXIT 0
```

The partial object is taken from the scored b3 line. It is the B3 FAIL: 1052672 bytes against a 32768-byte cap, with `bound` true only because the predicate is `< 2 MiB`.

## Partial cap and commit-versus-revoke overlap

One Node process on the same dev SHA, after `reset.sh` and `seed.mjs`, with the four harness passwords already exported. Working directory `tools/spikes/ipc-harness`, so the relative imports and the `pg` dependency resolve. No harness file was added. The stdout is the two blocks below.

```bash
cd tools/spikes/ipc-harness
node --input-type=module <<'EOF'
import pg from 'pg';
import { tripCaps } from './src/cases/b3-backpressure.mjs';
import {
  FencedError,
  cancelExecution,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
} from './src/authority.mjs';

const partials = [];
for (let i = 0; i < 3; i++) {
  const row = await tripCaps();
  partials.push({
    pass: row.pass,
    pendingBytes: row.detail.partial.pendingBytes,
    code: row.detail.partial.code,
    tripped: row.detail.partial.tripped,
    bound: row.detail.partial.bound,
    cap: 32 * 1024,
  });
}

function root() {
  return new pg.Client({
    host: 'localhost',
    port: 54320,
    database: 'plerni',
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD,
  });
}

async function raceOnce() {
  const useDirect = false;
  const id = await createExecution('b2-overlap', 'tok-overlap', useDirect);
  await dispatch(id, useDirect);
  const watcher = root();
  await watcher.connect();
  let cancelWon = null;
  let waitSample = null;
  const started = Date.now();
  let commitOutcome = null;
  try {
    const commitP = commitExecution(id, 'tok-overlap', async (c) => {
      await c.query('SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE', [id]);
      const cancelP = cancelExecution(id, useDirect).then((won) => {
        cancelWon = won;
        return won;
      });
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const q = await watcher.query(
          `SELECT wait_event_type, wait_event, state
             FROM pg_stat_activity
            WHERE datname = 'plerni'
              AND query LIKE '%status = ''CANCELLED''%'
              AND pid <> pg_backend_pid()`,
        );
        const hit = q.rows.find((row) => row.wait_event_type === 'Lock');
        if (hit) {
          waitSample = hit;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      globalThis.__cancelP = cancelP;
    }, useDirect);
    try {
      commitOutcome = await commitP;
    } catch (err) {
      commitOutcome = {
        error: err instanceof FencedError ? 'FencedError' : err.constructor?.name,
      };
    }
    await globalThis.__cancelP;
  } finally {
    await watcher.end();
  }
  const status = await getStatus(id, useDirect);
  return {
    ms: Date.now() - started,
    commit: commitOutcome && commitOutcome.committed === true,
    fenced: commitOutcome?.error === 'FencedError',
    cancelWon,
    status: status?.status ?? null,
    revokerWaitedOnLock: waitSample !== null,
    waitEvent: waitSample?.wait_event ?? null,
  };
}

const races = [];
for (let i = 0; i < 3; i++) races.push(await raceOnce());
console.log(JSON.stringify({ partials, races }, null, 2));
EOF
```

`tripCaps()` rows from that process:

```text
{"pass":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","tripped":true,"bound":true,"cap":32768}
{"pass":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","tripped":true,"bound":true,"cap":32768}
{"pass":true,"pendingBytes":1052672,"code":"NdjsonOversizeError","tripped":true,"bound":true,"cap":32768}
```

Overlap rows from the same process. `useDirect` is false, so commit and cancel use the pooled datasource. The effects callback takes `SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE`, starts `cancelExecution` on a second connection, and waits until `pg_stat_activity` shows that `CANCELLED` update in `Lock` / `transactionid`. The executor then commits.

```text
{"ms":41,"commit":true,"fenced":false,"cancelWon":false,"status":"COMMITTED","revokerWaitedOnLock":true,"waitEvent":"transactionid"}
{"ms":39,"commit":true,"fenced":false,"cancelWon":false,"status":"COMMITTED","revokerWaitedOnLock":true,"waitEvent":"transactionid"}
{"ms":36,"commit":true,"fenced":false,"cancelWon":false,"status":"COMMITTED","revokerWaitedOnLock":true,"waitEvent":"transactionid"}
```

## Race battery

```text
✔ death-before-commit (79.132159ms)
✔ lost-reply (54.404059ms)
✔ recovery-vs-live-commit (151.506271ms)
✔ healthy-long (46509.739515ms)
✔ stalled shutdown fails the renewal-to-lock oracle (11109.343515ms)
✔ heartbeat-behind-commit (5056.17355ms)
✔ saturated-pool (21393.553728ms)
✔ queued-past-lease (50.687624ms)
✔ second-executor-takeover (124.840675ms)
✔ vacuity-authority fails when the ACTIVE predicate is removed (228.420842ms)
ℹ pass 24
ℹ fail 0
ℹ duration_ms 92138.945849
RACES_EXIT 0
```

## A5

A5 is the 2026-10-17 CI measurement cited in the A report: bench-dispatch run 39044052211, commit `c94d9a92aa85a4a97e8f4fdd57ce6171b00f6239`. This T6 session did not repeat that curve.
