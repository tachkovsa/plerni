import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeEnds,
  createChildEnds,
  fionread,
  fileSeals,
  headerDir,
  sealedUndumpFd,
  sealedWrapperFd,
  sndbuf,
  measureFlowReserve,
  resolveCacheDir,
  sourceHash,
  wrapperPath,
} from './flow_socket.mjs';
import { writerCeiling } from './flow_budget.mjs';

test('the helper cache is private and keyed by the source hash', () => {
  const hash = sourceHash();
  const other = sourceHash('other source');
  assert.notEqual(hash, other);
  const dir = resolveCacheDir(hash);
  assert.equal(typeof dir, 'string');
  assert.ok(dir.endsWith(hash), dir);
  assert.ok(dir.includes(`${process.platform}-${process.arch}-`), dir);
  assert.equal(lstatSync(dir).isSymbolicLink(), false);
  assert.equal(lstatSync(dir).uid, process.getuid());
  assert.equal(lstatSync(dir).mode & 0o077, 0);
  const headers = headerDir();
  assert.equal(typeof headers, 'string');
});

test('the wrapper and the preload are sealed memfds, not the cache path', () => {
  const wrapperFd = sealedWrapperFd();
  const undumpFd = sealedUndumpFd();
  assert.equal(typeof wrapperFd, 'number');
  assert.equal(typeof undumpFd, 'number');
  const seals = fileSeals(wrapperFd);
  assert.equal(typeof seals, 'number');
  assert.notEqual(seals & 0x0008, 0);
  assert.notEqual(seals & 0x0001, 0);
  assert.throws(() => writeSync(wrapperFd, Buffer.from([0])), (err) => err?.code === 'EPERM' || err?.code === 'EBADF');
  const path = wrapperPath();
  const original = readFileSync(path);
  try {
    writeFileSync(path, Buffer.from('swapped-wrapper'));
    const live = readFileSync(`/proc/self/fd/${wrapperFd}`);
    assert.equal(live[0], 0x7f);
    assert.notEqual(live.subarray(0, 15).toString(), 'swapped-wrapper');
  } finally {
    writeFileSync(path, original);
    chmodSync(path, 0o700);
  }
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
    assert.equal(sndbuf(ends.stdoutWriter), ends.sndbufIn);
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
    assert.equal(again.kMuxIn, again.muxRcvbuf);
    assert.equal(again.kMuxOut, again.muxSndbuf);
    assert.notEqual(again.kMuxIn, writerCeiling(again.muxRcvbuf));
    assert.equal(again.muxReserve, again.kMuxIn + again.kMuxOut + again.readBytes);
  } finally {
    closeEnds(ends);
  }
});
