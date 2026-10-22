// supervisor.mjs — spawn children, stamp identity from the spawn-time credential
// before multiplexing, bind the per-plugin capability credential, run the sweeper.
// Child-supplied plugin ids are untrusted hints (plan §4 B6, spec §4.4).
// stampIdentity:false is the vacuity variant: it trusts the hint and must fail B6.
// enforcePartial:false is the partial-cap vacuity variant: the unfinished frame
// is flagged and kept, and only the framer's 1 MiB NdjsonOversizeError stops it.
//
// Caps are per plugin, with a global ceiling. Pending entries expire on a
// deadline. The high-priority mux queue is per plugin and faults the child
// that overflows it with frames the child itself produced. Kernel-side
// admission rejections are coalesced so they cannot fill that queue.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { closeSync, write, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { MuxFramer, NdjsonFramer, MAX_RESIDUAL, STDOUT_KIND_PREFIX, classifyStdoutLine, encodeNdjson, encodeMux } from './framing.mjs';
import { PendingTable, socketPair, KernelStub } from './kernel-stub.mjs';
import { FencedError, commitExecution, startSweeper } from './authority.mjs';
import { pipePending } from './pipe_pending.mjs';
import { BUFFER_ENLARGED, FLOW_READ_BYTES, PROBE_INTERVAL_MS, THREAD_WRITER, writerOverrun } from './flow_budget.mjs';
import {
  closeEnds,
  closeFd,
  createChildEnds,
  ensureSubreaper,
  fionread,
  openEnvPipe,
  rcvbuf,
  reapGroup,
  siocoutq,
  sndbuf,
  sealedUndumpFd,
  sealedWrapperFd,
} from './flow_socket.mjs';

export { partialCapHolds, totalCapHolds } from './flow_budget.mjs';

// A stuck write end must not hold the reservation forever. EOF or stream
// close releases it first; this deadline is the bound when neither arrives.
export const EXIT_DRAIN_MS = 1000;

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }, 2_000);
    // SIGKILL is not success by itself; wait for exit, then give up.
    const giveUp = setTimeout(finish, 3_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      finish();
    });
  });
}

export const HARD_FRAME = 1024 * 1024;

// One stdout slice handed to the framer. With flow control this is C, the
// onread buffer. The cap reserves K plus this slice; it is not an allowance
// to pass the cap.
export const PARTIAL_READ_CHUNK = FLOW_READ_BYTES;

export const DEFAULT_CAPS = Object.freeze({
  pending: 32,
  pendingGlobal: 256,
  cancels: 64,
  partial: 64 * 1024,
  total: 256 * 1024,
  totalGlobal: 1024 * 1024,
  hi: 32,
  lo: 32,
});

const DEFAULT_DEADLINE_MS = 5_000;
// Rejections for a plugin id with no live child share one queue. A peer that
// invents ids cannot open an unbounded set of high-priority queues. A Symbol
// cannot be a plugin id, so it cannot collide with one that contains NUL.
const UNBOUND_QUEUE = Symbol('unbound');

// Bytes retained for a plugin id and correlation id until the pending entry
// leaves. The stdin write that carried them is released when the child reads.
function identifierBytes(pluginId, correlationId) {
  const left = JSON.stringify(pluginId);
  const right = JSON.stringify(correlationId);
  return Buffer.byteLength(left ?? '') + Buffer.byteLength(right ?? '');
}

export function dbConfigured() {
  return Boolean(process.env.HARNESS_DIRECT_DSN || process.env.PLERNI_APP_PASSWORD);
}

export function useDirectFromEnv() {
  if (process.env.SPIKE_USE_DIRECT === '1') return true;
  return Boolean(process.env.HARNESS_DIRECT_DSN) && !process.env.HARNESS_POOLED_DSN;
}

function secretMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sameGrants(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function copyGrants(grants) {
  if (grants === undefined) return Object.freeze(['*']);
  if (!Array.isArray(grants)) {
    const err = new Error('grants must be an array');
    err.code = 'invalid-grants';
    throw err;
  }
  return Object.freeze(grants.map((grant) => String(grant)));
}

function detachCredential(credential) {
  return {
    pluginId: credential.pluginId,
    version: credential.version,
    grants: [...credential.grants],
    generation: credential.generation,
    secret: credential.secret,
  };
}

// The wrapper is dynamically linked. Its own environment is only PATH, so a
// plugin cannot point the loader at code that runs before NO_NEW_PRIVS.
// Plugin variables are applied after the filter, and LD_* never comes from
// the plugin: the wrapper forces LD_PRELOAD to the sealed preload.
const LOADER_ENV = /^(LD_.*|DYLD_.*)$/;

export function wrapperLaunchEnv() {
  return { PATH: process.env.PATH || '' };
}

// apply_fd_env grows to 256 KiB and then fails when len == cap, before the
// read that would observe EOF. A block of that size is not readable.
export const PLUGIN_ENV_MAX = 256 * 1024;

// One exec string, including `key=`, the value, and the NUL. Linux rejects a
// string longer than MAX_ARG_STRLEN (32 pages; 128 KiB when the page is 4 KiB).
export const PLUGIN_ENV_ENTRY_MAX = 128 * 1024;

export function pluginEnvBlock(specEnv, pluginId) {
  const entries = [];
  const push = (key, value) => {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if (LOADER_ENV.test(key)) return;
    const entry = `${key}=${envText(value)}\0`;
    // execve fails E2BIG for one string above MAX_ARG_STRLEN. Reject that
    // before the wrapper is started, with the same code as an oversize block.
    if (Buffer.byteLength(entry) >= PLUGIN_ENV_ENTRY_MAX) {
      const err = new Error('plugin environment does not fit the wrapper');
      err.code = 'env-rejected';
      throw err;
    }
    entries.push(entry);
  };
  push('PATH', process.env.PATH || '');
  if (specEnv && typeof specEnv === 'object') {
    for (const [key, value] of Object.entries(specEnv)) push(key, value);
  }
  push('PLERNI_PLUGIN_ID', envText(pluginId));
  const buf = Buffer.from(entries.join(''), 'utf8');
  if (buf.length >= PLUGIN_ENV_MAX) {
    const err = new Error('plugin environment does not fit the wrapper');
    err.code = 'env-rejected';
    throw err;
  }
  return buf;
}

// A short block is written and closed before this returns, so the wrapper
// sees EOF even if the caller then blocks the event loop. A block larger
// than the pipe is finished on the threadpool. `owner` keeps that descriptor
// until the threadpool callback settles: cancellation sets owner.aborted and
// must not close or reuse the number while owner.writing is set, or the
// callback would close or write whatever was opened on the same number.
export function writePluginEnv(fd, buf, owner = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const owns = () => !owner || owner.writeFd === fd;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (owner) owner.writing = false;
      if (owns()) {
        if (owner) owner.writeFd = -1;
        try { closeSync(fd); }
        catch (closeErr) {
          if (closeErr.code !== 'EBADF' && !(err && (err.code === 'EPIPE' || err.code === 'EBADF'))) {
            reject(closeErr);
            return;
          }
        }
      }
      if (err && err.code !== 'EPIPE' && err.code !== 'EBADF') reject(err);
      else resolve();
    };
    const onChunk = (err, n) => {
      // A cancellation that already released the descriptor must not write
      // the rest or close the number the kernel gave to someone else.
      if (owner && (owner.aborted || owner.writeFd !== fd)) {
        const error = new Error('plugin environment write cancelled');
        error.code = 'EPIPE';
        finish(err && (err.code === 'EPIPE' || err.code === 'EBADF') ? err : error);
        return;
      }
      if (err) {
        finish(err);
        return;
      }
      if (!Number.isInteger(n) || n <= 0) {
        const error = new Error('plugin environment was not written');
        error.code = 'env-rejected';
        finish(error);
        return;
      }
      off += n;
      if (off >= buf.length) finish(null);
      else write(fd, buf, off, buf.length - off, onChunk);
    };
    let off = 0;
    try {
      // One syscall. A larger request blocks until the reader drains it,
      // which never happens when spawn fails before the wrapper runs.
      const n = writeSync(fd, buf, 0, Math.min(buf.length, 4096));
      if (!Number.isInteger(n) || n <= 0) {
        const error = new Error('plugin environment was not written');
        error.code = 'env-rejected';
        finish(error);
        return;
      }
      off = n;
    } catch (err) {
      finish(err);
      return;
    }
    if (off >= buf.length) finish(null);
    else {
      if (owner) owner.writing = true;
      write(fd, buf, off, buf.length - off, onChunk);
    }
  });
}

// One cancel and one window-update, reserved together. Credit is capped so
// the grant's encoded size cannot grow past this reservation.
export function stdinControlReserve() {
  const grant = Buffer.byteLength(encodeNdjson({ kind: 'grant', credit: 2147483647 }));
  const cancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId: 0 }));
  return { grant, cancel, total: grant + cancel };
}

const CONTROL_RESERVE = stdinControlReserve();

// `pending` is the unterminated tail already in the framer. `charged` is how
// many bytes of that tail have already left the send window. Cancel acks and
// grant lines do not leave it. The kind is the top-level field, the same
// classifier credit-wait and credit-response use before they decrement.
function accountStdoutCredit(pending, chunk, charged) {
  const pendingLen = pending?.length ?? 0;
  const combined = pendingLen > 0 ? Buffer.concat([pending, chunk]) : chunk;
  let spend = 0;
  let refund = 0;
  let openCharged = charged > 0 ? charged : 0;
  let offset = 0;
  while (offset < combined.length) {
    const info = classifyStdoutLine(combined.subarray(offset));
    const lineLen = info.length;
    if (info.complete) {
      if (info.control) {
        if (openCharged > 0) refund += openCharged;
      } else {
        const need = lineLen - openCharged;
        if (need > 0) spend += need;
      }
      openCharged = 0;
      offset += lineLen;
      continue;
    }
    if (info.control) {
      if (openCharged > 0) refund += openCharged;
      openCharged = 0;
    } else if (info.kind != null || lineLen > STDOUT_KIND_PREFIX) {
      const need = lineLen - openCharged;
      if (need > 0) {
        spend += need;
        openCharged = lineLen;
      }
    } else if (openCharged > 0) {
      refund += openCharged;
      openCharged = 0;
    }
    break;
  }
  return { spend, refund, charged: openCharged };
}

// The idle grant cannot see the call that will sit beside it. This slot is
// one 1024-byte call, its identifiers, and the control reserve, so the next
// admission still fits in B_t and B_g. A larger call raises the per-child
// slot. The slot is subtracted from the free room; it is not a higher ceiling.
function admissionKeepFloor() {
  const correlationId = 480000;
  const line = encodeNdjson({
    kind: 'call',
    correlationId,
    port: 'db',
    method: 'get',
    payload: 'x'.repeat(1024),
  });
  const bytes = Buffer.byteLength(line);
  const idBytes = identifierBytes('echo-0', correlationId);
  const cancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId }));
  // The cancel lane retains its own copy of the identifiers. That copy is
  // userspace, not a second stdin frame, and the idle grant still leaves it.
  return bytes + idBytes + idBytes + CONTROL_RESERVE.grant + Math.max(CONTROL_RESERVE.cancel, cancel);
}

const ADMIT_KEEP = admissionKeepFloor();

// A correct sender waits until the advertised window covers its next reply.
// The half-room threshold coalesces open-loop grants. If the child stops
// while the spent part is still under half the room, that reply never
// starts. Quiet stdout flushes the withheld deficit. Further stdout
// postpones the flush, and not past the max.
const CREDIT_FLUSH_QUIET_MS = 40;
const CREDIT_FLUSH_MAX_MS = 1000;

