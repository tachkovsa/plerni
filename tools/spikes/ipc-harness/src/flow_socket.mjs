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
const undumpSource = fileURLToPath(new URL('./undump.c', import.meta.url));

let helper = null;
let failed = false;
let reserve = null;

export function sourceHash(text = null) {
  const body = text == null
    ? Buffer.concat([
      readFileSync(socketSource),
      Buffer.from('\0'),
      readFileSync(confineSource),
      Buffer.from('\0'),
      readFileSync(undumpSource),
    ])
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
    '-pthread',
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

function publishUndump(dir) {
  const finalName = join(dir, 'undump.so');
  const tmpName = join(dir, `.undump.${process.pid}.${randomBytes(8).toString('hex')}.so`);
  return publishFile(dir, finalName, tmpName, ['-shared', '-fPIC', '-O2', '-o', tmpName, undumpSource]);
}

function sealVerified(fn, path) {
  if (!fn || typeof fn.sealFile !== 'function' || typeof path !== 'string') return null;
  try {
    const fd = fn.sealFile(path);
    if (!Number.isInteger(fd) || fd < 0) return null;
    const seals = fn.fileSeals(fd);
    // F_SEAL_WRITE | F_SEAL_SEAL. A later write to this inode must fail.
    if (!Number.isInteger(seals) || (seals & 0x0008) === 0 || (seals & 0x0001) === 0) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
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
    const wrapper = join(dir, 'confine');
    const preload = join(dir, 'undump.so');
    try {
    let target = null;
    let confine = null;
    let undump = null;
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
    try {
      if (entryIsPrivate(lstatSync(preload), uid, 'file')) undump = preload;
    } catch {
      undump = null;
    }
    if (!target) target = publishBinary(dir, headers);
    if (!confine) confine = publishWrapper(dir);
    if (!undump) undump = publishUndump(dir);
    if (!target || !confine || !undump
        || !entryIsPrivate(lstatSync(target), uid, 'file')
        || !entryIsPrivate(lstatSync(confine), uid, 'file')
        || !entryIsPrivate(lstatSync(undump), uid, 'file')) {
      failed = true;
      return null;
    }
    const loaded = require(target);
    const wrapperFd = sealVerified(loaded, confine);
    const undumpFd = sealVerified(loaded, undump);
    if (wrapperFd == null || undumpFd == null) {
      failed = true;
      return null;
    }
    loaded.wrapper = confine;
    loaded.wrapperFd = wrapperFd;
    loaded.undumpFd = undumpFd;
    helper = loaded;
    return helper;
  } catch {
    failed = true;
    return null;
  }
}

function asFd(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// readFd is what the child inherits. probe is a dup of that read end and
// stays in the parent so FIONREAD still sees unread bytes after the write
// end closes. A null result is a failed helper, not an empty pipe.
export function openEnvPipe() {
  const fn = loadHelper();
  if (!fn || typeof fn.openPipe !== 'function') return null;
  let row = null;
  try {
    row = fn.openPipe();
  } catch {
    return null;
  }
  const readFd = asFd(row?.readFd);
  const writeFd = asFd(row?.writeFd);
  const probe = asFd(row?.probe);
  if (readFd == null || writeFd == null || probe == null) {
    closeFd(readFd);
    closeFd(writeFd);
    closeFd(probe);
    return null;
  }
  return { readFd, writeFd, probe };
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

function ioctlCount(fd, method) {
  if (!Number.isInteger(fd) || fd < 0) return null;
  const fn = loadHelper();
  if (!fn || typeof fn[method] !== 'function') return null;
  try {
    const count = fn[method](fd);
    if (!Number.isInteger(count) || count < 0) return null;
    return count;
  } catch {
    return null;
  }
}

export function fionread(fd) {
  return ioctlCount(fd, 'pending');
}

export function siocoutq(fd) {
  return ioctlCount(fd, 'outq');
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
  // Loopback TCP: the getsockopt read-back is K_mux. tcp(7) requires the
  // size before connect or listen, and the doubled value is what getsockopt
  // returns. The AF_UNIX half-skb formula is not this ceiling (ADR-0006).
  return { fd, sndbuf: snd, rcvbuf: rcv, kIn: rcv, kOut: snd };
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

export function sealedWrapperFd() {
  const fn = loadHelper();
  return asFd(fn?.wrapperFd);
}

export function sealedUndumpFd() {
  const fn = loadHelper();
  return asFd(fn?.undumpFd);
}

export function fileSeals(fd) {
  const fn = loadHelper();
  if (!fn || typeof fn.fileSeals !== 'function' || !Number.isInteger(fd) || fd < 0) return null;
  try {
    const seals = fn.fileSeals(fd);
    return Number.isInteger(seals) && seals >= 0 ? seals : null;
  } catch {
    return null;
  }
}

let subreaperOn = false;

export function ensureSubreaper() {
  if (subreaperOn) return true;
  const fn = loadHelper();
  if (!fn || typeof fn.setSubreaper !== 'function' || typeof fn.setDumpable !== 'function') return false;
  try {
    fn.setSubreaper();
    fn.setDumpable();
    subreaperOn = true;
    return true;
  } catch {
    return false;
  }
}

export function dumpable() {
  const fn = loadHelper();
  if (!fn || typeof fn.dumpable !== 'function') return null;
  try {
    const value = fn.dumpable();
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function flowHelperAvailable() {
  const fn = loadHelper();
  return Boolean(fn && typeof fn.create === 'function' && typeof fn.pinListen === 'function');
}

export function burstWriters(fd, ceiling, mark, threads = 4) {
  if (!Number.isInteger(fd) || fd < 0 || !Number.isInteger(ceiling) || ceiling <= 0) return null;
  if (typeof mark !== 'string' || mark.length === 0) return null;
  if (!Number.isInteger(threads) || threads < 2 || threads > 32) return null;
  const fn = loadHelper();
  if (!fn || typeof fn.burstWriters !== 'function') return null;
  try {
    const row = fn.burstWriters(fd, ceiling, mark, threads);
    if (!row || !Number.isInteger(row.written) || row.written < 0) return null;
    return row;
  } catch {
    return null;
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
