import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeEnds,
  createChildEnds,
  fionread,
  headerDir,
  measureFlowReserve,
  resolveCacheDir,
  sourceHash,
} from './flow_socket.mjs';
import { writerCeiling } from './flow_budget.mjs';

test('the helper cache is private and keyed by the source hash', () => {
  const hash = sourceHash();
  const other = sourceHash('other source');
  assert.notEqual(hash, other);
  const dir = resolveCacheDir(hash);
  assert.equal(typeof dir, 'string');
  assert.ok(dir.endsWith(hash), dir);
  assert.equal(lstatSync(dir).isSymbolicLink(), false);
  assert.equal(lstatSync(dir).uid, process.getuid());
  assert.equal(lstatSync(dir).mode & 0o077, 0);
  const headers = headerDir();
  assert.equal(typeof headers, 'string');
});

test('socketpair sets the writer buffer, shuts unused directions, and reads FIONREAD', () => {
  const ends = createChildEnds();
  assert.ok(ends, 'helper unavailable');
  try {
    assert.equal(ends.kIn, writerCeiling(ends.sndbufIn));
    assert.equal(ends.kOut, writerCeiling(ends.sndbufOut));
    assert.ok(ends.kIn > 0);
    assert.equal(fionread(ends.parentStdout), 0);
    assert.equal(fionread(ends.stdinProbe), 0);
    let writeFailed = false;
    try {
      writeSync(ends.childStdin, Buffer.from('x'));
    } catch (err) {
      writeFailed = err.code === 'EPIPE';
    }
    assert.equal(writeFailed, true);
    const buf = Buffer.alloc(8);
    const n = readSync(ends.childStdout, buf, 0, buf.length, null);
    assert.equal(n, 0);
    const binary = join(resolveCacheDir(), 'flow_socket.node');
    const st = lstatSync(binary);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    assert.equal(st.uid, process.getuid());
    assert.equal(st.mode & 0o077, 0);
    const again = measureFlowReserve();
    assert.equal(again.kIn, ends.kIn);
    assert.equal(again.sndbufIn, ends.sndbufIn);
  } finally {
    closeEnds(ends);
  }
});
