// flow_socket.mjs — socketpair helper for the writer-end reservation.
// Same publication rules as pipe_pending.mjs: compiled for this ABI on first
// use, binary placed in a 0700 directory owned by the current uid, symlink
// rejected, group and other bits clear, ownership and mode checked again
// before require(). The cache directory is keyed by a hash of the C source,
// so a source change cannot load a stale binary. A failed compile, check, or
// call returns null. Callers must not turn that null into a scored bound.
// No shell. No new dependencies.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { entryIsPrivate } from './pipe_pending.mjs';
import { FLOW_READ_BYTES, writerCeiling } from './flow_budget.mjs';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('./flow_socket.c', import.meta.url));

let helper = null;
let failed = false;
let reserve = null;

export function sourceHash(text = readFileSync(source)) {
  return createHash('sha256').update(text).digest('hex');
}

export function headerDir() {
  const version = process.version.startsWith('v') ? process.version.slice(1) : process.version;
  const candidates = [
    join(dirname(dirname(process.execPath)), 'include', 'node'),
    join(homedir(), '.cache', 'node-gyp', version, 'include', 'node'),
    join(homedir(), '.nvm', 'versions', 'node', process.version, 'include', 'node'),
  ];
  for (const dir of candidates) {
    try {
      const st = lstatSync(join(dir, 'node_api.h'));
      if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
      return dir;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function prepareDir(dir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null) return false;
  try {
    const existing = lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory() || existing.uid !== uid) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
  }
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return false;
    chmodSync(dir, 0o700);
    return entryIsPrivate(lstatSync(dir), uid, 'dir');
  } catch {
    return false;
  }
}

export function resolveCacheDir(hash = sourceHash()) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid == null || typeof hash !== 'string' || hash.length === 0) return null;
  const home = homedir();
  if (home) {
    const root = join(home, '.cache', 'plerni-flow-socket');
    const abi = join(root, String(process.versions.modules));
    const dir = join(abi, hash);
    if (prepareDir(root) && prepareDir(abi) && prepareDir(dir)) return dir;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'plerni-flow-socket-'));
    chmodSync(dir, 0o700);
    if (entryIsPrivate(lstatSync(dir), uid, 'dir')) return dir;
  } catch {
    return null;
  }
  return null;
}

function publishBinary(dir, headers) {
  const uid = process.getuid();
  const finalName = join(dir, 'flow_socket.node');
  const tmpName = join(dir, `.flow_socket.${process.pid}.${randomBytes(8).toString('hex')}.node`);
  try {
    execFileSync('gcc', [
      '-shared',
      '-fPIC',
      `-I${headers}`,
      '-o',
      tmpName,
      source,
    ], { stdio: 'ignore' });
    chmodSync(tmpName, 0o700);
    if (!entryIsPrivate(lstatSync(tmpName), uid, 'file')) {
      rmSync(tmpName, { force: true });
      return null;
    }
    renameSync(tmpName, finalName);
    chmodSync(finalName, 0o700);
    if (!entryIsPrivate(lstatSync(finalName), uid, 'file')) return null;
    return finalName;
  } catch {
    try { rmSync(tmpName, { force: true }); } catch { /* the compiler never created it */ }
    return null;
  }
}

function loadHelper() {
  if (helper) return helper;
  if (failed) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const headers = headerDir();
  const dir = uid == null || !headers ? null : resolveCacheDir();
  if (!headers || !dir) {
    failed = true;
    return null;
  }
  const binary = join(dir, 'flow_socket.node');
  try {
    let target = null;
    try {
      if (entryIsPrivate(lstatSync(binary), uid, 'file')) target = binary;
    } catch {
      target = null;
    }
    if (!target) target = publishBinary(dir, headers);
    if (!target || !entryIsPrivate(lstatSync(target), uid, 'file')) {
      failed = true;
      return null;
    }
    helper = require(target);
    return helper;
  } catch {
    failed = true;
    return null;
  }
}

function asFd(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function closeFd(fd) {
  if (!Number.isInteger(fd) || fd < 0) return;
  try { closeSync(fd); } catch { /* already closed */ }
}

export function closeEnds(ends) {
  if (!ends) return;
  for (const fd of [ends.parentStdin, ends.childStdin, ends.stdinProbe, ends.childStdout, ends.parentStdout]) {
    closeFd(fd);
  }
}

// Request 2048 so the kernel clamps to its doubled minimum. The budgets use
// the getsockopt read-back, not this request.
export const SNDBUF_REQUEST = 2048;

export function createChildEnds(request = SNDBUF_REQUEST) {
  const fn = loadHelper();
  if (!fn || typeof fn.create !== 'function') return null;
  let row = null;
  try {
    row = fn.create(request);
  } catch {
    return null;
  }
  const ends = {
    parentStdin: asFd(row?.parentStdin),
    childStdin: asFd(row?.childStdin),
    stdinProbe: asFd(row?.stdinProbe),
    childStdout: asFd(row?.childStdout),
    parentStdout: asFd(row?.parentStdout),
    sndbufIn: Number.isInteger(row?.sndbufIn) && row.sndbufIn > 0 ? row.sndbufIn : null,
    sndbufOut: Number.isInteger(row?.sndbufOut) && row.sndbufOut > 0 ? row.sndbufOut : null,
  };
  const fds = [ends.parentStdin, ends.childStdin, ends.stdinProbe, ends.childStdout, ends.parentStdout];
  if (fds.some((fd) => fd == null) || ends.sndbufIn == null || ends.sndbufOut == null) {
    closeEnds(ends);
    return null;
  }
  const kIn = writerCeiling(ends.sndbufIn);
  const kOut = writerCeiling(ends.sndbufOut);
  if (kIn == null || kOut == null) {
    closeEnds(ends);
    return null;
  }
  return { ...ends, kIn, kOut, readBytes: FLOW_READ_BYTES };
}

export function fionread(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.pending !== 'function') return null;
  try {
    const unread = fn.pending(fd);
    if (!Number.isInteger(unread) || unread < 0) return null;
    return unread;
  } catch {
    return null;
  }
}

export function setSndbuf(fd, request) {
  if (!Number.isInteger(fd) || fd < 0 || !Number.isInteger(request) || request <= 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.setSndbuf !== 'function') return null;
  try {
    const got = fn.setSndbuf(fd, request);
    if (!Number.isInteger(got) || got <= 0) return null;
    return got;
  } catch {
    return null;
  }
}

export function measureFlowReserve() {
  if (reserve) return reserve;
  const ends = createChildEnds();
  if (!ends) return null;
  reserve = {
    sndbufIn: ends.sndbufIn,
    sndbufOut: ends.sndbufOut,
    kIn: ends.kIn,
    kOut: ends.kOut,
    readBytes: FLOW_READ_BYTES,
    perChild: ends.kIn + ends.kOut + FLOW_READ_BYTES,
  };
  closeEnds(ends);
  return reserve;
}
