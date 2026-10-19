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
import { Socket } from 'node:net';
import { MuxFramer, NdjsonFramer, MAX_RESIDUAL, encodeNdjson, encodeMux } from './framing.mjs';
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
  reapGroup,
  sndbuf,
  wrapperPath,
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

function childEnv(extra) {
  return {
    PATH: process.env.PATH || '',
    ...extra,
  };
}

// Process environment values are strings and cannot carry a NUL. The spawn
// map key keeps the original plugin id; this text is only the child hint.
function envText(value) {
  return String(value).replaceAll('\0', '');
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export class Supervisor {
  constructor(mux, opts = {}) {
    const muxFd = positiveInt(mux?.fd) != null && mux.fd >= 0 ? mux.fd : null;
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
    this.readSndbuf = typeof opts.readSndbuf === 'function' ? opts.readSndbuf : sndbuf;
    this.exitDrainMs = Number.isInteger(opts.exitDrainMs) && opts.exitDrainMs >= 0
      ? opts.exitDrainMs
      : EXIT_DRAIN_MS;
    this.invalidReason = null;
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
    this.wrapper = wrapperPath();
    this.confined = ensureSubreaper();
    const sweep = opts.sweeper ?? false;
    this.stopSweeper = sweep ? startSweeper(this.useDirect) : () => {};
    this.socket.on('error', () => {});
    this.socket.resume();
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
    const flow = this.enforceFlow ? this.#openFlowEnds(limits) : null;
    if (this.enforceFlow && !flow) {
      const err = new Error('flow-control helper unavailable');
      err.code = 'flow-unavailable';
      throw err;
    }
    let child;
    try {
      // fd 2 is /dev/null. The wrapper sets the process group, NO_NEW_PRIVS,
      // and the seccomp filter, then execs the runtime.
      child = spawn(this.wrapper, [process.execPath, spec.script], {
        stdio: flow ? [flow.childStdin, flow.childStdout, 'ignore'] : ['pipe', 'pipe', 'ignore'],
        env: childEnv({ ...spec.env, PLERNI_PLUGIN_ID: envText(spec.pluginId) }),
      });
    } catch (err) {
      closeEnds(flow);
      throw err;
    }
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
      paused: false,
      pauseReason: null,
      exitCode: null,
      rejectQueued: false,
      rejectsCoalesced: 0,
      flow,
      kIn: flow?.kIn ?? null,
      kOut: flow?.kOut ?? null,
      sndbufIn: flow?.sndbufIn ?? null,
      bP: flow?.bP ?? null,
      bT: flow?.bT ?? null,
      flowOk: Boolean(flow),
      stdoutFd: flow?.parentStdout ?? null,
      stdinProbe: flow?.stdinProbe ?? null,
      stdoutWriter: flow?.stdoutWriter ?? null,
      probeTimer: null,
      readPosted: false,
      exitDrain: false,
      exitFinished: false,
      exitDrainTimer: null,
      exitOverrun: null,
    };
    if (flow) this.#attachFlowSockets(rec, flow);
    else {
      child.stdout.on('data', (chunk) => this.#onChild(rec, chunk));
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
    }
    child.on('error', (err) => this.#onSpawnError(rec, err));
    child.on('exit', (code, signal) => this.#onExit(rec, code, signal));
    this.children.set(spec.pluginId, rec);
    if (rec.flowOk) {
      this.#armProbe(rec);
      // The caller can pause before this turn ends. The read is posted only
      // after the gate, on a later turn.
      setImmediate(() => this.#considerRead(rec));
    }
    return { credential: detachCredential(credential), token, pid: child.pid };
  }

  // A negative B_p, B_t, or B_g closes the ends and does not start the child.
  // That rejection is unsatisfiable when the kernel terms alone do not fit.
  // A live process that is already too full is spawn-rejected, which is not
  // a B3 cap failure. K_mux_in + K_mux_out + C is reserved once for the process.
  #openFlowEnds(limits) {
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
    if (this.#occupiedBytes() + reserve + muxReserve > this.capsConfig.totalGlobal) {
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

  #occupiedBytes() {
    let total = this.bufferedBytes();
    for (const rec of this.children.values()) {
      if (!rec.flowOk || rec.dead) continue;
      const unread = this.#stdoutUnread(rec);
      const queued = this.#stdinQueued(rec);
      if (Number.isInteger(unread)) total += unread;
      if (Number.isInteger(queued)) total += queued;
    }
    return total;
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
    stdout.on('data', (chunk) => this.#onChild(rec, chunk));
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
        const chunk = Buffer.from(buf.subarray(0, nread));
        this.#onChild(rec, chunk);
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
    if (this.bufferedBytes() + this.readBytes > this.#globalCap()) {
      if (this.#pluginBytes(rec) > 0) this.#pause(rec, 'global');
      return false;
    }
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
      if (rec.token === token && !rec.dead) return true;
    }
    return false;
  }

  // Refuses a token the crashed child held, and a token that is not the live spawn token.
  async commitIfLive(id, token, effects) {
    if (this.retiredTokens.has(token)) {
      throw new FencedError(`retired fencing token for id=${id}`);
    }
    const live = [...this.children.values()].some((rec) => rec.token === token && !rec.dead);
    if (!live) throw new FencedError(`token is not a live spawn credential for id=${id}`);
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
    }
    return total;
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
    for (const rec of this.children.values()) this.#reapGroup(rec);
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

  // One mux read is at most C. Returning false stops the handle while the
  // shared input is paused; resume() starts it again below the low water.
  #onMuxRead(nread, buf) {
    if (nread > 0) {
      if (nread > this.muxReadHigh) this.muxReadHigh = nread;
      this.#onSocket(buf.subarray(0, nread));
    }
    if (this.inputPaused || this.closed || this.framingFault) return false;
    return true;
  }

  #onSocket(chunk) {
    if (this.closed || this.framingFault) return;
    try {
      this.bridge.feed(chunk);
      for (const msg of this.bridge.frames()) this.#onMux(msg);
      if (this.bufferedBytes() > this.#globalCap()) this.#pauseOverGlobal();
    } catch (err) {
      this.framingFault = err.constructor?.name || 'framing-error';
      this.#failAll(this.framingFault);
      this.socket.destroy();
    }
  }

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
      if (this.#overBytes(rec, bytes + idBytes)) {
        this.caps.total = true;
        this.#reject(msg, 'total-cap', true);
        return;
      }
      this.#arm(rec, msg, { cancel: true, bytes, idBytes, ingressTs });
      rec.outbound += bytes;
      rec.child.stdin.write(line, () => {
        this.#releaseOutbound(rec, bytes);
      });
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
    if (this.#overBytes(rec, bytes + idBytes)) {
      this.caps.total = true;
      this.#reject(msg, 'total-cap', true);
      return;
    }
    this.#arm(rec, msg, { cancel: false, bytes, idBytes, ingressTs });
    rec.outbound += bytes;
    rec.child.stdin.write(line, () => {
      this.#releaseOutbound(rec, bytes);
    });
  }

  #releaseOutbound(rec, bytes) {
    if (rec.dead) return;
    rec.outbound = Math.max(0, rec.outbound - bytes);
    this.#maybeResumeAll();
  }

  #pendingFull(rec) {
    return rec.callPending + rec.cancelPending >= rec.limits.pending
      || this.callPendingTotal + this.cancelPendingTotal >= this.capsConfig.pendingGlobal;
  }

  #overBytes(rec, bytes) {
    const ceiling = this.enforceFlow && rec.flowOk ? rec.bT : rec.limits.total;
    return this.#pluginBytes(rec) + bytes > ceiling
      || this.bufferedBytes() + bytes > this.#globalCap();
  }

  #arm(rec, msg, extra) {
    const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : DEFAULT_DEADLINE_MS;
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
    if (same && pending.idBytes) rec.idBytes = Math.max(0, rec.idBytes - pending.idBytes);
    if (pending.cancel) {
      this.cancelPendingTotal--;
      if (same) rec.cancelPending--;
    } else if (same) {
      rec.callPending--;
      this.callPendingTotal--;
    } else {
      this.callPendingTotal--;
    }
    this.#maybeResumeAll();
    return pending;
  }

  #authz(rec, msg) {
    if (!rec || rec.dead) return 'unknown-plugin';
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

  #onChild(rec, chunk) {
    if (rec.dead || this.closed) return;
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
      if (!rec.dead) rec.inFlightTailBytes = 0;
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
  #park(rec, msg, buf, front, need = null) {
    const size = buf ? buf.length : (need ?? 0);
    const held = { msg, buf: buf ?? null, bytes: size, need: size };
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
    const ids = pending?.idBytes ?? 0;
    const need = held.buf ? held.buf.length : (held.need ?? 0);
    const resulting = this.#pluginBytes(rec) - held.bytes - ids + need;
    if (resulting > this.#childCeiling(rec)) return false;
    const queued = held.buf ? held.buf.length : 0;
    return this.bufferedBytes() - held.bytes + queued <= this.#globalCap();
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
    try {
      return this.flowPending(rec.stdinProbe);
    } catch {
      return null;
    }
  }

  #armProbe(rec) {
    if (!this.enforceFlow || !rec.flowOk || rec.probeTimer || rec.dead) return;
    rec.probeTimer = setInterval(() => {
      if (rec.dead || this.invalidReason) {
        this.#disarmProbe(rec);
        return;
      }
      // A paused socket emits no read. The timer is the probe that still runs.
      if (!rec.paused) return;
      this.#noteOverrun(rec);
    }, PROBE_INTERVAL_MS);
  }

  #disarmProbe(rec) {
    if (!rec.probeTimer) return;
    clearInterval(rec.probeTimer);
    rec.probeTimer = null;
  }

  #releaseFlow(rec) {
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
    this.socket.pause();
  }

  #resumeInput() {
    if (!this.inputPaused || this.closed || this.framingFault) return;
    if (this.bufferedBytes() > this.#globalCap() / 2) return;
    this.inputPaused = false;
    this.socket.resume();
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
    // than the child's line. Admit it only when the resulting #pluginBytes
    // (this frame in place of the pending identifiers) stays ≤ B_t. A frame
    // that does not fit is rejected and dropped. Parking the parsed object
    // or its encoding would keep bytes the cap is not allowed to miss.
    const ceiling = this.#childCeiling(rec);
    const pendingIds = pending.idBytes ?? 0;
    const resulting = this.#pluginBytes(rec) - pendingIds + buf.length;
    if (resulting > ceiling) {
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
    // A reply that does not fit stays with its waiter and is charged; taking
    // it here would leave the kernel with a timeout and the bytes uncounted.
    if (priority < 10 && (this.lo.get(pluginId)?.length ?? 0) >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
      return { defer: true, buf };
    }
    if (this.bufferedBytes() - pendingIds + buf.length > this.#globalCap()) {
      this.caps.total = true;
      this.#pause(rec, 'global');
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
    rec.outbound = 0;
    this.#dropStale(rec.credential.pluginId, rec.credential.generation);
    this.#failPending(rec, code);
    if (rec.child.exitCode == null && rec.child.signalCode == null) this.#signalGroup(rec);
  }

  #onSpawnError(rec, err) {
    if (rec.dead) return;
    this.#releaseFlow(rec);
    rec.dead = true;
    rec.stash = null;
    rec.deferred = [];
    rec.deferredBytes = 0;
    this.#dropStale(rec.credential.pluginId, rec.credential.generation);
    this.#failPending(rec, err?.code || 'spawn-error');
    if (rec.child.exitCode == null && rec.child.signalCode == null) this.#signalGroup(rec);
  }

  // The plugin's pid is its process group. SIGKILL reaches a grandchild that
  // joined the group. Reap runs after libuv has collected the leader.
  #signalGroup(rec) {
    const pid = rec?.child?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || rec.groupSignaled) return;
    rec.groupSignaled = true;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
  }

  #reapGroup(rec) {
    const pid = rec?.child?.pid;
    if (!Number.isInteger(pid) || pid <= 1) return;
    reapGroup(pid);
  }

  #onExit(rec, code, signal) {
    rec.exitCode = code;
    rec.signal = signal;
    this.#signalGroup(rec);
    this.#reapGroup(rec);
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
    const done = () => this.#finishExit(rec);
    rec.stdoutSocket.once('end', done);
    rec.stdoutSocket.once('close', done);
    rec.stdoutSocket.once('error', done);
    rec.exitDrainTimer = setTimeout(done, this.exitDrainMs);
    rec.paused = false;
    rec.pauseReason = null;
    rec.readPosted = false;
    const stash = rec.stash;
    rec.stash = null;
    if (stash && stash.length > 0) this.#onChild(rec, stash);
    if (rec.dead || rec.exitFinished) return;
    this.#considerRead(rec);
  }

  #finishExit(rec) {
    if (rec.exitFinished) return;
    rec.exitFinished = true;
    this.#clearDrainTimer(rec);
    this.#releaseFlow(rec);
    if (rec.dead) return;
    rec.dead = true;
    rec.deferred = [];
    rec.deferredBytes = 0;
    this.#dropStale(rec.credential.pluginId, rec.credential.generation);
    this.#failPending(rec, 'child-exited');
  }

  #failPending(rec, code) {
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
    this.terminal.push(buf);
    this.queuedBytes += buf.length;
    this.#drain();
  }

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
    if (!live && this.bufferedBytes() + buf.length > this.#globalCap()) {
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

export async function connectPair(opts = {}) {
  const ends = await socketPair();
  const sup = new Supervisor({
    fd: ends.supervisorFd,
    kMuxIn: ends.kMuxIn,
    kMuxOut: ends.kMuxOut,
    muxSndbuf: ends.muxSndbuf,
    muxRcvbuf: ends.muxRcvbuf,
  }, opts);
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
