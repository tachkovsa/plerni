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
const socketSource = fileURLToPath(new URL('./flow_socket.c', import.meta.url));
const confineSource = fileURLToPath(new URL('./confine.c', import.meta.url));

let helper = null;
let failed = false;
let reserve = null;

export function sourceHash(text = null) {
  const body = text == null
    ? Buffer.concat([readFileSync(socketSource), Buffer.from('\0'), readFileSync(confineSource)])
    : text;
  return createHash('sha256').update(body).digest('hex');
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
    const abi = join(root, `${process.platform}-${process.arch}-${process.versions.modules}`);
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

function publishFile(dir, finalName, tmpName, args) {
  const uid = process.getuid();
  try {
    execFileSync('gcc', args, { stdio: 'ignore' });
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

function publishBinary(dir, headers) {
  const finalName = join(dir, 'flow_socket.node');
  const tmpName = join(dir, `.flow_socket.${process.pid}.${randomBytes(8).toString('hex')}.node`);
  return publishFile(dir, finalName, tmpName, [
    '-shared',
    '-fPIC',
    `-I${headers}`,
    '-o',
    tmpName,
    socketSource,
  ]);
}

function publishWrapper(dir) {
  const finalName = join(dir, 'confine');
  const tmpName = join(dir, `.confine.${process.pid}.${randomBytes(8).toString('hex')}`);
  return publishFile(dir, finalName, tmpName, ['-O2', '-o', tmpName, confineSource]);
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
  const wrapper = join(dir, 'confine');
  try {
    let target = null;
    let confine = null;
    try {
      if (entryIsPrivate(lstatSync(binary), uid, 'file')) target = binary;
    } catch {
      target = null;
    }
    try {
      if (entryIsPrivate(lstatSync(wrapper), uid, 'file')) confine = wrapper;
    } catch {
      confine = null;
    }
    if (!target) target = publishBinary(dir, headers);
    if (!confine) confine = publishWrapper(dir);
    if (!target || !confine
        || !entryIsPrivate(lstatSync(target), uid, 'file')
        || !entryIsPrivate(lstatSync(confine), uid, 'file')) {
      failed = true;
      return null;
    }
    helper = require(target);
    helper.wrapper = confine;
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
  for (const fd of [ends.parentStdin, ends.childStdin, ends.stdinProbe, ends.stdoutWriter, ends.childStdout, ends.parentStdout]) {
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
    stdoutWriter: asFd(row?.stdoutWriter),
    childStdout: asFd(row?.childStdout),
    parentStdout: asFd(row?.parentStdout),
    sndbufIn: Number.isInteger(row?.sndbufIn) && row.sndbufIn > 0 ? row.sndbufIn : null,
    sndbufOut: Number.isInteger(row?.sndbufOut) && row.sndbufOut > 0 ? row.sndbufOut : null,
  };
  const fds = [ends.parentStdin, ends.childStdin, ends.stdinProbe, ends.stdoutWriter, ends.childStdout, ends.parentStdout];
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

export function sndbuf(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.sndbuf !== 'function') return null;
  try {
    const got = fn.sndbuf(fd);
    if (!Number.isInteger(got) || got <= 0) return null;
    return got;
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

function positive(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function muxRow(row) {
  const fd = asFd(row?.fd);
  const snd = positive(row?.sndbuf);
  const rcv = positive(row?.rcvbuf);
  if (fd == null || snd == null || rcv == null) {
    closeFd(fd);
    return null;
  }
  const kOut = writerCeiling(snd);
  const kIn = writerCeiling(rcv);
  if (kIn == null || kOut == null) {
    closeFd(fd);
    return null;
  }
  return { fd, sndbuf: snd, rcvbuf: rcv, kIn, kOut };
}

// Bound socket, not yet listening. SO_SNDBUF and SO_RCVBUF are already the
// read-back. The caller listens; an accepted socket inherits these values.
export function openMuxListener(request = SNDBUF_REQUEST) {
  const fn = loadHelper();
  if (!fn || typeof fn.pinListen !== 'function') return null;
  let raw = null;
  try {
    raw = fn.pinListen(request);
  } catch {
    return null;
  }
  const row = muxRow(raw);
  if (!row) return null;
  const port = positive(raw?.port);
  if (port == null) {
    closeFd(row.fd);
    return null;
  }
  return { ...row, port };
}

export function connectMux(port, request = SNDBUF_REQUEST) {
  const fn = loadHelper();
  if (!fn || typeof fn.connectPinned !== 'function' || !positive(port)) return null;
  try {
    return muxRow(fn.connectPinned(port, request));
  } catch {
    return null;
  }
}

export function dupFd(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.dupFd !== 'function') return null;
  try {
    return asFd(fn.dupFd(fd));
  } catch {
    return null;
  }
}

export function rcvbuf(fd) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.rcvbuf !== 'function') return null;
  try {
    return positive(fn.rcvbuf(fd));
  } catch {
    return null;
  }
}

export function wrapperPath() {
  const fn = loadHelper();
  return typeof fn?.wrapper === 'string' ? fn.wrapper : null;
}

let subreaperOn = false;

export function ensureSubreaper() {
  if (subreaperOn) return true;
  const fn = loadHelper();
  if (!fn || typeof fn.setSubreaper !== 'function') return false;
  try {
    fn.setSubreaper();
    subreaperOn = true;
    return true;
  } catch {
    return false;
  }
}

export function setGroup(pid, pgid) {
  if (!Number.isInteger(pid) || pid < 0 || !positive(pgid)) return false;
  const fn = loadHelper();
  if (!fn || typeof fn.setGroup !== 'function') return false;
  try {
    fn.setGroup(pid, pgid);
    return true;
  } catch {
    return false;
  }
}

export function processGroup(pid) {
  if (!Number.isInteger(pid) || pid < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.processGroup !== 'function') return null;
  try {
    return positive(fn.processGroup(pid));
  } catch {
    return null;
  }
}

export function reapGroup(pgid) {
  if (!positive(pgid)) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.reapGroup !== 'function') return null;
  try {
    const n = fn.reapGroup(pgid);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function spawnSleeper(pgid) {
  if (!positive(pgid)) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.spawnSleeper !== 'function') return null;
  try {
    return positive(fn.spawnSleeper(pgid));
  } catch {
    return null;
  }
}

export function probeConfinement() {
  const fn = loadHelper();
  if (!fn || typeof fn.probeConfinement !== 'function') return null;
  try {
    return fn.probeConfinement();
  } catch {
    return null;
  }
}

export function measureFlowReserve() {
  if (reserve) return reserve;
  const ends = createChildEnds();
  const mux = openMuxListener();
  if (!ends || !mux) {
    closeEnds(ends);
    closeFd(mux?.fd);
    return null;
  }
  reserve = {
    sndbufIn: ends.sndbufIn,
    sndbufOut: ends.sndbufOut,
    kIn: ends.kIn,
    kOut: ends.kOut,
    readBytes: FLOW_READ_BYTES,
    perChild: ends.kIn + ends.kOut + FLOW_READ_BYTES,
    muxSndbuf: mux.sndbuf,
    muxRcvbuf: mux.rcvbuf,
    kMuxIn: mux.kIn,
    kMuxOut: mux.kOut,
    muxReserve: mux.kIn + mux.kOut + FLOW_READ_BYTES,
  };
  closeEnds(ends);
  closeFd(mux.fd);
  return reserve;
}
