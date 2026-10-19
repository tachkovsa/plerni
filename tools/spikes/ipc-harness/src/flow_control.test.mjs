import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPair } from './supervisor.mjs';
import { assessFlow, classifyWriterOverrun, PROBE_INTERVAL_MS, OVERRUN_DEADLINE_MS } from './flow_budget.mjs';
import { measureFlowReserve } from './flow_socket.mjs';
import { tripCaps } from './cases/b3-backpressure.mjs';
import { waitUntil } from './measure.mjs';

const enlargePath = fileURLToPath(new URL('./children/enlarge-stdout.mjs', import.meta.url));

function block(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) { /* hold the event loop across the crossing */ }
  return Date.now() - start;
}

test('same-host vacuity pair: enforcement off fails and enforced passes', { timeout: 40_000 }, async () => {
  const off = await tripCaps({ enforceFlow: false });
  const on = await tripCaps({ enforceFlow: true });
  assert.notEqual(off.outcome, 'invalid', JSON.stringify(off.detail));
  assert.notEqual(off.outcome, 'unsatisfiable', JSON.stringify(off.detail));
  assert.equal(off.pass, false, JSON.stringify(off.detail));
  assert.equal(on.outcome, 'scored', JSON.stringify(on.detail));
  assert.equal(on.pass, true, JSON.stringify(on.detail));
});

test('an injected reservation that does not fit is unsatisfiable, not invalid', async () => {
  const result = await tripCaps({
    reserve: { sndbufIn: 200_000, sndbufOut: 200_000, readBytes: 4096 },
  });
  assert.equal(result.outcome, 'unsatisfiable');
  assert.equal(result.pass, false);
  assert.equal(result.detail.protocol, '3.0');
  const direct = assessFlow({
    partialCap: 32 * 1024,
    totalCap: 48 * 1024,
    totalGlobal: 1024 * 1024,
    sndbufIn: 200_000,
    sndbufOut: 200_000,
    readBytes: 4096,
    childCount: 1,
  });
  assert.equal(direct.outcome, 'unsatisfiable');
});

test('paused probe faults a buffer enlarger within 100 ms', { timeout: 15_000 }, async () => {
  const reserved = measureFlowReserve();
  assert.ok(reserved, 'helper unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'plerni-enlarge-'));
  const go = join(dir, 'go');
  const mark = join(dir, 'mark');
  const pair = await connectPair({
    sweeper: false,
    caps: { lo: 1, partial: 1024 * 1024, total: 1024 * 1024, totalGlobal: 8 * 1024 * 1024 },
  });
  try {
    pair.sup.spawn({
      pluginId: 'enlarge',
      script: enlargePath,
      env: { ENLARGE_GO: go, ENLARGE_MARK: mark, RESERVED_K: String(reserved.kIn) },
    });
    const rec = pair.sup.children.get('enlarge');
    // Pause before the event loop reads. The 20 ms probe is what has to see
    // the enlarged queue; a read callback would consume the crossing.
    rec.paused = true;
    rec.pauseReason = 'bulk';
    rec.child.stdout.pause();
    writeFileSync(go, '1');
    const lag = block(50);
    const faulted = await waitUntil(
      () => pair.sup.faults.some((fault) => fault.pluginId === 'enlarge' && fault.code === 'writer-overrun'),
      1_000,
    );
    assert.equal(faulted, true, JSON.stringify(pair.sup.faults));
    const observed = Date.now();
    const text = readFileSync(mark, 'utf8').trim().split(/\s+/);
    assert.equal(classifyWriterOverrun(text[0]), 'enlarger');
    const marked = Number(text[1]);
    const elapsed = observed - marked;
    assert.ok(elapsed >= 0 && elapsed < OVERRUN_DEADLINE_MS, String(elapsed));
    assert.ok(PROBE_INTERVAL_MS + lag < OVERRUN_DEADLINE_MS, String(lag));
    const fault = pair.sup.faults.find((row) => row.code === 'writer-overrun');
    assert.ok(fault.stdoutUnread > fault.kIn, JSON.stringify(fault));
    assert.equal(fault.kIn, reserved.kIn);
  } finally {
    await pair.close();
  }
});