// Process environment values are strings and cannot carry a NUL. The spawn
// map key keeps the original plugin id; this text is only the child hint.
function envText(value) {
  return String(value).replaceAll('\0', '');
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// A mux socket can be dup'd onto fd 0 when standard input is closed. Zero is
// a real descriptor. Buffer sizes stay strictly positive.
function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export class Supervisor {
  constructor(mux, opts = {}) {
    const muxFd = nonNegativeInt(mux?.fd);
    this.kMuxIn = positiveInt(mux?.kMuxIn);
    this.kMuxOut = positiveInt(mux?.kMuxOut);
    this.muxSndbuf = positiveInt(mux?.muxSndbuf);
    this.muxRcvbuf = positiveInt(mux?.muxRcvbuf);
    if (muxFd == null || this.kMuxIn == null || this.kMuxOut == null
        || this.muxSndbuf == null || this.muxRcvbuf == null) {
      const err = new Error('mux reservation unavailable');
      err.code = 'flow-unavailable';
      throw err;
    }
    this.muxFd = muxFd;
    this.muxReadHigh = 0;
    this.stampIdentity = opts.stampIdentity !== false;
    this.enforcePartial = opts.enforcePartial !== false;
    // enforceFlow:false is the vacuity variant: default stdio sockets and
    // libuv's 64 KiB reads. That run must fail the reserved-cap bound.
    this.enforceFlow = opts.enforceFlow !== false;
    this.readBytes = FLOW_READ_BYTES;
    this.socket = new Socket({
      fd: muxFd,
      allowHalfOpen: true,
      readable: true,
      writable: true,
      onread: {
        buffer: Buffer.alloc(this.readBytes),
        callback: (nread, buf) => this.#onMuxRead(nread, buf),
      },
    });
    this.socket.setNoDelay(true);
    this.pipeProbe = typeof opts.pipeProbe === 'function' ? opts.pipeProbe : pipePending;
    this.flowPending = typeof opts.flowPending === 'function' ? opts.flowPending : fionread;
    this.muxPending = typeof opts.muxPending === 'function' ? opts.muxPending : fionread;
    this.muxOutq = typeof opts.muxOutq === 'function' ? opts.muxOutq : siocoutq;
    this.readSndbuf = typeof opts.readSndbuf === 'function' ? opts.readSndbuf : sndbuf;
    this.readRcvbuf = typeof opts.readRcvbuf === 'function' ? opts.readRcvbuf : rcvbuf;
    this.readMuxSndbuf = typeof opts.readMuxSndbuf === 'function' ? opts.readMuxSndbuf : sndbuf;
    this.readMuxRcvbuf = typeof opts.readMuxRcvbuf === 'function' ? opts.readMuxRcvbuf : rcvbuf;
    this.exitDrainMs = Number.isInteger(opts.exitDrainMs) && opts.exitDrainMs >= 0
      ? opts.exitDrainMs
      : EXIT_DRAIN_MS;
    this.invalidReason = null;
    this.flip = null;
    this.muxSendTimer = null;
    this.muxSendLast = null;
    this.muxSendSpins = 0;
    this.useDirect = opts.useDirect ?? useDirectFromEnv();
    this.capsConfig = { ...DEFAULT_CAPS, ...opts.caps };
    if (opts.caps?.pending != null && opts.caps.pendingGlobal == null) {
      this.capsConfig.pendingGlobal = Math.max(DEFAULT_CAPS.pendingGlobal, this.capsConfig.pending);
    }
    if (opts.caps?.total != null && opts.caps.totalGlobal == null) {
      this.capsConfig.totalGlobal = Math.max(this.capsConfig.total, DEFAULT_CAPS.totalGlobal);
    }
    this.partialHighWater = opts.partialHighWater ?? this.capsConfig.partial;
    this.partialLowWater = opts.partialLowWater ?? Math.floor(this.partialHighWater / 2);
    this.children = new Map();
    this.pending = new PendingTable();
    // Correlation ids that already timed out in this generation. A late reply
    // must not satisfy a newer waiter that reused the id. Cleared when the
    // generation is retired.
    this.stale = new PendingTable();
    this.callPendingTotal = 0;
    this.cancelPendingTotal = 0;
    this.retiredTokens = new Set();
    this.faults = [];
    this.bufferedHighWater = 0;
    this.caps = { pending: false, partial: false, total: false, lo: false, hi: false };
    this.hi = new Map();
    this.lo = new Map();
    this.hiOrder = [];
    this.loOrder = [];
    this.hiTurn = 0;
    this.loTurn = 0;
    this.terminal = [];
    this.terminalCoalesced = 0;
    // One delivered terminal error per child during a single failure burst.
    // Cleared on the next turn so a later timeout can still be reported.
    this.terminalChild = new Set();
    this.terminalChildClear = false;
    this.queuedBytes = 0;
    // Bytes accepted by socket.write until the flush callback. They have left
    // the mux queues and are not visible in queuedBytes.
    this.socketOutbound = 0;
    this.draining = false;
    this.respawnTail = new Map();
    this.inputPaused = false;
    this.unknownRejectQueued = false;
    this.unknownRejectsCoalesced = 0;
    this.closed = false;
    this.framingFault = null;
    this.bulkSeen = 0;
    this.answered = 0;
    this.bridge = new MuxFramer();
    this.wrapperFd = sealedWrapperFd();
    this.undumpFd = sealedUndumpFd();
    // Child fd 3 is the sealed wrapper. Child fd 4 is the sealed preload.
    // The cache path is not an exec target: a same-uid plugin can replace it.
    this.wrapper = this.wrapperFd != null && this.undumpFd != null ? '/proc/self/fd/3' : null;
    this.confined = ensureSubreaper() && this.wrapper != null;
    const sweep = opts.sweeper ?? false;
    this.stopSweeper = sweep ? startSweeper(this.useDirect) : () => {};
    this.socket.on('error', () => {});
    this.muxReadPosted = false;
    this.muxProbeTimer = null;
    this.socket.pause();
    this.#armMuxProbe();
    setImmediate(() => this.#considerMuxRead());
  }

  spawn(spec) {
    if (this.children.has(spec.pluginId)) {
      const err = new Error(`plugin ${spec.pluginId} is already live`);
      err.code = 'duplicate-plugin';
      throw err;
    }
    const grants = copyGrants(spec.grants);
    const credential = {
      pluginId: spec.pluginId,
      version: spec.version ?? '0.0.0',
      grants,
      generation: spec.generation ?? 1,
      secret: randomBytes(16).toString('hex'),
    };
    const token = randomBytes(16).toString('hex');
    const limits = {
      pending: spec.pending ?? this.capsConfig.pending,
      total: spec.total ?? this.capsConfig.total,
    };
    if (!this.wrapper || !this.confined) {
      const err = new Error('confinement wrapper unavailable');
      err.code = 'flow-unavailable';
      throw err;
    }
    // Reject an unreadable block before any descriptor is opened.
    const envBlock = pluginEnvBlock(spec.env, spec.pluginId);
    const flow = this.enforceFlow ? this.#openFlowEnds(limits, envBlock.length) : null;
    if (this.enforceFlow && !flow) {
      const err = new Error('flow-control helper unavailable');
      err.code = 'flow-unavailable';
      throw err;
    }
    const envEnds = openEnvPipe();
    if (!envEnds) {
      closeEnds(flow);
      const err = new Error('environment pipe unavailable');
      err.code = 'flow-unavailable';
      throw err;
    }
    // fd 5 stays readable on `probe` after the write end closes, so the
    // unread block remains inside bufferedBytes() until the wrapper reads it.
    const envHold = {
      bytes: envBlock.length,
      // A synchronous burst still owes the block. After the write has
      // finished and the spawn turn has ended, only what the probe still
      // shows is counted.
      settle: false,
      written: false,
      turnDone: false,
      aborted: false,
      // Set while the threadpool write owns writeFd. #clearEnv must not
      // close that number until the callback settles.
      writing: false,
      probe: envEnds.probe,
      writeFd: envEnds.writeFd,
    };
    let child;
    try {
      // fd 2 is /dev/null. The wrapper sets the process group, NO_NEW_PRIVS,
      // and the seccomp filter, then execs the runtime. fd 3 and fd 4 stay
      // the sealed binaries. fd 5 is the plugin environment, read only after
      // the filter is installed.
      child = spawn(this.wrapper, [process.execPath, spec.script], {
        stdio: [
          flow ? flow.childStdin : 'pipe',
          flow ? flow.childStdout : 'pipe',
          'ignore',
          this.wrapperFd,
          this.undumpFd,
          envEnds.readFd,
        ],
        env: wrapperLaunchEnv(),
      });
      closeFd(envEnds.readFd);
      envEnds.readFd = -1;
    } catch (err) {
      closeFd(envEnds.readFd);
      closeFd(envEnds.writeFd);
      closeFd(envEnds.probe);
      envHold.probe = null;
      if (child && child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      closeEnds(flow);
      throw err;
    }
    setImmediate(() => {
      envHold.turnDone = true;
      // The unread block can pause the mux before the wrapper reads it.
      // Recounting here opens the input once that block is gone. The full
      // block stays reserved until the async write has finished.
      if (!envHold.written || envHold.aborted || this.closed) return;
      envHold.settle = true;
      this.#maybeResumeAll();
    });
    if (flow) {
      closeFd(flow.childStdin);
      closeFd(flow.childStdout);
      flow.childStdin = -1;
      flow.childStdout = -1;
    }
    const rec = {
      child,
      credential,
      token,
      script: spec.script,
      env: spec.env,
      limits,
      framer: new NdjsonFramer(),
      outbound: 0,
      stdinControl: [],
      stdinPayload: [],
      stdinWriting: false,
      creditSent: 0,
      // Bytes of advertised credit stdout has already consumed. sendWindow
      // plus this is creditSent: the grant is not rewritten downward.
      creditSpent: 0,
      // Bytes of the open stdout line already taken from sendWindow. Control
      // lines refund this. A later chunk of a data line does not spend it twice.
      stdoutCreditCharged: 0,
      // Bytes the child may still write. Grants raise it. Data stdout lowers
      // it by the same amount. A refill adds new credit; it does not shrink
      // credit the child has not spent. Cancel acks and grant lines do not.
      sendWindow: 0,
      // Largest call cost currently reserved. A rejected call does not keep
      // its cost. admitFloor is the largest cost that finished without rejection.
      admitKeep: 0,
      admitFloor: 0,
      // Stdout frames still being applied. Parked calls stay put until that
      // read has been parsed, so a cancel ack in the same chunk is first.
      childReads: 0,
      parked: [],
      parkedBytes: 0,
      parkTimer: null,
      parkDraining: false,
      stash: null,
      inFlightTailBytes: 0,
      hiBytes: 0,
      loBytes: 0,
      callPending: 0,
      cancelPending: 0,
      idBytes: 0,
      deferred: [],
      deferredBytes: 0,
      dead: false,
      exited: false,
      paused: false,
      pauseReason: null,
      // The global gate withheld a read without pausing. The probe still has
      // to see stdoutUnread > K_in.
      readHeld: false,
      exitCode: null,
      rejectQueued: false,
      rejectsCoalesced: 0,
      flow,
      kIn: flow?.kIn ?? null,
      kOut: flow?.kOut ?? null,
      sndbufIn: flow?.sndbufIn ?? null,
      sndbufOut: flow?.sndbufOut ?? null,
      stdinFd: flow?.parentStdin ?? null,
      bP: flow?.bP ?? null,
      bT: flow?.bT ?? null,
      flowOk: Boolean(flow),
      stdoutFd: flow?.parentStdout ?? null,
      stdinProbe: flow?.stdinProbe ?? null,
      stdoutWriter: flow?.stdoutWriter ?? null,
      probeTimer: null,
      readPosted: false,
      // One deferred grant per child. Same-turn admissions are in the
      // accounted room before it runs. A short follow of a shrinking burst
      // does not continue while the mux stays unread.
      refillArmed: false,
      // Withheld credit (spent, not yet re-advertised) while the child still
      // holds at least half the room. Quiet stdout flushes it. The due time
      // is the latest that flush may wait.
      creditFlush: null,
      creditFlushDue: null,
      envHold,
      groupSignaled: false,
      exitDrain: false,
      exitFinished: false,
      exitDrainTimer: null,
      exitOverrun: null,
      reapTimer: null,
      resolveExit: () => {},
    };
    rec.exitDone = new Promise((resolve) => { rec.resolveExit = resolve; });
    if (flow) this.#attachFlowSockets(rec, flow);
    else {
      child.stdout.on('data', (chunk) => this.#onChild(rec, chunk));
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
    }
    child.on('error', (err) => this.#onSpawnError(rec, err));
    child.on('exit', (code, signal) => this.#onExit(rec, code, signal));
    this.children.set(spec.pluginId, rec);
    // A full pipe must not block this turn. The wrapper reads fd 5 after
    // the filter; if spawn then fails, the writer is cancelled and closes
    // the write end itself once the threadpool operation settles.
    writePluginEnv(envHold.writeFd, envBlock, envHold).then(() => {
      envHold.writeFd = -1;
      if (envHold.aborted || this.closed) return;
      envHold.written = true;
      if (!envHold.turnDone) return;
      envHold.settle = true;
      this.#maybeResumeAll();
    }, (err) => {
      envHold.writeFd = -1;
      if (envHold.aborted || this.closed || rec.dead) return;
      if (!err.code) err.code = 'env-rejected';
      this.#onSpawnError(rec, err);
    });
    if (rec.flowOk) {
      this.#armProbe(rec);
      // The caller can pause before this turn ends. The read is posted only
      // after the gate, on a later turn.
      setImmediate(() => this.#considerRead(rec));
    }
    // The grant is this child's share of the free room after calls already
    // written. Unspent credit stays reserved and is not retracted. A child
    // that is already live keeps the share it was advertised.
    this.#refillCredit(rec);
    return { credential: detachCredential(credential), token, pid: child.pid };
  }

  // A negative B_p, B_t, or B_g closes the ends and does not start the child.
  // That rejection is unsatisfiable when the kernel terms alone do not fit.
  // A live process that is already too full is spawn-rejected, which is not
  // a B3 cap failure. K_mux_in + K_mux_out + C is reserved once for the process.
  #openFlowEnds(limits, envBytes) {
    const ends = createChildEnds();
    if (!ends) return null;
    const muxReserve = this.#muxReserve();
    if (muxReserve <= 0) {
      closeEnds(ends);
      return null;
    }
    const bP = this.partialHighWater - ends.kIn - this.readBytes;
    const bT = limits.total - ends.kIn - ends.kOut - this.readBytes;
    const reserve = ends.kIn + ends.kOut + this.readBytes;
    const already = this.#kernelReserved();
    if (bP < 0 || bT < 0 || already + reserve + muxReserve > this.capsConfig.totalGlobal) {
      closeEnds(ends);
      const err = new Error('flow reservation does not fit the configured caps');
      err.code = 'unsatisfiable';
      throw err;
    }
    // Empty kernel queues still owe K_in + K_out + C. The fd 5 block is
    // owed as well until the wrapper reads it. Credit already granted to a
    // live child is stdout that child may still write, and it is not in
    // bufferedBytes() until it arrives. Admit only when userspace bytes,
    // that block, those promises, every live reservation, the new
    // reservation, and the mux reservation fit in totalGlobal.
    const owed = Number.isInteger(envBytes) && envBytes > 0 ? envBytes : 0;
    if (this.#globalHeld(null) + owed + already + reserve + muxReserve > this.capsConfig.totalGlobal) {
      closeEnds(ends);
      const err = new Error('flow reservation does not fit the live process');
      err.code = 'spawn-rejected';
      throw err;
    }
    return { ...ends, bP, bT };
  }

  #muxReserve() {
    if (this.kMuxIn == null || this.kMuxOut == null) return 0;
    return this.kMuxIn + this.kMuxOut + this.readBytes;
  }

  #childReserve(rec) {
    if (!rec?.flowOk || rec.dead) return 0;
    return rec.kIn + rec.kOut + this.readBytes;
  }

  #kernelReserved() {
    let sum = 0;
    for (const rec of this.children.values()) sum += this.#childReserve(rec);
    return sum;
  }

  // Userspace room after every live child's K_in + K_out + C and the mux
  // reservation K_mux_in + K_mux_out + C.
  #globalCap() {
    return this.capsConfig.totalGlobal - this.#kernelReserved() - this.#muxReserve();
  }

  #attachFlowSockets(rec, flow) {
    const stdout = new Socket({
      fd: flow.parentStdout,
      readable: true,
      writable: false,
      onread: {
        buffer: Buffer.alloc(this.readBytes),
        callback: (nread, buf) => this.#onStdoutRead(rec, nread, buf),
      },
    });
    const stdin = new Socket({
      fd: flow.parentStdin,
      readable: false,
      writable: true,
    });
    stdout.on('error', () => {});
    stdin.on('error', () => {});
    // Real reads arrive through onread and do not emit 'data'. A manual
    // 'data' event is how tests inject bytes. Pause before the next turn so
    // the first read is the gated one.
    stdout.pause();
    stdout.on('data', (chunk) => {
      this.#applyStdout(rec, chunk);
    });
    rec.child.stdout = stdout;
    rec.child.stdin = stdin;
    rec.stdoutSocket = stdout;
    rec.stdinSocket = stdin;
  }

  #onStdoutRead(rec, nread, buf) {
    rec.readPosted = false;
    // Nested drain calls #considerRead. A resume() from there is cancelled
    // when this callback returns false, and readPosted would stay set. The
    // decision belongs at the end of this turn.
    rec.inStdoutRead = true;
    try {
      if (rec.dead || this.closed) {
        rec.stdoutSocket?.pause();
        return false;
      }
      if (typeof nread === 'number' && nread > 0) {
        this.#applyStdout(rec, Buffer.from(buf.subarray(0, nread)));
      }
      // Exit drain keeps reading until EOF. A budget pause here would leave
      // the final response in the kernel and the waiter on child-exited.
      if (rec.exitDrain && !rec.dead && !this.closed) {
        rec.readPosted = true;
        return true;
      }
      // FIONREAD here is the queue before the next read. Returning true keeps
      // that read in this I/O turn, so the mux drain cannot empty the
      // low-priority queue between chunks. Returning false stops the handle
      // without marking the stream paused, so pause() makes a later resume()
      // post again.
      if (this.#readPermitted(rec)) {
        rec.readPosted = true;
        return true;
      }
      rec.stdoutSocket?.pause();
      return false;
    } finally {
      rec.inStdoutRead = false;
    }
  }

  // Probe, then post at most one C-byte read. The onread turn returns true
  // itself; resume() here is for a later turn, after the callback has stopped.
  // A resume() inside the stdout callback is cancelled when that callback
  // returns false, and readPosted stays set. The socket is paused, the child
  // is not, and nothing posts the next read. That pair is not a budget hold.
  #repairStuckReads() {
    for (const rec of this.children.values()) {
      if (rec.dead || rec.paused || rec.inStdoutRead || !rec.readPosted) continue;
      const socket = rec.stdoutSocket;
      if (!socket || socket.destroyed || !socket.isPaused()) continue;
      rec.readPosted = false;
      this.#considerRead(rec);
    }
  }

  #considerRead(rec) {
    if (rec.inStdoutRead) return;
    if (rec.exitDrain) {
      if (rec.dead || this.closed || rec.readPosted) return;
      if (!rec.stdoutSocket || rec.stdoutSocket.destroyed) {
        this.#finishExit(rec);
        return;
      }
      rec.readPosted = true;
      rec.stdoutSocket.resume();
      return;
    }
    if (!this.#readPermitted(rec)) return;
    rec.readPosted = true;
    rec.stdoutSocket.resume();
  }

  #readPermitted(rec) {
    if (rec.dead || this.closed || !rec.flowOk || rec.paused || rec.readPosted) return false;
    const unread = this.#stdoutUnread(rec);
    if (unread == null) return false;
    if (this.invalidReason) return false;
    if (this.#noteOverrun(rec)) return false;
    const pending = rec.framer.pendingBytes();
    if (!rec.framer.hasPendingNewline() && pending > rec.bP && this.enforcePartial) {
      this.#accountReserved(rec);
      return false;
    }
    if (this.#pluginBytes(rec) > rec.bT) {
      this.#accountReserved(rec);
      return false;
    }
    // Credit is not in bufferedBytes(). Subtracting the open window from
    // this slice treats the response as free and lets bufferedBytes() pass
    // B_g once a mux frame already fills the room. A waiting read can pull
    // a full C. A queue that is already shorter than C only needs room for
    // that tail, so the last bytes of a response are not stuck behind C.
    const incoming = unread > 0 ? Math.min(this.readBytes, unread) : this.readBytes;
    if (this.bufferedBytes() + incoming > this.#globalCap()) {
      // A partial mux frame can be what filled this room. Fault that pair
      // here: the mux socket will not deliver another chunk while it is paused.
      this.#noteMuxBudget();
      // A child with nothing in userspace is still held. Pausing it would
      // wait for bytes it does not have; the probe has to run anyway.
      if (this.#pluginBytes(rec) > 0) this.#pause(rec, 'global');
      else this.#armProbe(rec);
      rec.readHeld = true;
      return false;
    }
    rec.readHeld = false;
    return true;
  }

  async respawn(pluginId) {
    const previous = this.respawnTail.get(pluginId) ?? Promise.resolve();
    const run = previous.then(
      () => this.#respawnOnce(pluginId),
      () => this.#respawnOnce(pluginId),
    );
    this.respawnTail.set(pluginId, run);
    try {
      return await run;
    } finally {
      if (this.respawnTail.get(pluginId) === run) this.respawnTail.delete(pluginId);
    }
  }

  // One respawn at a time per plugin. Overlapping callers used to snapshot the
  // same generation, then the later one deleted the newer map entry and left
  // that child running with a duplicate generation.
  async #respawnOnce(pluginId) {
    const prev = this.children.get(pluginId);
    if (!prev) throw new Error(`unknown plugin ${pluginId}`);
    this.retiredTokens.add(prev.token);
    const generation = prev.credential.generation + 1;
    const script = prev.script;
    const env = prev.env;
    const version = prev.credential.version;
    const grants = [...prev.credential.grants];
    const pending = prev.limits.pending;
    const total = prev.limits.total;
    try {
      if (prev.child.exitCode == null && prev.child.signalCode == null) {
        this.#signalGroup(prev);
        await waitExit(prev.child);
      }
      // The exit event leaves the stdout reservation in place until EOF or
      // the drain deadline. Deleting the record before that lets the next
      // spawn overlap the old kernel terms inside totalGlobal.
      if (!prev.exitFinished) await prev.exitDone;
      // Completed replies already left the pending table. Discarding them
      // here leaves the kernel waiter with nothing but a later timeout.
      const hiBytes = prev.hiBytes;
      const loBytes = prev.loBytes;
      this.#dropStale(pluginId, prev.credential.generation);
      this.children.delete(pluginId);
      const spawned = this.spawn({ pluginId, script, env, generation, version, grants, pending, total });
      const rec = this.children.get(pluginId);
      rec.hiBytes = hiBytes;
      rec.loBytes = loBytes;
      return spawned;
    } finally {
      // Once the old record is gone or dead, commitIfLive fences the token
      // because it is not a live spawn credential. Keeping every generation
      // would grow without a bound.
      if (!this.#tokenLive(prev.token)) this.retiredTokens.delete(prev.token);
    }
  }

  #tokenLive(token) {
    for (const rec of this.children.values()) {
      if (rec.token === token && !rec.dead && !rec.exited) return true;
    }
    return false;
  }

  tokenIsLive(token) {
    return this.#tokenLive(token);
  }

  // Refuses a token the crashed child held, and a token that is not the live spawn token.
  // The credential stops being live at the exit event, including while stdout is still draining.
  async commitIfLive(id, token, effects) {
    if (this.retiredTokens.has(token)) {
      throw new FencedError(`retired fencing token for id=${id}`);
    }
    if (!this.#tokenLive(token)) throw new FencedError(`token is not a live spawn credential for id=${id}`);
    return commitExecution(id, token, effects, this.useDirect);
  }

  // Framers and mux queues only. Stdout prefetch is excluded so a drained
  // low-priority queue can be refilled while that prefetch is still counted
  // in bufferedBytes().
  #acceptedBytes() {
    let total = this.queuedBytes + this.socketOutbound + this.bridge.pendingBytes();
    for (const rec of this.children.values()) {
      if (rec.dead) continue;
      total += rec.framer.pendingBytes();
      total += Math.max(0, rec.outbound);
      total += rec.parkedBytes;
      total += rec.idBytes;
      total += rec.deferredBytes;
      total += rec.stash?.length ?? 0;
    }
    return total;
  }

  bufferedBytes() {
    let total = this.#acceptedBytes();
    for (const rec of this.children.values()) {
      if (rec.dead) continue;
      total += this.#stdoutBuffered(rec);
      total += this.#envBuffered(rec);
    }
    return total;
  }

  // Unread bytes on the read-end probe. Through the end of the spawn turn
  // the whole block stays reserved, so a synchronous burst cannot pass
  // totalGlobal. After that, only bytes the wrapper has not read remain.
  #envBuffered(rec) {
    const hold = rec?.envHold;
    if (!hold || !(hold.bytes > 0)) return 0;
    const kernel = Number.isInteger(hold.probe) ? fionread(hold.probe) : null;
    if (kernel == null) return hold.bytes;
    if (!hold.settle) return Math.max(kernel, hold.bytes);
    if (kernel === 0) return this.#clearEnv(rec);
    return kernel;
  }

  #clearEnv(rec) {
    const hold = rec?.envHold;
    if (hold) {
      hold.aborted = true;
      hold.bytes = 0;
    }
    const probe = hold?.probe;
    if (hold) hold.probe = null;
    closeFd(probe);
    // The threadpool callback still has the descriptor. Closing it here
    // frees the number, and that callback would then close or write the
    // resource opened in its place. The callback closes it once, and only
    // while owner.writeFd still names this write.
    if (hold?.writing) return 0;
    const writeFd = hold?.writeFd;
    if (hold) hold.writeFd = -1;
    closeFd(writeFd);
    return 0;
  }

  queueDepth(pluginId) {
    const rec = this.children.get(pluginId);
    return {
      pending: rec?.callPending ?? 0,
      partial: rec?.framer.pendingBytes() ?? 0,
      pluginBytes: rec ? this.#pluginBytes(rec) : 0,
      hi: this.hi.get(pluginId)?.length ?? 0,
      lo: this.lo.get(pluginId)?.length ?? 0,
      outbound: rec?.outbound ?? 0,
    };
  }

  async close() {
    this.closed = true;
    this.#clearMuxProbe();
    this.stopSweeper();
    for (const rec of this.children.values()) this.#releaseFlow(rec);
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    const waits = [];
    for (const rec of this.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) this.#signalGroup(rec);
      waits.push(waitExit(rec.child));
    }
    this.socket.destroy();
    await Promise.all(waits);
    const reaps = [];
    for (const rec of this.children.values()) {
      // #onExit already started the quiet passes. Cancelling that timer
      // left a descendant that was not yet waitable as a zombie.
      if (!rec.reapDone) this.#armReap(rec);
      if (rec.reapTimer) rec.reapTimer.ref();
      if (rec.reapDone) reaps.push(rec.reapDone);
    }
    await Promise.all(reaps);
  }

  // Bytes pushed back with stdout.unshift sit in readableLength, not in stash.
  #stdoutBuffered(rec) {
    if (rec.dead) return 0;
    const n = rec.child?.stdout?.readableLength ?? 0;
    return n > 0 ? n : 0;
  }

  #pluginBytes(rec) {
    return rec.framer.pendingBytes()
      + Math.max(0, rec.outbound)
      + rec.parkedBytes
      + rec.hiBytes
      + rec.loBytes
      + rec.idBytes
      + rec.deferredBytes
      + (rec.stash?.length ?? 0)
      + this.#stdoutBuffered(rec);
  }

  // B_t while flow control is on. The configured total is the vacuity ceiling.
  #childCeiling(rec) {
    return this.enforceFlow && rec.flowOk ? rec.bT : rec.limits.total;
  }

  // One mux read is at most C. A read is posted only when muxUnread is inside
  // K_mux_in and the userspace sum has room for C. Returning false stops the
  // handle; the probe starts it again when the gate opens.
  #onMuxRead(nread, buf) {
    this.muxReadPosted = false;
    if (typeof nread === 'number' && nread > 0) {
      if (nread > this.readBytes) this.#flipMux('mux-read');
      if (nread > this.muxReadHigh) this.muxReadHigh = nread;
      this.#onSocket(buf.subarray(0, nread));
    }
    if (this.flip || this.invalidReason || !this.#muxReadPermitted()) return false;
    this.muxReadPosted = true;
    return true;
  }

  #muxCount(probe) {
    if (typeof probe !== 'function' || !Number.isInteger(this.muxFd)) return null;
    try {
      const count = probe(this.muxFd);
      return Number.isInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
  }

  #flipMux(reason) {
    if (!this.flip) this.flip = reason;
  }

  // Our own writes stop before they would put the kernel send queue over
  // K_mux_out. Bytes already handed to libuv are not in SIOCOUTQ yet; they
  // still belong to that reservation. A frame larger than the reservation
  // has to be handed to the socket, and libuv holds the tail. A kernel queue
  // that is already over the reservation is the flip, and K_mux_out is not raised.
  #muxWriteRoom(nextLen) {
    const queued = this.#muxCount(this.muxOutq);
    if (queued == null) {
      this.#invalidate('siocoutq-unavailable');
      return 'invalid';
    }
    if (queued > this.kMuxOut) {
      this.#flipMux('mux-send');
      return 'flip';
    }
    const pending = Math.max(0, this.socketOutbound);
    if (nextLen <= this.kMuxOut && queued + pending + nextLen > this.kMuxOut) return 'wait';
    return 'ok';
  }

  #waitMuxSend() {
    if (this.muxSendTimer || this.closed || this.framingFault) return;
    const queued = this.#muxCount(this.muxOutq);
    const dropped = Number.isInteger(queued) && Number.isInteger(this.muxSendLast) && queued < this.muxSendLast;
    if (Number.isInteger(queued)) this.muxSendLast = queued;
    const fire = () => {
      this.muxSendTimer = null;
      if (!this.closed && !this.framingFault) this.#drain();
    };
    // The first sample has no previous queue, so it is not a drop. A wait
    // that never sees the queue shrink backs off instead of spinning.
    if (dropped || this.muxSendSpins < 4) {
      this.muxSendSpins = dropped ? 0 : this.muxSendSpins + 1;
      this.muxSendTimer = setImmediate(fire);
      return;
    }
    this.muxSendTimer = setTimeout(fire, PROBE_INTERVAL_MS);
  }

  #clearMuxSendWait() {
    const timer = this.muxSendTimer;
    if (!timer) return;
    this.muxSendTimer = null;
    if (typeof timer._onTimeout === 'function') clearTimeout(timer);
    else clearImmediate(timer);
  }

  #muxReadPermitted() {
    if (this.inputPaused || this.closed || this.framingFault || this.flip || this.invalidReason) return false;
    const unread = this.#muxCount(this.muxPending);
    if (unread == null) {
      this.#invalidate('fionread-unavailable');
      return false;
    }
    if (unread > this.kMuxIn) {
      this.#flipMux('mux-unread');
      return false;
    }
    const queued = this.#muxCount(this.muxOutq);
    if (queued == null) {
      this.#invalidate('siocoutq-unavailable');
      return false;
    }
    if (queued > this.kMuxOut) {
      this.#flipMux('mux-send');
      return false;
    }
    const liveRcv = this.readMuxRcvbuf(this.muxFd);
    const liveSnd = this.readMuxSndbuf(this.muxFd);
    if (!Number.isInteger(liveRcv) || liveRcv <= 0 || !Number.isInteger(liveSnd) || liveSnd <= 0) {
      this.#invalidate('mux-buf-unavailable');
      return false;
    }
    if (liveRcv > this.muxRcvbuf || liveSnd > this.muxSndbuf) {
      this.#flipMux('mux-buffer');
      return false;
    }
    // The window is not subtracted here. A frame that does not fit beside
    // credit still has to be read so admission can reject it. Pausing that
    // read leaves the frame unfinished and the rejection unsent. The stall
    // is the other shape: this partial and an unfinished stdout line that
    // cannot take its next read either. #noteMuxBudget closes that pair.
    if (this.bufferedBytes() + this.readBytes > this.#globalCap()) {
      this.#pauseInput();
      return false;
    }
    return true;
  }

  #considerMuxRead() {
    if (this.muxReadPosted || this.closed || this.framingFault || this.flip) return;
    if (!this.#muxReadPermitted()) return;
    this.muxReadPosted = true;
    this.socket.resume();
  }

  #armMuxProbe() {
    if (this.muxProbeTimer) return;
    this.muxProbeTimer = setInterval(() => {
      if (this.closed || this.flip || this.invalidReason) {
        this.#clearMuxProbe();
        return;
      }
      // A pause sticks until something recounts. Stdout used to do that when
      // a child echoed a grant; a quiet child never will. The probe is the
      // recount, and it still resumes only under the global low water.
      // A mux frame and a stdout line that block each other never recount
      // into room, so the probe is also the fault for that pair.
      if (this.#noteMuxBudget()) return;
      if (this.inputPaused) this.#resumeInput();
      // readPosted plus a paused stdout is a cancelled resume. The child is
      // not budget-paused, and the bytes already in the kernel are not a new read.
      this.#repairStuckReads();
      if (this.muxReadPosted) return;
      this.#considerMuxRead();
    }, PROBE_INTERVAL_MS);
  }

  #clearMuxProbe() {
    if (this.muxProbeTimer) {
      clearInterval(this.muxProbeTimer);
      this.muxProbeTimer = null;
    }
    this.#clearMuxSendWait();
  }

  // The next read is a full C, and other retained bytes shrink the room
  // beside the unfinished frame. Fault when that room cannot take the read
  // and draining those bytes cannot reopen it: the frame alone is already
  // past half the cap, or it already leaves less than C. A partial under
  // that line still faults when an unfinished stdout line is what fills the
  // rest and that line's next read does not fit either. Those two partials
  // never shrink, and the low-water checks wait forever. A short read is
  // not used. The onread buffer is C, so it can pull a full buffer and
  // cross the cap. A length that is not buffered yet stays in the kernel.
  #muxFrameUnfinishable() {
    const declared = this.bridge.leadingDeclared();
    if (!(declared > 0)) return false;
    const cap = this.#globalCap();
    if (declared > cap) return true;
    const held = this.bridge.pendingBytes();
    if (held >= declared) return false;
    const other = Math.max(0, this.bufferedBytes() - held);
    const free = cap - other - held;
    if (free >= this.readBytes) return false;
    if (held + this.readBytes > cap || held > cap / 2) return true;
    // Drainable queues can still open a full read. An unfinished stdout
    // line cannot. Walk children only once the buffer is already tight.
    return this.#stdoutPartialBlocked();
  }

  // An incomplete child line whose next kernel read does not fit beside the
  // bytes already retained. Unread of zero is the child not having written
  // yet, which is not a block. A tail shorter than C fits when `free` does.
  #stdoutPartialBlocked() {
    const buffered = this.bufferedBytes();
    const cap = this.#globalCap();
    for (const rec of this.children.values()) {
      if (rec.dead || !rec.flowOk) continue;
      const framerStuck = rec.framer.pendingBytes() > 0 && !rec.framer.hasPendingNewline();
      const stashed = (rec.stash?.length ?? 0) > 0;
      if (!framerStuck && !stashed) continue;
      const unread = this.#stdoutPending(rec);
      if (!Number.isInteger(unread) || unread <= 0) continue;
      const incoming = Math.min(this.readBytes, unread);
      if (buffered + incoming > cap) return true;
    }
    return false;
  }

  // FIONREAD without the invalidation the read gate uses. A fault probe must
  // not retire the run because one sample failed.
  #stdoutPending(rec) {
    if (!Number.isInteger(rec.stdoutFd)) return null;
    try {
      const unread = this.flowPending(rec.stdoutFd);
      return Number.isInteger(unread) && unread >= 0 ? unread : null;
    } catch {
      return null;
    }
  }

  #noteMuxBudget() {
    if (this.framingFault || this.closed || this.flip) return false;
    if (!this.#muxFrameUnfinishable()) return false;
    this.framingFault = 'mux-budget';
    this.#failAll(this.framingFault);
    this.socket.destroy();
    return true;
  }

  #onSocket(chunk) {
    if (this.closed || this.framingFault) return;
    try {
      this.bridge.feed(chunk);
      for (const msg of this.bridge.frames()) this.#onMux(msg);
      // Pausing never resumes: the unfinished frame cannot shrink, and the
      // low-water check waits for userspace to fall. A frame that cannot be
      // assembled closes the channel instead of sitting there forever.
      if (this.#noteMuxBudget()) return;
      if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
    } catch (err) {
      this.framingFault = err.constructor?.name || 'framing-error';
      this.#failAll(this.framingFault);
      this.socket.destroy();
    }
  }

  // Call-lane invariants. Grants, spawn, admission, parking, promotion,
  // and cancel all use this accounting:
  //
  // admitKeep is the largest cost actually reserved for a call that was
  // admitted: line bytes, the call's identifier bytes, one grant, one
  // cancel frame, and that cancel's identifier bytes. A
  // cost above B_t or B_g is not admissible and is not stored. Rejecting
  // a call drops that cost. The stored value is max(admitFloor, live
  // costs). admitFloor is the largest cost that completed or timed out
  // without being rejected. Credit headroom uses that value, so a
  // rejected oversized call cannot stop replenishment.
  //
  // A call parks only when its own bytes fit B_t and B_g beside every live
  // send window and the miss is K_out. Parked bytes are in pluginBytes
  // and bufferedBytes, and the correlation id is pending exactly once.
  // Promotion writes the line only when that queue has moved and no cancel
  // for the id is still settling. Settling means the cancel lane is pending,
  // or this take still holds that cancel. Stdout spends the window and then
  // parses every frame in the chunk before any promotion, including a cancel
  // acknowledgement in the same read. A cancel timeout leaves the call parked
  // and then allows promotion. An acknowledgement drops the call and does not
  // write it.
  //
  // Retained userspace plus every live send window stays within B_g.
  // bufferedBytes() does not include a window. sendWindow is credit the child
  // has not spent: grants raise it, data stdout lowers it, and
  // sendWindow + creditSpent stays equal to creditSent. Cancel acks and grant
  // lines do not lower it. The kind is the top-level JSON field; credit-wait
  // and credit-response use that same classifier and do not decrement those
  // lines. Spending them made the quiet flush advertise the same bytes again.
  // A data partial spends as soon as its kind is known, so the line is not
  // held on top of the window. The unspent remainder stays advertised until
  // half the room is gone, and that half comes back as one grant. A sender
  // that stops before that half, still waiting for a window that covers its
  // next reply, is flushed after a quiet delay. Further stdout postpones that
  // flush, and not past the max delay. The flush adds credit. It does not
  // reduce a window already advertised.
  //
  // Every path that keeps new userspace bytes charges them beside every live
  // window, including the child being served (#fitsGlobal(extra, null)).
  // None of them may spend bytes already advertised:
  //
  // Admission. A call or a cancel is retained only when its line, its
  // identifier bytes, and the control reserve fit beside every window. The
  // grant left the call hole (#callHole) outside the window for that line.
  // The call does not also add the window into the cost: #globalHeld(null)
  // already counts it, and adding it again would pin the line behind its own
  // reservation. The same room is split across the live children
  // (#peerShareReserve). A window already at or above an equal share is not
  // reserved again and is not reduced.
  // Park. The parked line has to fit beside every window. The miss that parks
  // is K_out. Parking into the unspent window would keep the line in the room
  // the child was told it may still fill. Promotion rechecks the reserve with
  // the line already in the sums and does not add the window a second time.
  // Expansion. #complete stamps version, grants, and timestamps onto a reply.
  // The stdout line has already left the framer. A data line has already left
  // the window; the unspent remainder is still advertised, and the growth is
  // charged beside it. A cancel ack never spent the window. Both pass null.
  // Omitting the replying child's remainder lets that stamp occupy credit the
  // child has not spent, and the next in-credit reply then pauses on B_g.
  // #holdFits charges the same growth when a deferred reply is released. A
  // pure move adds no bytes.
  // Refill and flush. #creditRoom omits this child's window only while it
  // sizes the new grant, then subtracts the current window from that budget.
  // It also keeps #replyStampOverhead outside the window: version, grants,
  // and timestamps that #complete will attach. The grant line itself is
  // admitted with null, inside the hole the budget left outside the window.
  // A later grant cannot spend the hole.
  // Reject, terminal, flood, and queueMuxBytes pass null. #enqueueBuf only
  // commits bytes the caller already admitted. A second check would count
  // the frame again.
  // Reads are not admissions. A stdout read does not subtract the open
  // window: data bytes spend that window in the same turn, one for one,
  // before the line is parsed. Subtracting it would refuse a reply the child
  // was credited to write. #retainTail stashes the unread tail of a chunk
  // that this spend already classified, so the tail is not a second copy of
  // the window. A mux read does not subtract the window either. The partial
  // is assembly, not a retained copy: a finished frame is admitted beside
  // every window or rejected without keeping the bytes. Refusing the read
  // would stall that rejection. An unfinished mux frame that also leaves an
  // unfinished stdout line unable to take its next read cannot shrink, and
  // #noteMuxBudget faults that pair instead of pausing both. #failAll writes
  // only after the bridge is already unusable. Spawn charges #globalHeld(null)
  // plus the kernel reserves against totalGlobal. A stdout read is posted
  // only when bufferedBytes() plus the bytes it will pull fit B_g. A waiting
  // read can pull C. A kernel queue shorter than C is only that tail.
  // Cancel and grant are queued ahead of payload and do not consume the
  // send window. One cancel's encoded frame and one grant are the K_out
  // hole. That cancel's identifier bytes are a separate userspace hole:
  // the cancel lane retains them in addition to the call lane, and they
  // are not a second stdin frame. A payload still in the unsent queue is
  // dropped when its call or cancel expires.
  #onMux(msg) {
    if (msg.kind !== 'call' && msg.kind !== 'cancel') return;
    const rec = this.children.get(msg.pluginId);
    const reason = this.#authz(rec, msg);
    if (reason) {
      this.#reject(msg, reason, true);
      return;
    }
    const ingressTs = performance.now();
    const lane = msg.kind === 'cancel' ? 'cancel' : 'call';
    if (this.pending.has(msg.pluginId, msg.correlationId, lane)) {
      this.#reject(msg, 'duplicate-correlation', true);
      return;
    }
    const staleGen = this.stale.get(msg.pluginId, msg.correlationId, lane);
    if (staleGen != null) {
      if (staleGen === rec.credential.generation) {
        this.#reject(msg, 'stale-correlation', true);
        return;
      }
      this.stale.delete(msg.pluginId, msg.correlationId, lane);
    }
    if (msg.kind === 'cancel') {
      if (this.#pendingFull(rec) || rec.cancelPending >= this.capsConfig.cancels) {
        this.caps.pending = true;
        this.#reject(msg, 'pending-cap', true);
        return;
      }
      const line = encodeNdjson({ kind: 'cancel', correlationId: msg.correlationId });
      const bytes = Buffer.byteLength(line);
      const idBytes = identifierBytes(msg.pluginId, msg.correlationId);
      // A cancel is control. It still has to leave room for one grant.
      if (this.#overBudget(rec, bytes + idBytes, bytes, CONTROL_RESERVE.grant)) {
        this.caps.total = true;
        this.#reject(msg, 'total-cap', true);
        return;
      }
      this.#arm(rec, msg, { cancel: true, bytes, idBytes, ingressTs });
      this.#enqueueStdin(rec, line, bytes, 'cancel', msg.correlationId);
      return;
    }
    const line = encodeNdjson({
      kind: 'call',
      correlationId: msg.correlationId,
      port: msg.port,
      method: msg.method,
      payload: msg.payload,
    });
    const bytes = Buffer.byteLength(line);
    const idBytes = identifierBytes(msg.pluginId, msg.correlationId);
    if (this.#pendingFull(rec)) {
      this.caps.pending = true;
      this.#reject(msg, 'pending-cap', true);
      return;
    }
    // Payload has to leave room for one cancel of this correlation id and
    // one grant. A numeric-id cancel is smaller than a string id.
    // Unspent send credit is stdout the child may still write. The line has
    // to fit beside that promise, including this child's own window. The
    // hole left out of the grant is that room. The credit is not stdin, so
    // it does not enter K_out, and it is not added to the cost again.
    const cancelReserve = this.#maxCancelBytes(rec, msg.correlationId);
    const cancelIds = this.#maxCancelIds(rec, msg.correlationId);
    const reserve = CONTROL_RESERVE.grant + cancelReserve;
    const admitCost = bytes + idBytes + reserve + cancelIds;
    if (this.#overBudget(rec, bytes + idBytes, bytes, reserve, cancelIds)) {
      // Own bytes fit B_t and beside every live window, including this
      // child's. The miss is a full K_out. Hold the frame and write it once
      // the queue moves. A call that does not fit beside advertised credit
      // is rejected; parking it would keep those bytes in the window.
      if (!this.#bytesOver(rec, bytes + idBytes, reserve, cancelIds)) {
        this.#parkCall(rec, msg, line, bytes, idBytes, ingressTs, reserve, cancelIds);
        return;
      }
      this.caps.total = true;
      this.#reject(msg, 'total-cap', true);
      return;
    }
    this.#arm(rec, msg, { cancel: false, bytes, idBytes, ingressTs });
    this.#enqueueStdin(rec, line, bytes, 'call', msg.correlationId);
    this.#noteAdmit(rec, msg.correlationId, admitCost);
  }

  #parkCall(rec, msg, line, bytes, idBytes, ingressTs, reserve, idReserve = 0) {
    const cost = bytes + idBytes;
    const userspace = reserve + Math.max(0, idReserve);
    // The line is not in the sums yet. Identifier bytes join with the
    // reservation below, and the line joins parkedBytes, so a later check
    // must not add either of them again. idReserve is the cancel lane's
    // identifiers. It is userspace only and is not added to K_out.
    if (this.#pluginBytes(rec) + cost + userspace > this.#childCeiling(rec)
        || !this.#fitsGlobal(cost + userspace, null)) {
      this.caps.total = true;
      this.#reject(msg, 'total-cap', true);
      return;
    }
    this.#arm(rec, msg, { cancel: false, bytes, idBytes, ingressTs });
    rec.parked.push({ msg, line, bytes, ingressTs, reserve, idReserve });
    rec.parkedBytes += bytes;
    this.#noteAdmit(rec, msg.correlationId, bytes + idBytes + userspace);
    this.#armPark(rec);
  }

  #armPark(rec, delayMs = 0) {
    if (rec.parkTimer || rec.dead || this.closed) return;
    const fire = () => {
      rec.parkTimer = null;
      this.#drainPark(rec);
    };
    rec.parkTimer = delayMs > 0 ? setTimeout(fire, delayMs) : setImmediate(fire);
  }

  // clearImmediate() counts every object as an Immediate and decrements the
  // process-wide immediate tally. A parked-call timeout passed through it
  // leaves that tally at zero, and a later child's grant callback never runs.
  #clearParkTimer(rec) {
    const timer = rec.parkTimer;
    if (!timer) return;
    rec.parkTimer = null;
    if (typeof timer._onTimeout === 'function') clearTimeout(timer);
    else clearImmediate(timer);
  }

  // A cancel lane that is still pending, or a take that has not finished
  // retiring that cancel. The parked payload stays unsent until the
  // acknowledgement drops it or the cancel times out.
  #cancelSettling(rec, correlationId) {
    if (rec.parkHold && Object.is(correlationId, rec.parkHoldId)) return true;
    return this.pending.has(rec.credential.pluginId, correlationId, 'cancel');
  }

  #drainPark(rec) {
    if (rec.parkDraining || rec.dead || this.closed) return;
    // This read still has frames to apply, or a partial line that may be
    // the rest of a cancel acknowledgement. Promotion waits for that parse.
    if (rec.childReads > 0 || rec.stash || rec.framer.pendingBytes() > 0) return;
    rec.parkDraining = true;
    try {
      while (rec.parked.length > 0) {
        const next = rec.parked[0];
        if (this.#cancelSettling(rec, next.msg.correlationId)) return;
        // The caller's deadline started at ingress. Promoting the call would
        // hand the child work the caller has already been told expired.
        if (this.#remainMs(next.msg, next.ingressTs) <= 0) {
          const correlationId = next.msg.correlationId;
          this.#expire(next.msg.pluginId, correlationId, 'call');
          if (rec.parked[0] && Object.is(rec.parked[0].msg.correlationId, correlationId)) {
            this.#unpark(rec, correlationId);
          }
          continue;
        }
        // Line bytes and identifier bytes are already in the sums. Every
        // live window, including this child's, is already in #globalHeld.
        // Adding the window here would count it twice and the line would
        // never be promoted.
        if (!this.#overBudget(rec, 0, next.bytes, next.reserve, next.idReserve || 0)) {
          rec.parked.shift();
          rec.parkedBytes = Math.max(0, rec.parkedBytes - next.bytes);
          if (rec.parked.length === 0) rec.parkSince = null;
          this.#enqueueStdin(rec, next.line, next.bytes, 'call', next.msg.correlationId);
          continue;
        }
        if (this.#bytesOver(rec, 0, next.reserve, next.idReserve || 0)) {
          this.caps.total = true;
          this.#rejectParked(rec, 'total-cap');
          return;
        }
        const idle = rec.outbound === 0 && !rec.stdinWriting
          && rec.stdinPayload.length === 0 && rec.stdinControl.length === 0;
        if (!idle) return;
        const kernel = rec.flowOk ? this.#stdinQueued(rec) : 0;
        if (rec.parkSince == null) rec.parkSince = performance.now();
        const dropped = Number.isInteger(kernel) && Number.isInteger(rec.parkKernel) && kernel < rec.parkKernel;
        if (dropped) rec.parkSince = performance.now();
        if (Number.isInteger(kernel)) rec.parkKernel = kernel;
        if (!dropped && performance.now() - rec.parkSince >= 40) {
          this.caps.total = true;
          this.#rejectParked(rec, 'total-cap');
          return;
        }
        this.#armPark(rec, 10);
        return;
      }
    } finally {
      rec.parkDraining = false;
    }
  }

  #rejectParked(rec, code) {
    this.#clearParkTimer(rec);
    rec.parkSince = null;
    rec.parkKernel = null;
    const queued = rec.parked.splice(0);
    rec.parkedBytes = 0;
    for (const next of queued) {
      this.#forgetAdmit(rec, next.msg.correlationId);
      this.#take(next.msg.pluginId, next.msg.correlationId, 'call');
      this.#reject(next.msg, code, true);
    }
  }

  // Time left on the deadline captured at ingress. A parked call keeps that
  // instant; the timer is not restarted when the line is later written.
  #remainMs(msg, ingressTs) {
    const budget = Number.isFinite(msg.timeoutMs) && msg.timeoutMs >= 0
      ? msg.timeoutMs
      : DEFAULT_DEADLINE_MS;
    if (!Number.isFinite(ingressTs)) return budget;
    return budget - (performance.now() - ingressTs);
  }

  #unpark(rec, correlationId) {
    if (!rec || rec.parked.length === 0) return;
    const idx = rec.parked.findIndex((entry) => Object.is(entry.msg.correlationId, correlationId));
    if (idx < 0) return;
    const [entry] = rec.parked.splice(idx, 1);
    rec.parkedBytes = Math.max(0, rec.parkedBytes - entry.bytes);
    if (rec.parked.length === 0) {
      rec.parkSince = null;
      rec.parkKernel = null;
      this.#clearParkTimer(rec);
    }
  }

  // Identifier bytes the cancel lane will retain for the largest call
  // still owed. The call lane already holds its own copy. This hole is
  // userspace only: K_out reserves the encoded cancel, not this copy.
  #maxCancelIds(rec, alsoId) {
    const pluginId = rec.credential.pluginId;
    let max = identifierBytes(pluginId, 0);
    const consider = (correlationId) => {
      const n = identifierBytes(pluginId, correlationId);
      if (n > max) max = n;
    };
    if (alsoId !== undefined) consider(alsoId);
    for (const pending of this.pending.values()) {
      if (pending.cancel) continue;
      if (!Object.is(pending.pluginId, pluginId)) continue;
      if (pending.generation !== rec.credential.generation) continue;
      consider(pending.correlationId);
    }
    return max;
  }

  // The largest cancel still owed for this child. The reserved hole has to
  // fit that frame, not the numeric-id sample.
  #maxCancelBytes(rec, alsoId) {
    let max = CONTROL_RESERVE.cancel;
    const consider = (correlationId) => {
      const n = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId }));
      if (n > max) max = n;
    };
    if (alsoId !== undefined) consider(alsoId);
    for (const pending of this.pending.values()) {
      if (pending.cancel) continue;
      if (!Object.is(pending.pluginId, rec.credential.pluginId)) continue;
      if (pending.generation !== rec.credential.generation) continue;
      consider(pending.correlationId);
    }
    return max;
  }

  #queueGrant(rec, credit) {
    if (rec.dead || this.closed || !Number.isInteger(credit) || credit <= 0) return false;
    const line = encodeNdjson({ kind: 'grant', credit });
    const bytes = Buffer.byteLength(line);
    if (bytes > CONTROL_RESERVE.grant) return false;
    if (this.#overBudget(rec, bytes, bytes, this.#maxCancelBytes(rec), this.#maxCancelIds(rec))) return false;
    this.#enqueueStdin(rec, line, bytes, 'grant');
    rec.creditSent += credit;
    rec.sendWindow += credit;
    return true;
  }

  // Data stdout spends the send window. The refill below gives those bytes
  // back only once they are no longer held in the child's budget. Cancel
  // acks and grant lines are not data: #applyStdout does not pass them here.
  // Promotion is not done here: the chunk is parsed first, so a cancel
  // acknowledgement in it can drop a parked call.
  #takeStdout(rec, n) {
    if (!Number.isInteger(n) || n <= 0 || rec.dead) return;
    const spent = Math.min(rec.sendWindow, n);
    rec.sendWindow -= spent;
    rec.creditSpent += spent;
  }

  // Give back window charged before a line was known to be control. The
  // grant total does not change: the child was not offered these bytes.
  #refundStdout(rec, n) {
    if (!Number.isInteger(n) || n <= 0 || rec.dead) return;
    const back = Math.min(rec.creditSpent, n);
    rec.creditSpent -= back;
    rec.sendWindow += back;
  }

  // Credit follows bytes already in the child's budget and the process
  // sum. One later turn lets calls issued with the spawn land in that sum.
  // The grant then uses that room even while the mux is unread, so a plugin
  // that waits for credit does not stall for the life of the socket.
  #refillCredit(rec) {
    if (rec.dead || this.closed || !rec.flowOk || rec.refillArmed) return;
    const room = this.#creditRoom(rec);
    const keep = this.#creditKeep(rec, room);
    if (this.#replenishCredit(room, keep, rec.sendWindow) <= 0) {
      this.#noteWithheldCredit(rec, room, keep);
      this.#drainPark(rec);
      return;
    }
    this.#disarmCreditFlush(rec);
    rec.refillArmed = true;
    setImmediate(() => this.#finishRefill(rec));
  }

  // The first grant follows a finite burst for a few turns, so calls
  // already written are in the budget before the window is promised. A
  // queue that stays unread without new calls is live traffic, and the
  // grant uses the room already accounted. A later refill does not follow
  // again: the mux stays unread for the whole of an open-loop run, and
  // another follow on every response is the spin. The follow is capped.
  // Settlement is the attempt, not a queued grant. Parked bytes can hold
  // the first grant out of K_out; treating that miss as "not yet started"
  // follows again on every response.
  #finishRefill(rec) {
    rec.refillArmed = false;
    if (rec.dead || this.closed || !rec.flowOk) return;
    if (rec.creditSent > 0 || rec.grantSettled) {
      this.#grantFromRoom(rec);
      return;
    }
    const unread = this.#muxCount(this.muxPending);
    const readable = Number.isInteger(unread) && unread > 0 && this.muxReadPosted;
    const waits = rec.refillWaits || 0;
    const calls = rec.callPending;
    const growing = Number.isInteger(rec.refillCalls) && calls > rec.refillCalls;
    const shrinking = Number.isInteger(rec.refillUnread) && Number.isInteger(unread) && unread < rec.refillUnread;
    const stuck = readable && Number.isInteger(rec.refillUnread) && unread >= rec.refillUnread;
    rec.refillCalls = calls;
    if (readable) {
      rec.refillSeen = true;
      rec.refillUnread = unread;
      rec.refillGap = 0;
    }
    const burst = growing || shrinking || (readable && !stuck);
    // One flat sample is the gap between two reads. Several flat samples
    // with no new calls are traffic that will not drain.
    const settling = readable && stuck && !growing && waits < 4;
    const gap = !readable && rec.refillSeen && (rec.refillGap || 0) < 2;
    if ((burst || settling || gap) && waits < 8) {
      if (gap) rec.refillGap = (rec.refillGap || 0) + 1;
      if (!readable) rec.refillUnread = null;
      rec.refillWaits = waits + 1;
      rec.refillArmed = true;
      setImmediate(() => this.#finishRefill(rec));
      return;
    }
    this.#grantFromRoom(rec);
  }

  #grantFromRoom(rec) {
    rec.grantSettled = true;
    rec.refillWaits = 0;
    rec.refillUnread = null;
    rec.refillGap = 0;
    rec.refillSeen = false;
    rec.refillCalls = null;
    // #creditRoom already keeps an equal share for every other live child.
    const room = this.#creditRoom(rec);
    const keep = this.#creditKeep(rec, room);
    const credit = this.#replenishCredit(room, keep, rec.sendWindow);
    if (credit <= 0) {
      this.#noteWithheldCredit(rec, room, keep);
      this.#drainPark(rec);
      return;
    }
    this.#disarmCreditFlush(rec);
    this.#queueGrant(rec, credit);
    this.#drainPark(rec);
  }

  // New credit only. The advertised remainder is not reduced. While the
  // child still holds at least half of the room, a spent chunk is not a
  // grant. Crossing that half returns the spent half in one grant, so an
  // open-loop response does not write a window update of its own. A window
  // of zero is the first advertisement and takes the whole room. Credit
  // still withheld when the child goes quiet is flushed by #noteWithheldCredit.
  #replenishCredit(room, keep, sendWindow) {
    const budget = room - keep;
    if (!Number.isFinite(budget) || budget <= sendWindow) return 0;
    const deficit = budget - sendWindow;
    if (sendWindow > 0 && deficit * 2 < budget) return 0;
    return Math.min(2147483647, deficit);
  }

  // Spent credit that is not yet advertised again. Zero when the window
  // already covers the room. The half threshold does not change this gap.
  #advertisedDeficit(room, keep, sendWindow) {
    const budget = room - keep;
    if (!Number.isFinite(budget) || budget <= sendWindow) return 0;
    const deficit = budget - sendWindow;
    if (!Number.isFinite(deficit) || deficit <= 0) return 0;
    return Math.min(2147483647, Math.floor(deficit));
  }

  // The half threshold is holding a positive deficit back. Arm the quiet
  // flush. A full window, or a window the half threshold will grant now,
  // cancels it.
  #noteWithheldCredit(rec, room, keep) {
    const deficit = this.#advertisedDeficit(room, keep, rec.sendWindow);
    const withheld = rec.sendWindow > 0
      && deficit > 0
      && this.#replenishCredit(room, keep, rec.sendWindow) <= 0;
    if (withheld) this.#armCreditFlush(rec);
    else this.#disarmCreditFlush(rec);
  }

  #armCreditFlush(rec, retry = false) {
    if (rec.dead || this.closed || !rec.flowOk) return;
    const now = performance.now();
    if (rec.creditFlushDue == null) rec.creditFlushDue = now + CREDIT_FLUSH_MAX_MS;
    let delay = CREDIT_FLUSH_QUIET_MS;
    if (!retry) delay = Math.max(0, Math.min(CREDIT_FLUSH_QUIET_MS, rec.creditFlushDue - now));
    if (rec.creditFlush) clearTimeout(rec.creditFlush);
    const timer = setTimeout(() => this.#flushWithheldCredit(rec), delay);
    if (typeof timer.unref === 'function') timer.unref();
    rec.creditFlush = timer;
  }

  #disarmCreditFlush(rec) {
    if (rec.creditFlush) clearTimeout(rec.creditFlush);
    rec.creditFlush = null;
    rec.creditFlushDue = null;
  }

  // One grant of the deficit the half threshold has been holding. The
  // amount is the room at flush time, so a sibling share taken since the
  // spend is not advertised. A grant that does not fit yet is retried
  // inside the same bound.
  #flushWithheldCredit(rec) {
    rec.creditFlush = null;
    if (rec.dead || this.closed || !rec.flowOk) {
      rec.creditFlushDue = null;
      return;
    }
    const room = this.#creditRoom(rec);
    const keep = this.#creditKeep(rec, room);
    const deficit = this.#advertisedDeficit(room, keep, rec.sendWindow);
    if (!(rec.sendWindow > 0) || !(deficit > 0)) {
      rec.creditFlushDue = null;
      return;
    }
    if (!this.#queueGrant(rec, deficit)) {
      this.#armCreditFlush(rec, true);
      return;
    }
    rec.creditFlushDue = null;
    this.#drainPark(rec);
  }

  // Send windows of other live children. This child's own window is subtracted
  // when the grant is sized, so counting it here would advertise nothing.
  #siblingCredit(except) {
    let sum = 0;
    for (const rec of this.children.values()) {
      if (rec === except || rec.dead || !rec.flowOk) continue;
      if (rec.sendWindow > 0) sum += rec.sendWindow;
    }
    return sum;
  }

  // Userspace bytes already retained, plus send credit promised to live
  // children. `except` omits that child's window. Retaining paths pass null
  // and count every window. #creditRoom passes the child being granted: the
  // budget it returns is additional credit, and the current window is then
  // subtracted from it. The promised bytes are not in bufferedBytes() until
  // that child writes them.
  #globalHeld(except) {
    return this.bufferedBytes() + this.#siblingCredit(except);
  }

  // One check for every path that keeps userspace bytes. `extra` is the new
  // bytes. `except` is null on those paths, so every live window is in the
  // sum. A sum equal to B_g still fits. Omitting a window here lets the new
  // bytes occupy credit that child was already told it may write.
  #fitsGlobal(extra, except = null) {
    const n = Number.isInteger(extra) && extra > 0 ? extra : 0;
    return this.#globalHeld(except) + n <= this.#globalCap();
  }

  // Record a call that was admitted. A cost that cannot fit an empty child
  // is not headroom, and a call that is still only a candidate is not recorded.
  #noteAdmit(rec, correlationId, cost) {
    const ceiling = this.#childCeiling(rec);
    const global = this.#globalCap();
    if (!Number.isInteger(cost) || cost <= 0 || cost > ceiling || cost > global) return;
    const pending = this.pending.get(rec.credential.pluginId, correlationId, 'call');
    if (!pending || pending.cancel) return;
    pending.admitCost = cost;
    if (cost > rec.admitKeep) rec.admitKeep = cost;
  }

  // A rejected call drops its reservation. The keep falls back to the
  // largest cost that was not rejected and is still live or already finished.
  #forgetAdmit(rec, correlationId) {
    const pending = this.pending.get(rec.credential.pluginId, correlationId, 'call');
    const cost = pending?.admitCost || 0;
    if (pending) pending.admitCost = 0;
    if (!(cost > 0) || cost < rec.admitKeep) return;
    let max = rec.admitFloor || 0;
    for (const other of this.pending.values()) {
      if (!(other.admitCost > max)) continue;
      if (other.cancel) continue;
      if (!Object.is(other.pluginId, rec.credential.pluginId)) continue;
      if (other.generation !== rec.credential.generation) continue;
      max = other.admitCost;
    }
    rec.admitKeep = max;
  }

  // A call that finished without rejection keeps its cost as headroom for
  // the next admission of that size.
  #retainAdmit(rec, pending) {
    const cost = pending?.admitCost || 0;
    if (!(cost > 0)) return;
    pending.admitCost = 0;
    if (cost > (rec.admitFloor || 0)) rec.admitFloor = cost;
    if ((rec.admitFloor || 0) > rec.admitKeep) rec.admitKeep = rec.admitFloor;
  }

  // Bytes no grant may advertise. Calls use this hole; a later child's
  // window does not. The tighter of B_g and B_t decides the batch. A room
  // that cannot hold the batch keeps one call, so a response on a small
  // ceiling is still granted. Above eight calls, a large cap keeps one
  // slot per pending call. The hole is outside sendWindow. Stdout is the
  // only spend.
  #callHole() {
    const one = ADMIT_KEEP;
    let pending = this.capsConfig.pending;
    let seen = false;
    let space = Math.max(0, this.#globalCap());
    for (const rec of this.children.values()) {
      if (rec.dead) continue;
      const limit = rec.limits?.pending;
      if (Number.isInteger(limit) && limit > 0) {
        pending = seen ? Math.min(pending, limit) : limit;
        seen = true;
      }
      if (!rec.flowOk) continue;
      const ceiling = this.#childCeiling(rec);
      if (ceiling < space) space = ceiling;
    }
    pending = Math.max(1, Math.min(pending, this.capsConfig.pendingGlobal));
    const classic = Math.min(8, pending);
    let batch = 1;
    if (space > one * (classic + 24)) batch = classic;
    if (pending > classic && space > one * (pending + 24)) batch = pending;
    return one * batch;
  }

  // Share of the free pool still owed to other live children. The pool is
  // B_g minus the call hole and bytes already buffered, divided equally.
  // A peer at or above that share contributes nothing here: #globalHeld
  // already counts the window it was advertised, and that window is not
  // pulled back. This does not call #creditRoom.
  #peerShareReserve(rec) {
    const live = [];
    for (const child of this.children.values()) {
      if (child.dead || !child.flowOk) continue;
      live.push(child);
    }
    const n = live.length;
    if (n <= 1) return 0;
    const pool = Math.max(0, this.#globalCap() - this.#callHole() - this.bufferedBytes());
    const share = Math.floor(pool / n);
    if (share <= 0) return 0;
    let reserve = 0;
    for (const child of live) {
      if (child === rec) continue;
      const held = child.sendWindow > 0 ? child.sendWindow : 0;
      if (held < share) reserve += share - held;
    }
    return reserve;
  }

  #replyStampOverhead(rec) {
    // #complete adds version, grants, timestamps, and the length prefix on
    // top of the stdout line. That growth is not part of the line the child
    // spends. Leaving it inside the advertised window makes a credit-compliant
    // reply miss B_g once the stamp is attached. Wide timestamps bound the
    // digits performance.now() can add. The value is fixed for this generation,
    // so the grant path does not rebuild it on every refill. A version that
    // cannot be framed leaves no credit: the reply cannot be delivered.
    if (Number.isInteger(rec.stampOverhead)) return rec.stampOverhead;
    try {
      const mux = encodeMux({
        kind: 'result',
        for: 'call',
        pluginId: rec.credential.pluginId,
        correlationId: 0,
        payload: '',
        sendTs: 1e15,
        ingressTs: 1e15,
        egressTs: 1e15,
        version: rec.credential.version,
        generation: rec.credential.generation,
        grants: [...rec.credential.grants],
      });
      const line = Buffer.byteLength(encodeNdjson({
        kind: 'result',
        correlationId: 0,
        payload: '',
      }));
      rec.stampOverhead = Math.max(0, mux.length - line);
    } catch {
      rec.stampOverhead = this.#globalCap();
    }
    return rec.stampOverhead;
  }

  #creditRoom(rec) {
    const hole = this.#callHole();
    // The stamp is reserved before the grant, beside the call hole. A line
    // that fills the resulting window still fits once #complete attaches it,
    // including while this child's unspent remainder is still advertised.
    const stamp = this.#replyStampOverhead(rec);
    const childRoom = this.#childCeiling(rec) - this.#pluginBytes(rec) - hole - stamp;
    const globalRoom = this.#globalCap() - this.#globalHeld(rec) - hole - this.#peerShareReserve(rec) - stamp;
    return Math.min(childRoom, globalRoom);
  }

  // The shared hole is already out of `room`. A noted call larger than
  // that hole still keeps the excess, so the next call of that size fits
  // beside the credit. A cost above B_t or B_g is not headroom. Rejected
  // calls never reach this value. A small ceiling keeps one call, not a batch.
  #creditKeep(rec, room) {
    let noted = rec.admitKeep || 0;
    const ceiling = Math.min(this.#childCeiling(rec), this.#globalCap());
    if (noted > ceiling) noted = rec.admitFloor || 0;
    const one = Math.max(noted, ADMIT_KEEP);
    const batch = Math.min(8, rec.limits.pending);
    const spacious = Math.max(0, room) + this.#callHole();
    const local = spacious > one * (batch + 24) ? one * batch : one;
    const extra = Math.max(0, local - this.#callHole());
    return Math.min(Math.max(0, room), extra);
  }

  #enqueueStdin(rec, line, bytes, lane, correlationId) {
    const entry = { line, bytes, lane, correlationId: correlationId ?? null };
    if (lane === 'call') rec.stdinPayload.push(entry);
    else rec.stdinControl.push(entry);
    rec.outbound += bytes;
    this.#writeStdin(rec);
  }

  // A timed-out operation is still in the queue when the write that blocked
  // it has not been handed to the kernel. Sending it after the unblock would
  // run a call the caller was already told had failed.
  #dropUnsent(rec, correlationId, lane) {
    let released = 0;
    const keep = (queue) => {
      const next = [];
      for (const entry of queue) {
        if (entry.lane === lane && Object.is(entry.correlationId, correlationId)) released += entry.bytes;
        else next.push(entry);
      }
      return next;
    };
    rec.stdinControl = keep(rec.stdinControl);
    rec.stdinPayload = keep(rec.stdinPayload);
    if (released > 0) this.#releaseOutbound(rec, released);
  }

  // One write at a time. Control frames already queued jump ahead of payload
  // that has not been handed to the kernel yet.
  #writeStdin(rec) {
    if (rec.stdinWriting || rec.dead) return;
    const entry = rec.stdinControl.shift() || rec.stdinPayload.shift();
    if (!entry) return;
    rec.stdinWriting = true;
    try {
      rec.child.stdin.write(entry.line, () => {
        rec.stdinWriting = false;
        this.#releaseOutbound(rec, entry.bytes);
        this.#writeStdin(rec);
      });
    } catch {
      rec.stdinWriting = false;
      this.#releaseOutbound(rec, entry.bytes);
    }
  }

  #releaseOutbound(rec, bytes) {
    if (rec.dead) return;
    rec.outbound = Math.max(0, rec.outbound - bytes);
    this.#noteStdinCeiling(rec);
    this.#maybeResumeAll();
    this.#drainPark(rec);
  }

  #pendingFull(rec) {
    return rec.callPending + rec.cancelPending >= rec.limits.pending
      || this.callPendingTotal + this.cancelPendingTotal >= this.capsConfig.pendingGlobal;
  }

  // Child and process ceilings, including every live send window. The kernel
  // queue is not this check: a call that fails only K_out can wait. A call
  // that fails this check does not fit beside credit already advertised, and
  // parking it would fill that promise.
  #bytesOver(rec, accounted, reserve, idReserve = 0) {
    const userspace = reserve + Math.max(0, idReserve);
    if (this.#pluginBytes(rec) + accounted + userspace > this.#childCeiling(rec)) return true;
    if (!this.#fitsGlobal(accounted + userspace, null)) return true;
    return false;
  }

  // `accounted` is charged to B_t and B_g. `stdinBytes` is what this write
  // adds to K_out. `reserve` is the wire control capacity (one grant and one
  // cancel frame) that must still fit beside it, in userspace and in K_out.
  // `idReserve` is the cancel lane's identifiers. It fits in userspace only.
  // Every live send window is inside `#globalHeld(null)` and is not part of
  // `stdinBytes`. `accounted` must not include a window already in that sum.
  #overBudget(rec, accounted, stdinBytes, reserve, idReserve = 0) {
    const ceiling = this.#childCeiling(rec);
    const userspace = reserve + Math.max(0, idReserve);
    if (this.#pluginBytes(rec) + accounted + userspace > ceiling) return true;
    if (!this.#fitsGlobal(accounted + userspace, null)) return true;
    if (rec.flowOk && rec.kOut != null) {
      const kernel = this.#stdinQueued(rec);
      if (!Number.isInteger(kernel)) return true;
      if (kernel + Math.max(0, rec.outbound) + stdinBytes + reserve > rec.kOut) return true;
    }
    return false;
  }

  #arm(rec, msg, extra) {
    const timeoutMs = Math.max(0, this.#remainMs(msg, extra.ingressTs));
    const lane = extra.cancel ? 'cancel' : 'call';
    const timer = setTimeout(() => this.#expire(msg.pluginId, msg.correlationId, lane), timeoutMs);
    this.pending.set(msg.pluginId, msg.correlationId, {
      pluginId: msg.pluginId,
      correlationId: msg.correlationId,
      generation: rec.credential.generation,
      sendTs: msg.sendTs,
      ingressTs: extra.ingressTs,
      cancel: extra.cancel,
      bytes: extra.bytes,
      idBytes: extra.idBytes,
      timer,
    }, lane);
    rec.idBytes += extra.idBytes;
    if (extra.cancel) {
      rec.cancelPending++;
      this.cancelPendingTotal++;
    } else {
      rec.callPending++;
      this.callPendingTotal++;
    }
    if (this.#pendingFull(rec)) this.caps.pending = true;
  }

  #expire(pluginId, correlationId, lane) {
    const pending = this.#take(pluginId, correlationId, lane);
    if (!pending || this.closed) return;
    // The id stays quarantined for this generation so a reuse cannot arm a
    // waiter that a late reply would satisfy.
    this.stale.set(pending.pluginId, pending.correlationId, pending.generation, lane);
    this.#enqueueTerminal({
      kind: 'error',
      code: 'timeout',
      for: pending.cancel ? 'cancel' : 'call',
      pluginId: pending.pluginId,
      correlationId: pending.correlationId,
      generation: pending.generation,
    });
    // #take does not promote a parked call while its cancel is the lane
    // being retired: an acknowledgement that follows would still drop it.
    // A timeout is that retirement. The payload may go out now.
    if (!pending.cancel) return;
    const rec = this.children.get(pending.pluginId);
    if (rec && rec.credential.generation === pending.generation) this.#drainPark(rec);
  }

  #dropStale(pluginId, generation) {
    for (const [key, gen] of [...this.stale.entries()]) {
      if (Object.is(key.pluginId, pluginId) && gen === generation) {
        this.stale.delete(key.pluginId, key.correlationId, key.lane);
      }
    }
  }

  #take(pluginId, correlationId, lane) {
    const pending = this.pending.get(pluginId, correlationId, lane);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(pluginId, correlationId, lane);
    const rec = this.children.get(pending.pluginId);
    const same = rec && rec.credential.generation === pending.generation;
    if (same && pending.idBytes && !pending.idsReleased) {
      rec.idBytes = Math.max(0, rec.idBytes - pending.idBytes);
    }
    if (pending.cancel) {
      this.cancelPendingTotal--;
      if (same) rec.cancelPending--;
    } else if (same) {
      this.#retainAdmit(rec, pending);
      rec.callPending--;
      this.callPendingTotal--;
    } else {
      this.callPendingTotal--;
    }
    // The parked payload belongs to the call lane. A cancel that expires
    // leaves that lane pending, so the line stays until the call settles.
    // #dropCall removes it when the cancellation succeeds. Draining while
    // this take still holds the cancel would write that line first.
    if (same && lane === 'call') this.#unpark(rec, correlationId);
    const callRemains = same && lane === 'cancel'
      && this.pending.has(pending.pluginId, correlationId, 'call');
    if (callRemains) {
      rec.parkHold = true;
      rec.parkHoldId = correlationId;
    }
    try {
      if (same) this.#dropUnsent(rec, correlationId, lane);
    } finally {
      if (callRemains) {
        rec.parkHold = false;
        rec.parkHoldId = null;
      }
    }
    if (same && !callRemains) this.#drainPark(rec);
    this.#maybeResumeAll();
    return pending;
  }

  #authz(rec, msg) {
    if (!rec || rec.dead || rec.exited) return 'unknown-plugin';
    const credential = msg.credential;
    if (!credential || typeof credential !== 'object') return 'credential-mismatch';
    if (credential.pluginId !== msg.pluginId || credential.pluginId !== rec.credential.pluginId) {
      return 'forged-plugin-id';
    }
    if (credential.generation !== rec.credential.generation) return 'stale-credential';
    if (credential.version !== rec.credential.version) return 'credential-mismatch';
    const grants = Array.isArray(credential.grants) ? credential.grants : [];
    if (!sameGrants(grants, rec.credential.grants)) return 'credential-mismatch';
    if (!secretMatch(credential.secret, rec.credential.secret)) return 'credential-mismatch';
    if (msg.kind === 'call' && !rec.credential.grants.includes('*') && !rec.credential.grants.includes(msg.port)) {
      return 'credential-mismatch';
    }
    return null;
  }

  #reject(msg, code, coalesce) {
    this.#enqueue({
      kind: 'rejected',
      code,
      for: msg.kind === 'cancel' ? 'cancel' : 'call',
      pluginId: msg.pluginId,
      correlationId: msg.correlationId,
      generation: msg.credential?.generation,
    }, 10, coalesce);
  }

  // Spend data bytes, parse every frame in the chunk, then promote.
  // A cancel acknowledgement does not spend the window, and in this read
  // it drops its parked call before that call can be promoted.
  // credit-response spends only result lines. credit-wait spends result
  // lines and writes cancelled without spending. echo keeps no window and
  // skips grant echoes. ignore-cancel and flood are not credit senders;
  // their stdout is data. A grant line from a child is control, same as
  // a cancel ack, so it cannot be flushed back as data credit.
  #applyStdout(rec, chunk) {
    if (rec.dead || this.closed || chunk == null) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return;
    const credit = accountStdoutCredit(rec.framer.pendingTail(), buf, rec.stdoutCreditCharged || 0);
    if (credit.refund > 0) this.#refundStdout(rec, credit.refund);
    if (credit.spend > 0) this.#takeStdout(rec, credit.spend);
    rec.stdoutCreditCharged = credit.charged;
    this.#onChild(rec, buf);
    this.#noteMuxBudget();
  }

  #onChild(rec, chunk) {
    if (rec.dead || this.closed) return;
    rec.childReads += 1;
    const incoming = rec.stash ? Buffer.concat([rec.stash, chunk]) : chunk;
    rec.stash = null;
    rec.inFlightTailBytes = 0;
    let offset = 0;
    try {
      while (offset < incoming.length) {
        if (rec.paused || rec.dead) {
          this.#retainTail(rec, incoming.subarray(offset));
          return;
        }
        const end = Math.min(incoming.length, offset + PARTIAL_READ_CHUNK);
        const slice = incoming.subarray(offset, end);
        offset = end;
        // The rest of this chunk is not in the framer and not in readableLength.
        // #retainTail drops it once the child is dead, so the fault snapshot
        // has to see it first.
        rec.inFlightTailBytes = incoming.length - offset;
        let stopped = false;
        try {
          rec.framer.feed(slice);
          stopped = this.#pullFrames(rec);
        } catch (err) {
          const code = err.constructor?.name || 'framing-error';
          if (code === 'NdjsonOversizeError') this.caps.partial = true;
          this.#fault(rec, code);
          return;
        }
        this.#accountCaps(rec);
        if (stopped || rec.paused || rec.dead) {
          this.#retainTail(rec, incoming.subarray(offset));
          return;
        }
        rec.inFlightTailBytes = 0;
      }
    } finally {
      rec.childReads -= 1;
      if (rec.childReads === 0 && !rec.dead) {
        rec.inFlightTailBytes = 0;
        this.#refillCredit(rec);
        this.#drainPark(rec);
      }
    }
  }

  // A parsed reply that did not fit stays on `deferred` as an encoded buffer.
  // Its bytes are charged until it is queued or the generation is retired.
  // Later complete lines stay in the framer. Both are retried in order.
  #pullFrames(rec) {
    while (rec.deferred.length > 0) {
      const held = rec.deferred.shift();
      this.#unhold(rec, held);
      const outcome = this.#fromChild(rec, held.msg, held.buf);
      if (outcome?.defer) {
        this.#park(rec, held.msg, outcome.buf, true, outcome.need);
        return true;
      }
    }
    for (const msg of rec.framer.frames()) {
      const outcome = this.#fromChild(rec, msg, null);
      if (outcome?.defer) {
        this.#park(rec, msg, outcome.buf, false, outcome.need);
        return true;
      }
    }
    return false;
  }

  // `front` keeps a replayed hold ahead of anything parked in the same pass.
  // A missing buffer still charges `need`. The parsed object is retained for
  // the retry, and an uncharged copy would sit outside B_t and totalGlobal.
  // The parked buffer replaces the pending identifiers. Releasing them here
  // keeps pluginBytes and bufferedBytes equal to the sum checked before the defer.
  #releaseHeldIds(rec, msg) {
    if (!msg) return;
    const lane = msg.kind === 'cancelled' ? 'cancel' : 'call';
    const pending = this.pending.get(rec.credential.pluginId, msg.correlationId, lane);
    if (!pending || pending.idsReleased) return;
    if (pending.generation !== rec.credential.generation) return;
    pending.idsReleased = true;
    if (pending.idBytes) rec.idBytes = Math.max(0, rec.idBytes - pending.idBytes);
  }

  #park(rec, msg, buf, front, need = null) {
    const size = buf ? buf.length : (need ?? 0);
    const held = { msg, buf: buf ?? null, bytes: size, need: size };
    this.#releaseHeldIds(rec, msg);
    if (front) rec.deferred.unshift(held);
    else rec.deferred.push(held);
    rec.deferredBytes += held.bytes;
    if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
  }

  #unhold(rec, held) {
    rec.deferredBytes = Math.max(0, rec.deferredBytes - (held?.bytes ?? 0));
  }

  // A held reply can move onto a queue once it fits. Unpausing earlier would
  // parse more stdout; unpausing when it still does not fit spins.
  #holdFits(rec) {
    const held = rec.deferred[0];
    if (!held || rec.dead) return false;
    const loFull = (this.lo.get(rec.credential.pluginId)?.length ?? 0) >= this.capsConfig.lo;
    if (loFull && held.msg?.kind !== 'cancelled') return false;
    const lane = held.msg?.kind === 'cancelled' ? 'cancel' : 'call';
    const pending = this.pending.get(rec.credential.pluginId, held.msg?.correlationId, lane);
    const ids = pending && !pending.idsReleased ? (pending.idBytes ?? 0) : 0;
    const need = held.buf ? held.buf.length : (held.need ?? 0);
    const resulting = this.#pluginBytes(rec) - held.bytes - ids + need;
    if (resulting > this.#childCeiling(rec)) return false;
    const queued = held.buf ? held.buf.length : 0;
    const extra = queued - held.bytes;
    // The parked bytes are already in bufferedBytes(). Growth is new bytes
    // and has to clear every live window, including this child's remainder.
    // A pure move adds nothing. The bytes that land still sit beside those
    // windows: the held copy leaves the sum as the queued copy joins it.
    if (extra > 0 && !this.#fitsGlobal(extra, null)) return false;
    return this.bufferedBytes() - held.bytes + queued + this.#siblingCredit(null) <= this.#globalCap();
  }

  // Never discard unread bytes. A tail that fits stays in `stash`. A tail that
  // would pass the cap is pushed back onto the child's stdout and the child
  // stays paused, so the next resume sees the same bytes in order.
  #retainTail(rec, tail) {
    if (tail.length === 0 || rec.dead) return;
    const perChild = rec.flowOk ? rec.bT : rec.limits.total;
    const room = Math.min(
      Math.max(0, perChild - this.#pluginBytes(rec)),
      Math.max(0, this.#globalCap() - this.bufferedBytes()),
    );
    if (tail.length <= room) {
      rec.stash = Buffer.from(tail);
      rec.inFlightTailBytes = 0;
      return;
    }
    this.caps.total = true;
    if (!rec.paused) this.#pause(rec, 'total');
    else rec.child.stdout.pause();
    try {
      rec.child.stdout.unshift(Buffer.from(tail));
      rec.inFlightTailBytes = 0;
    } catch {
      this.#fault(rec, 'total-cap');
    }
    if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
  }

  #accountCaps(rec) {
    if (this.enforceFlow && rec.flowOk) {
      this.#accountReserved(rec);
      return;
    }
    // An unfinished frame cannot shrink while stdout is paused, so crossing
    // the room left beside the retained ids is a typed fault. Pausing instead
    // would wait for bytes that make the frame larger.
    const frameRoom = Math.max(0, rec.limits.total - rec.idBytes);
    if (!rec.dead && rec.framer.pendingBytes() > frameRoom) {
      this.caps.total = true;
      this.#fault(rec, 'total-cap');
      return;
    }
    if (this.#pluginBytes(rec) > rec.limits.total) {
      this.caps.total = true;
      this.#pause(rec, 'total');
    }
    // An unfinished frame cannot shrink. The framer throws NdjsonOversizeError
    // only once unterminated bytes are more than MAX_RESIDUAL.
    if (rec.framer.pendingBytes() > this.partialHighWater) {
      this.caps.partial = true;
      if (this.enforcePartial) {
        this.#fault(rec, 'partial-cap');
        return;
      }
    }
    if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
    this.#maybeResumeAll();
  }

  // Read admission already stopped at B_p and B_t. One posted read of C bytes
  // may have crossed. An unterminated frame cannot shrink, so that crossing is
  // a typed fault. Bytes at or under MAX_RESIDUAL are partial-cap. The framer
  // throws NdjsonOversizeError only once the residual is greater than that.
  #accountReserved(rec) {
    const pending = rec.framer.pendingBytes();
    const noNewline = !rec.framer.hasPendingNewline();
    if (noNewline && pending > rec.bP) {
      this.caps.partial = true;
      if (this.enforcePartial) {
        const consumed = pending + (rec.inFlightTailBytes || 0);
        this.#fault(rec, consumed > MAX_RESIDUAL ? 'NdjsonOversizeError' : 'partial-cap');
        return;
      }
    } else if (noNewline && this.#pluginBytes(rec) > rec.bT) {
      this.caps.total = true;
      this.#fault(rec, 'total-cap');
      return;
    } else if (this.#pluginBytes(rec) > rec.bT) {
      this.caps.total = true;
      this.#pause(rec, 'total');
    }
    if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
    this.#maybeResumeAll();
  }

  #invalidate(reason) {
    if (this.invalidReason || this.closed) return;
    this.invalidReason = reason;
  }

  // A null probe is not a retry. Ignoring it stalls the read, and a later
  // scored miss would treat the missing measurement as a cap failure.
  // release:false records the typed fault and leaves the sockets up, so an
  // exit drain can still read the queue that crossed K_in.
  #noteOverrun(rec, release = true) {
    if (!this.enforceFlow || !rec.flowOk || rec.dead || this.invalidReason) return false;
    if (!release && rec.exitOverrun) return false;
    const unread = this.#stdoutUnread(rec);
    if (this.invalidReason) return true;
    if (!writerOverrun(unread, rec.kIn)) return false;
    const now = this.readSndbuf(rec.stdoutWriter);
    if (!Number.isInteger(now) || now <= 0) {
      this.#invalidate('sndbuf-unavailable');
      return true;
    }
    const code = now > rec.sndbufIn ? BUFFER_ENLARGED : THREAD_WRITER;
    if (!release) {
      rec.exitOverrun = code;
      this.#pushFault(rec, code);
      return true;
    }
    this.#fault(rec, code);
    return true;
  }

  #stdoutUnread(rec) {
    if (!Number.isInteger(rec.stdoutFd)) return null;
    let unread = null;
    try {
      unread = this.flowPending(rec.stdoutFd);
    } catch {
      unread = null;
    }
    if ((!Number.isInteger(unread) || unread < 0) && rec.flowOk && !rec.dead && !this.closed) {
      this.#invalidate('fionread-unavailable');
      return null;
    }
    return unread;
  }

  #stdinQueued(rec) {
    if (!Number.isInteger(rec.stdinProbe)) return null;
    let queued = null;
    try {
      queued = this.flowPending(rec.stdinProbe);
    } catch {
      queued = null;
    }
    if ((!Number.isInteger(queued) || queued < 0) && rec.flowOk && !rec.dead && !this.closed) {
      this.#invalidate('fionread-unavailable');
      return null;
    }
    return queued;
  }

  // stdinQueued > K_out from a parent that did not raise SO_SNDBUF is a flip.
  // The measured queue is not adopted as a new K_out.
  #noteStdinCeiling(rec) {
    if (!this.enforceFlow || !rec.flowOk || rec.dead || this.invalidReason || this.flip) return false;
    const queued = this.#stdinQueued(rec);
    if (this.invalidReason) return true;
    if (!Number.isInteger(queued) || queued <= rec.kOut) return false;
    const now = this.readSndbuf(rec.stdinFd);
    if (!Number.isInteger(now) || now <= 0) {
      this.#invalidate('sndbuf-unavailable');
      return true;
    }
    if (now > rec.sndbufOut) return false;
    this.flip = 'stdin-overrun';
    this.#fault(rec, 'stdin-overrun');
    return true;
  }

  #armProbe(rec) {
    if (!this.enforceFlow || !rec.flowOk || rec.probeTimer || rec.dead) return;
    rec.probeTimer = setInterval(() => {
      if (rec.dead || this.invalidReason || this.flip) {
        this.#disarmProbe(rec);
        return;
      }
      this.#noteStdinCeiling(rec);
      // A paused socket emits no read. A global hold with nothing in
      // userspace never pauses, so the same timer has to see that child too.
      if (!rec.paused && !rec.readHeld) return;
      this.#noteOverrun(rec);
    }, PROBE_INTERVAL_MS);
  }

  #disarmProbe(rec) {
    if (!rec.probeTimer) return;
    clearInterval(rec.probeTimer);
    rec.probeTimer = null;
  }

  #releaseFlow(rec) {
    this.#disarmCreditFlush(rec);
    this.#clearParkTimer(rec);
    this.#clearEnv(rec);
    this.#clearDrainTimer(rec);
    this.#disarmProbe(rec);
    if (Number.isInteger(rec.stdinProbe) && rec.stdinProbe >= 0) closeFd(rec.stdinProbe);
    rec.stdinProbe = null;
    if (Number.isInteger(rec.stdoutWriter) && rec.stdoutWriter >= 0) closeFd(rec.stdoutWriter);
    rec.stdoutWriter = null;
    rec.stdoutSocket?.destroy();
    rec.stdinSocket?.destroy();
    rec.stdoutSocket = null;
    rec.stdinSocket = null;
  }

  #pauseOverGlobal() {
    this.caps.total = true;
    this.#pauseInput();
    for (const rec of this.children.values()) {
      if (rec.dead || rec.paused) continue;
      if (this.#pluginBytes(rec) > 0) this.#pause(rec, 'global');
    }
  }

  // The kernel socket is the shared input. Pausing child stdout does not stop
  // a partial mux frame from growing in the bridge.
  #pauseInput() {
    if (this.inputPaused || this.closed || this.framingFault) return;
    this.inputPaused = true;
    this.caps.total = true;
    this.muxReadPosted = false;
    this.socket.pause();
  }

  #resumeInput() {
    if (!this.inputPaused || this.closed || this.framingFault) return;
    if (this.bufferedBytes() > this.#globalCap() / 2) return;
    this.inputPaused = false;
    this.#considerMuxRead();
  }

  #pause(rec, reason) {
    // Exit drain has to read through EOF. A budget pause here stops the
    // handle, and the callback's true return does not start it again, so
    // the queued response never arrives and the record stays accounted.
    if (rec.exitDrain || rec.exitFinished) return;
    if (rec.paused || rec.dead) return;
    rec.paused = true;
    rec.pauseReason = reason;
    rec.child.stdout.pause();
    this.#armProbe(rec);
    if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
  }

  #unpause(rec) {
    if (!rec.paused || rec.dead) return;
    rec.paused = false;
    rec.pauseReason = null;
    this.#disarmProbe(rec);
    let stopped = false;
    try {
      stopped = this.#pullFrames(rec);
    } catch (err) {
      const code = err.constructor?.name || 'framing-error';
      if (code === 'NdjsonOversizeError') this.caps.partial = true;
      this.#fault(rec, code);
      return;
    }
    if (stopped || rec.paused || rec.dead) return;
    if (rec.stash) {
      const stash = rec.stash;
      rec.stash = null;
      this.#onChild(rec, stash);
    }
    this.#considerRead(rec);
  }

  // Resume does not wait for another stdout 'data' event. A paused stream emits none.
  #maybeResumeAll() {
    this.#resumeInput();
    this.#considerMuxRead();
    this.#repairStuckReads();
    const buffered = this.bufferedBytes();
    const globalLow = buffered <= this.#globalCap() / 2;
    const globalOpen = buffered <= this.#globalCap();
    for (const rec of this.children.values()) {
      if (!rec.paused || rec.dead) continue;
      if (rec.pauseReason === 'global') {
        if (globalLow || this.#holdFits(rec)) this.#unpause(rec);
      } else if (rec.pauseReason === 'partial') {
        if (globalOpen && rec.framer.pendingBytes() <= this.partialLowWater) this.#unpause(rec);
      } else if (rec.pauseReason === 'total') {
        // A held reply resumes only once that reply fits. The half-ceiling
        // path is for a pause with nothing waiting; using it while a reply
        // is held spins, because the reply still does not fit.
        if (rec.deferred.length > 0) {
          if (this.#holdFits(rec)) this.#unpause(rec);
        } else if (globalLow && this.#pluginBytes(rec) <= this.#childCeiling(rec) / 2) {
          this.#unpause(rec);
        }
      }
    }
    for (const rec of this.children.values()) {
      if (!rec.dead && rec.flowOk && !rec.paused) this.#considerRead(rec);
    }
    for (const rec of this.children.values()) {
      if (!rec.dead && rec.flowOk) this.#refillCredit(rec);
    }
  }

  #fromChild(rec, raw, prepared = null) {
    if (rec.dead) return;
    const msg = normalizeEcho(raw);
    if (msg.kind === 'flood') {
      this.#bulk(rec);
      return;
    }
    const claimed = Object.hasOwn(raw, 'pluginId') ? raw.pluginId : msg.pluginId;
    let pluginId = rec.credential.pluginId;
    if (this.stampIdentity) {
      if (claimed != null && claimed !== rec.credential.pluginId) {
        this.#retireForged(rec, msg);
        return;
      }
    } else {
      pluginId = claimed ?? rec.credential.pluginId;
    }
    if (msg.kind !== 'result' && msg.kind !== 'cancelled' && msg.kind !== 'error') return;
    const completed = this.#complete(rec, pluginId, msg, prepared);
    if (completed?.defer) return completed;
    if (msg.kind === 'cancelled' && completed === true) this.#dropCall(rec, pluginId, msg.correlationId);
  }

  // A forged child reply settles the waiter on the lane it claimed, under the
  // supervisor-stamped plugin id. Leaving that entry pending would occupy a
  // slot until the deadline after the kernel had already been rejected.
  #retireForged(rec, msg) {
    const lane = msg.kind === 'cancelled' ? 'cancel' : 'call';
    const pluginId = rec.credential.pluginId;
    if (!this.#roomHi(pluginId)) return;
    const pending = this.#take(pluginId, msg.correlationId, lane);
    this.#enqueue({
      kind: 'rejected',
      code: 'forged-plugin-id',
      for: lane,
      pluginId,
      correlationId: msg.correlationId,
      generation: pending?.generation ?? rec.credential.generation,
    }, 10, false);
  }

  // A cancel acknowledgement retires the matching call. An unsolicited cancel,
  // or one from an older generation, leaves the call in place.
  #dropCall(rec, pluginId, correlationId) {
    const pending = this.pending.get(pluginId, correlationId, 'call');
    if (!pending || pending.cancel) return;
    if (pending.generation !== rec.credential.generation) return;
    this.#take(pluginId, correlationId, 'call');
    this.#enqueue({
      kind: 'cancelled',
      for: 'call',
      pluginId,
      correlationId,
      generation: pending.generation,
    }, 10, false);
  }

  #complete(rec, pluginId, msg, prepared) {
    const lane = msg.kind === 'cancelled' ? 'cancel' : 'call';
    const pending = this.pending.get(pluginId, msg.correlationId, lane);
    if (!pending) {
      if (this.#ownedByOther(pluginId, msg.correlationId)) {
        this.#enqueue({
          kind: 'rejected',
          code: 'correlation-collision',
          for: 'call',
          pluginId: rec.credential.pluginId,
          correlationId: msg.correlationId,
          generation: rec.credential.generation,
        }, 10, false);
      }
      return false;
    }
    if (pending.generation !== rec.credential.generation) return false;
    const priority = msg.kind === 'cancelled' ? 10 : 1;
    let buf = prepared ?? null;
    if (!buf) {
      try {
        buf = encodeMux({
          kind: msg.kind,
          code: msg.code,
          for: lane,
          pluginId,
          correlationId: msg.correlationId,
          payload: msg.payload,
          sendTs: pending.sendTs,
          ingressTs: pending.ingressTs,
          egressTs: performance.now(),
          version: rec.credential.version,
          generation: pending.generation,
          grants: [...rec.credential.grants],
        });
      } catch {
        this.#take(pluginId, msg.correlationId, lane);
        this.#enqueueTerminal({
          kind: 'error',
          code: 'result-oversize',
          for: lane,
          pluginId: pending.pluginId,
          correlationId: pending.correlationId,
          generation: pending.generation,
        });
        return false;
      }
    }
    // Grants and timestamps are attached here, so the mux frame can be larger
    // than the child's line. Parking releases the pending identifiers, so the
    // retained sum is this frame in their place. A reply that still does not
    // fit in B_t or B_g is rejected. Deferring it would keep both.
    const ceiling = this.#childCeiling(rec);
    const pendingIds = pending.idsReleased ? 0 : (pending.idBytes ?? 0);
    const resulting = this.#pluginBytes(rec) - pendingIds + buf.length;
    // The pending identifiers are already in the sums. The mux frame can be
    // larger: version, grants, and timestamps are stamped here. That growth
    // sits beside every live send window, including the unspent remainder of
    // this child's window. The stdout line already left the framer. A data
    // line already left the window; the remainder is still advertised. A
    // cancel ack never spent the window. Omitting either remainder lets the
    // stamp occupy credit the child has not written yet.
    const expansion = buf.length - pendingIds;
    if (resulting > ceiling || (expansion > 0 && !this.#fitsGlobal(expansion, null))) {
      this.caps.total = true;
      const still = this.#take(pluginId, msg.correlationId, lane);
      if (still) {
        this.#enqueueTerminal({
          kind: 'error',
          code: 'total-cap',
          for: lane,
          pluginId: still.pluginId,
          correlationId: still.correlationId,
          generation: still.generation,
        });
      }
      return false;
    }
    // One stdout chunk can carry many results. Pause does not stop this loop.
    // The low-priority queue is full. The reply stays with its waiter. The
    // identifiers are released when it is parked, so the cap still holds.
    if (priority < 10 && (this.lo.get(pluginId)?.length ?? 0) >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
      return { defer: true, buf };
    }
    if (priority >= 10 && !this.#roomHi(pluginId)) {
      const still = this.#take(pluginId, msg.correlationId, lane);
      if (still) {
        this.#enqueueTerminal({
          kind: 'error',
          code: 'hi-cap',
          for: lane,
          pluginId: still.pluginId,
          correlationId: still.correlationId,
          generation: still.generation,
        });
      }
      return false;
    }
    if (!this.#take(pluginId, msg.correlationId, lane)) return false;
    if (msg.kind === 'result') this.answered++;
    this.#enqueueBuf(buf, priority, pluginId);
    return true;
  }

  #ownedByOther(pluginId, correlationId) {
    for (const pending of this.pending.values()) {
      if (Object.is(pending.correlationId, correlationId) && !Object.is(pending.pluginId, pluginId)) return true;
    }
    return false;
  }

  #bulk(rec) {
    this.bulkSeen++;
    const q = this.lo.get(rec.credential.pluginId);
    if (q && q.length >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
      return;
    }
    const buf = encodeMux({ kind: 'flood', pluginId: rec.credential.pluginId, correlationId: 0 });
    // Additional mux bytes. Every live window, including this child's unspent
    // credit, has to leave room for the frame.
    if (!this.#fitsGlobal(buf.length, null)) {
      this.caps.total = true;
      this.#pause(rec, 'global');
      return;
    }
    this.#enqueueBuf(buf, 0, rec.credential.pluginId);
    const after = this.lo.get(rec.credential.pluginId);
    if (after && after.length >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
    }
  }

  #pipePending(rec) {
    const fd = rec.child?.stdout?._handle?.fd;
    if (!Number.isInteger(fd)) return null;
    try {
      return this.pipeProbe(fd);
    } catch {
      return null;
    }
  }

  // The snapshot is taken before the record is marked dead. Exit drain uses
  // it alone: the typed overrun has to be visible, and the read socket has
  // to stay up until stdout reaches EOF.
  #pushFault(rec, code) {
    const inFlightTailBytes = rec.inFlightTailBytes || 0;
    const pluginBytes = this.#pluginBytes(rec);
    const bufferedBytes = this.bufferedBytes() + inFlightTailBytes;
    const stdoutUnread = this.enforceFlow && rec.flowOk ? this.#stdoutUnread(rec) : null;
    const stdinQueued = this.enforceFlow && rec.flowOk ? this.#stdinQueued(rec) : null;
    const pipe = stdoutUnread == null ? this.#pipePending(rec) : null;
    const pipeUnread = stdoutUnread ?? (pipe ? pipe.unread : null);
    const pipeCapacity = rec.kIn ?? (pipe ? pipe.capacity : null);
    const kernelKnown = pipeUnread != null && (stdinQueued != null || !rec.flowOk);
    const accountedBytes = !kernelKnown
      ? null
      : (rec.flowOk
        ? pluginBytes + inFlightTailBytes + pipeUnread + (stdinQueued ?? 0)
        : bufferedBytes + pipeUnread);
    if (bufferedBytes > this.bufferedHighWater) this.bufferedHighWater = bufferedBytes;
    this.faults.push({
      pluginId: rec.credential.pluginId,
      code,
      pendingBytes: rec.framer.pendingBytes(),
      bufferedBytes,
      pluginBytes,
      inFlightTailBytes,
      pipeUnread,
      pipeCapacity,
      stdoutUnread: pipeUnread,
      stdinQueued: rec.flowOk ? stdinQueued : 0,
      kIn: rec.kIn,
      kOut: rec.kOut,
      accountedBytes,
    });
  }

  #fault(rec, code) {
    if (rec.dead) return;
    // bufferedBytes() skips dead children and #retainTail drops a dead child's
    // chunk tail. Read both, and the kernel queues, before that cleanup.
    this.#pushFault(rec, code);
    rec.inFlightTailBytes = 0;
    rec.dead = true;
    this.#releaseFlow(rec);
    if (code === 'hi-cap') this.caps.hi = true;
    // Queued frames already left the pending table. Dropping them here strands
    // the kernel waiter. Frames with no waiter (floods) are bounded by the
    // queue cap. Unparsed input and held replies still have waiters.
    rec.framer = new NdjsonFramer();
    rec.stash = null;
    rec.deferred = [];
    rec.deferredBytes = 0;
    rec.stdinControl = [];
    rec.stdinPayload = [];
    rec.stdinWriting = false;
    rec.outbound = 0;
    this.#dropStale(rec.credential.pluginId, rec.credential.generation);
    this.#failPending(rec, code);
    if (rec.child.exitCode == null && rec.child.signalCode == null) this.#signalGroup(rec);
  }

  // `error` can be the only child event. Leaving exitDone pending makes
  // respawn wait forever for an exit that never arrives.
  #onSpawnError(rec, err) {
    if (rec.dead) {
      rec.exited = true;
      rec.exitFinished = true;
      this.#settleExit(rec);
      return;
    }
    this.#releaseFlow(rec);
    rec.dead = true;
    rec.exited = true;
    rec.exitFinished = true;
    rec.stash = null;
    rec.deferred = [];
    rec.deferredBytes = 0;
    rec.stdinControl = [];
    rec.stdinPayload = [];
    rec.stdinWriting = false;
    rec.outbound = 0;
    this.#dropStale(rec.credential.pluginId, rec.credential.generation);
    this.#failPending(rec, err?.code || 'spawn-error');
    if (rec.child.exitCode == null && rec.child.signalCode == null) this.#signalGroup(rec);
    this.#settleExit(rec);
  }

  // The plugin's pid is its process group once the wrapper has called
  // setpgid. SIGKILL reaches a grandchild that joined the group. A kill
  // before that call returns ESRCH; the flag stays clear so a later exit
  // path can try the group again, and the leader is signaled directly so
  // respawn and close do not wait out the exit fallback. Reap runs after
  // libuv has collected the leader.
  #signalGroup(rec) {
    const pid = rec?.child?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || rec.groupSignaled) return;
    const first = this.#killGroup(pid);
    if (first === 'ok') {
      rec.groupSignaled = true;
      return;
    }
    if (first !== 'esrch') return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* the leader is already gone */ }
    if (this.#killGroup(pid) === 'ok') rec.groupSignaled = true;
  }

  // 'ok' is a delivered group signal. 'esrch' means setpgid has not run.
  // Any other failure leaves the flag clear so the next path retries.
  #killGroup(pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return 'ok';
    } catch (err) {
      return err?.code === 'ESRCH' ? 'esrch' : 'error';
    }
  }

  #reapGroup(rec) {
    const pid = rec?.child?.pid;
    if (!Number.isInteger(pid) || pid <= 1) return 0;
    const n = reapGroup(pid);
    return Number.isInteger(n) ? n : 0;
  }

  // The first waitpid can run before SIGKILL has made a descendant a zombie.
  // Keep sweeping until several empty passes follow the last reap. close()
  // awaits this promise instead of cancelling the timer.
  #armReap(rec) {
    const pid = rec?.child?.pid;
    if (rec.reapDone) return rec.reapDone;
    if (!Number.isInteger(pid) || pid <= 1) {
      rec.reapDone = Promise.resolve();
      return rec.reapDone;
    }
    rec.reapDone = new Promise((resolve) => {
      let idle = 0;
      const tick = () => {
        const n = this.#reapGroup(rec);
        if (n > 0) idle = 0;
        else idle += 1;
        if (idle < 8) return;
        if (rec.reapTimer) clearInterval(rec.reapTimer);
        rec.reapTimer = null;
        resolve();
      };
      tick();
      if (idle >= 8) return;
      rec.reapTimer = setInterval(tick, 25);
      rec.reapTimer.unref();
    });
    return rec.reapDone;
  }

  #onExit(rec, code, signal) {
    rec.exitCode = code;
    rec.signal = signal;
    rec.exited = true;
    this.#signalGroup(rec);
    this.#armReap(rec);
    // The process exit event arrives before stdout EOF. Dropping the read
    // socket here discards a response still queued in the kernel. Keep the
    // record accounted, close the writer dup so EOF can arrive, and read
    // until the socket ends or the drain deadline. Only then release the
    // stdin probe, the sockets, and the reservation.
    if (!rec.dead && rec.flowOk && rec.stdoutSocket && !rec.stdoutSocket.destroyed) {
      this.#drainStdoutToEnd(rec);
      return;
    }
    rec.stash = null;
    this.#finishExit(rec);
  }

  #clearDrainTimer(rec) {
    if (!rec.exitDrainTimer) return;
    clearTimeout(rec.exitDrainTimer);
    rec.exitDrainTimer = null;
  }

  #drainStdoutToEnd(rec) {
    if (rec.exitDrain || rec.exitFinished) return;
    rec.exitDrain = true;
    // The paused probe may not have run. Classify while the writer dup is
    // still open and the queue is still unread, then keep reading.
    this.#noteOverrun(rec, false);
    if (rec.dead || rec.exitFinished) return;
    if (Number.isInteger(rec.stdoutWriter) && rec.stdoutWriter >= 0) {
      closeFd(rec.stdoutWriter);
      rec.stdoutWriter = null;
    }
    const done = (why) => this.#finishExit(rec, why);
    rec.stdoutSocket.once('end', () => done('eof'));
    rec.stdoutSocket.once('close', () => done('eof'));
    rec.stdoutSocket.once('error', () => done('eof'));
    rec.exitDrainTimer = setTimeout(() => done('timeout'), this.exitDrainMs);
    rec.paused = false;
    rec.pauseReason = null;
    rec.readPosted = false;
    const stash = rec.stash;
    rec.stash = null;
    if (stash && stash.length > 0) this.#onChild(rec, stash);
    if (rec.dead || rec.exitFinished) return;
    this.#considerRead(rec);
  }

  #settleExit(rec) {
    if (rec.exitSettled) return;
    rec.exitSettled = true;
    rec.resolveExit();
  }

  #finishExit(rec, why = 'eof') {
    if (rec.exitFinished) {
      this.#settleExit(rec);
      return;
    }
    rec.exitFinished = true;
    this.#clearDrainTimer(rec);
    if (why === 'timeout') {
      rec.drainTimeout = true;
      if (!this.flip) this.flip = 'drain-timeout';
      if (!rec.dead) this.#pushFault(rec, 'drain-timeout');
    }
    this.#releaseFlow(rec);
    if (!rec.dead) {
      rec.dead = true;
      rec.deferred = [];
      rec.deferredBytes = 0;
      this.#dropStale(rec.credential.pluginId, rec.credential.generation);
      this.#failPending(rec, why === 'timeout' ? 'drain-timeout' : 'child-exited');
    }
    this.#settleExit(rec);
  }

  #failPending(rec, code) {
    this.#rejectParked(rec, code);
    for (const [key, pending] of [...this.pending.entries()]) {
      if (!Object.is(pending.pluginId, rec.credential.pluginId)) continue;
      if (pending.generation !== rec.credential.generation) continue;
      this.#take(key.pluginId, key.correlationId, key.lane);
      this.#enqueueTerminal({
        kind: 'error',
        code,
        for: pending.cancel ? 'cancel' : 'call',
        pluginId: rec.credential.pluginId,
        correlationId: pending.correlationId,
        generation: pending.generation,
      });
    }
    this.#maybeResumeAll();
  }

  #enqueueTerminal(frame) {
    let buf;
    try {
      buf = encodeMux(frame);
    } catch {
      return;
    }
    const child = frame.pluginId;
    // One error for this child is already queued in this burst. Further
    // frames would spend the cap without telling another waiter.
    if (child != null && this.terminalChild.has(child)) {
      this.terminalCoalesced++;
      this.caps.total = true;
      return;
    }
    // Every live send window is credit a sibling may still write. A
    // terminal frame that ignores it fills the cap the response needs.
    if (!this.#fitsGlobal(buf.length, null)) {
      this.terminalCoalesced++;
      this.caps.total = true;
      return;
    }
    if (child != null) {
      this.terminalChild.add(child);
      if (!this.terminalChildClear) {
        this.terminalChildClear = true;
        queueMicrotask(() => {
          this.terminalChild.clear();
          this.terminalChildClear = false;
        });
      }
    }
    this.terminal.push(buf);
    this.queuedBytes += buf.length;
    this.#drain();
  }

  // The bridge is already unusable. These frames are not another admission
  // against the live windows.
  #failAll(code) {
    for (const [key, pending] of [...this.pending.entries()]) {
      this.#take(key.pluginId, key.correlationId, key.lane);
      try {
        const buf = encodeMux({
          kind: 'error',
          code,
          for: pending.cancel ? 'cancel' : 'call',
          pluginId: pending.pluginId,
          correlationId: pending.correlationId,
          generation: pending.generation,
        });
        this.socket.write(buf);
      } catch {
        // The bridge is already unusable.
      }
    }
  }

  #enqueue(frame, priority, coalesce) {
    const pluginId = frame.pluginId;
    const rec = this.children.get(pluginId);
    const live = Boolean(rec && !rec.dead);
    const queueId = live ? pluginId : UNBOUND_QUEUE;
    if (!live && priority >= 10) {
      if (this.unknownRejectQueued) {
        this.unknownRejectsCoalesced++;
        return;
      }
    } else if (coalesce && priority >= 10 && rec?.rejectQueued) {
      rec.rejectsCoalesced++;
      return;
    }
    let buf;
    try {
      buf = encodeMux(frame);
    } catch {
      return;
    }
    // A live child's rejection used to skip both ceilings. One frame is kept
    // only when it fits in B_t and beside every live send window; the rest
    // are coalesced so a sibling's credited response can still land.
    if (live) {
      const overChild = this.#pluginBytes(rec) + buf.length > this.#childCeiling(rec);
      const overGlobal = !this.#fitsGlobal(buf.length, null);
      if (overChild || overGlobal) {
        this.caps.total = true;
        if (priority >= 10) rec.rejectsCoalesced++;
        return;
      }
    } else if (!this.#fitsGlobal(buf.length, null)) {
      this.caps.total = true;
      this.#pauseInput();
      return;
    }
    if (priority >= 10 && !this.#roomHi(queueId)) return;
    this.#enqueueBuf(buf, priority, queueId);
    if (!live && priority >= 10 && (this.hi.get(queueId)?.length ?? 0) > 0) {
      this.unknownRejectQueued = true;
    } else if (coalesce && priority >= 10 && rec && (this.hi.get(pluginId)?.length ?? 0) > 0) {
      rec.rejectQueued = true;
    }
  }

  #roomHi(pluginId) {
    const q = this.hi.get(pluginId);
    if (!q || q.length < this.capsConfig.hi) return true;
    const rec = this.children.get(pluginId);
    if (rec && !rec.dead) this.#fault(rec, 'hi-cap');
    return false;
  }

  // Commit only. Callers admit through #fitsGlobal(extra, null) first. A
  // second check would count this frame again, on top of the windows that
  // admission already included.
  #enqueueBuf(buf, priority, pluginId) {
    const high = priority >= 10;
    const map = high ? this.hi : this.lo;
    const order = high ? this.hiOrder : this.loOrder;
    const q = map.get(pluginId) ?? [];
    if (!map.has(pluginId)) {
      map.set(pluginId, q);
      order.push(pluginId);
    }
    q.push(buf);
    this.queuedBytes += buf.length;
    const rec = this.children.get(pluginId);
    if (rec) {
      if (high) rec.hiBytes += buf.length;
      else rec.loBytes += buf.length;
    }
    if (!high && rec && q.length >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
    }
    this.#drain();
  }

  #shift(map, order, byteField, turnField) {
    if (order.length === 0) return null;
    const start = this[turnField] % order.length;
    for (let n = 0; n < order.length; n++) {
      const idx = (start + n) % order.length;
      const id = order[idx];
      const q = map.get(id);
      if (!q || q.length === 0) continue;
      const buf = q.shift();
      this.queuedBytes -= buf.length;
      const rec = this.children.get(id);
      if (rec) rec[byteField] -= buf.length;
      if (q.length === 0) {
        map.delete(id);
        order.splice(idx, 1);
        this[turnField] = order.length === 0 ? 0 : idx % order.length;
        if (rec) rec.rejectQueued = false;
        if (id === UNBOUND_QUEUE) this.unknownRejectQueued = false;
      } else {
        this[turnField] = (idx + 1) % order.length;
      }
      return { id, buf };
    }
    return null;
  }

  // The mux flood uses this path. A raw socket.write would leave libuv's
  // buffer out of socketOutbound, and the process sum would miss it.
  queueMuxBytes(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0 || this.closed || this.framingFault) return false;
    if (!this.#fitsGlobal(buf.length, null)) return false;
    this.terminal.push(buf);
    this.queuedBytes += buf.length;
    this.#drain();
    return true;
  }

  #drain() {
    if (this.draining || this.closed || this.framingFault) return;
    if (this.socketOutbound > this.#globalCap()) {
      this.#pauseOverGlobal();
      return;
    }
    this.draining = true;
    const step = () => {
      if (this.closed || this.framingFault) {
        this.draining = false;
        return;
      }
      let wrote = 0;
      while (wrote < 64) {
        const nextLen = this.#peekLength();
        if (nextLen == null) {
          this.#resumeBulk();
          this.#maybeResumeAll();
          if (this.hiOrder.length > 0 || this.loOrder.length > 0) continue;
          this.draining = false;
          return;
        }
        // A frame larger than the ceiling can never be written without
        // exceeding it. Settle the waiter with a small error instead.
        if (nextLen > this.#globalCap()) {
          const next = this.#shiftNext();
          const replacement = next ? this.#rejectOversized(next.buf) : null;
          this.caps.total = true;
          if (replacement && replacement.length <= this.#globalCap()) {
            this.terminal.unshift(replacement);
            this.queuedBytes += replacement.length;
          }
          continue;
        }
        if (this.socketOutbound + nextLen > this.#globalCap()) {
          this.#pauseOverGlobal();
          this.draining = false;
          return;
        }
        const sendRoom = this.#muxWriteRoom(nextLen);
        if (sendRoom !== 'ok') {
          this.draining = false;
          if (sendRoom === 'wait') {
            // The send reservation is full, so this queue cannot drain down
            // to the bulk low water. Leave the producer paused there and the
            // cap is never full again. Top it back up while the wait holds.
            this.#topUpBulk();
            this.#waitMuxSend();
          }
          return;
        }
        this.muxSendSpins = 0;
        this.muxSendLast = null;
        const next = this.#shiftNext();
        if (!next) {
          this.draining = false;
          return;
        }
        wrote++;
        if (this.#loLength() < 8) this.#resumeBulk();
        const buf = next.buf;
        this.socketOutbound += buf.length;
        let ok = true;
        try {
          ok = this.socket.write(buf, () => {
            this.socketOutbound = Math.max(0, this.socketOutbound - buf.length);
            this.#maybeResumeAll();
            if (!this.draining && !this.closed && !this.framingFault) this.#drain();
          });
        } catch {
          this.socketOutbound = Math.max(0, this.socketOutbound - buf.length);
          this.draining = false;
          return;
        }
        if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
        if (!ok) {
          this.socket.once('drain', step);
          return;
        }
        if (this.socketOutbound > this.#globalCap()) {
          this.draining = false;
          return;
        }
      }
      setImmediate(step);
    };
    step();
  }

  #peekLength() {
    if (this.terminal.length > 0) return this.terminal[0].length;
    const hi = this.#peekMap(this.hi, this.hiOrder, this.hiTurn);
    if (hi != null) return hi;
    return this.#peekMap(this.lo, this.loOrder, this.loTurn);
  }

  #peekMap(map, order, turn) {
    if (order.length === 0) return null;
    const start = turn % order.length;
    for (let n = 0; n < order.length; n++) {
      const q = map.get(order[(start + n) % order.length]);
      if (q && q.length > 0) return q[0].length;
    }
    return null;
  }

  #shiftNext() {
    return this.#shiftTerminal()
      ?? this.#shift(this.hi, this.hiOrder, 'hiBytes', 'hiTurn')
      ?? this.#shift(this.lo, this.loOrder, 'loBytes', 'loTurn');
  }

  #rejectOversized(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.subarray(4).toString('utf8'));
    } catch {
      return null;
    }
    try {
      return encodeMux({
        kind: 'error',
        code: 'total-cap',
        for: msg.for || (msg.kind === 'cancelled' ? 'cancel' : 'call'),
        pluginId: msg.pluginId,
        correlationId: msg.correlationId,
        generation: msg.generation,
      });
    } catch {
      return null;
    }
  }

  #shiftTerminal() {
    const buf = this.terminal.shift();
    if (!buf) return null;
    this.queuedBytes -= buf.length;
    return { id: null, buf };
  }

  #loLength() {
    let n = 0;
    for (const q of this.lo.values()) n += q.length;
    return n;
  }

  // A mux wait stops the drain above the bulk low water. The producer was
  // paused at the cap and will not be resumed by #resumeBulk, so the queue
  // would sit short of the cap until the peer reads. Fill it back on a later
  // turn. Unpausing inside the stdout read callback resumes a socket that
  // the callback's false return then pauses again, and the child stays dark.
  #topUpBulk() {
    if (this.bulkTopUp || this.closed) return;
    this.bulkTopUp = true;
    setImmediate(() => {
      this.bulkTopUp = false;
      if (this.closed) return;
      for (const rec of this.children.values()) {
        if (rec.dead || !rec.paused || rec.pauseReason !== 'bulk') continue;
        const n = this.lo.get(rec.credential.pluginId)?.length ?? 0;
        if (n < this.capsConfig.lo) this.#unpause(rec);
      }
    });
  }

  #resumeBulk() {
    if (this.#loLength() >= 8) return;
    if (this.#acceptedBytes() > this.#globalCap()) {
      this.#releaseFittingHolds('bulk');
      return;
    }
    for (const rec of this.children.values()) {
      if (rec.paused && rec.pauseReason === 'bulk') this.#unpause(rec);
    }
  }

  #releaseFittingHolds(reason) {
    for (const rec of this.children.values()) {
      if (!rec.paused || rec.dead || rec.pauseReason !== reason) continue;
      if (!this.#holdFits(rec)) continue;
      this.#unpause(rec);
    }
  }
}

function normalizeEcho(msg) {
  if (msg.echoed === true && msg.kind === 'call') {
    return { kind: 'result', correlationId: msg.correlationId, payload: msg.payload, pluginId: msg.pluginId };
  }
  if (msg.echoed === true && msg.kind === 'cancel') {
    return { kind: 'cancelled', correlationId: msg.correlationId, pluginId: msg.pluginId };
  }
  return msg;
}

// The descriptor is still the caller's until Supervisor returns. A throw
// before that returns it, so both ends are closed here.
export function connectEnds(ends, opts = {}) {
  let sup;
  try {
    sup = new Supervisor({
      fd: ends.supervisorFd,
      kMuxIn: ends.kMuxIn,
      kMuxOut: ends.kMuxOut,
      muxSndbuf: ends.muxSndbuf,
      muxRcvbuf: ends.muxRcvbuf,
    }, opts);
  } catch (err) {
    closeFd(ends.supervisorFd);
    ends.kernel.destroy();
    throw err;
  }
  const stub = new KernelStub(ends.kernel, opts.kernel);
  return {
    sup,
    stub,
    close: async () => {
      await sup.close();
      stub.close();
    },
  };
}

export async function connectPair(opts = {}) {
  return connectEnds(await socketPair(), opts);
}
