// supervisor.mjs — spawn children, stamp identity from the spawn-time credential
// before multiplexing, bind the per-plugin capability credential, run the sweeper.
// Child-supplied plugin ids are untrusted hints (plan §4 B6, spec §4.4).
// stampIdentity:false is the vacuity variant: it trusts the hint and must fail B6.
//
// Caps are per plugin, with a global ceiling. Pending entries expire on a
// deadline. The high-priority mux queue is per plugin and faults the child
// that overflows it with frames the child itself produced. Kernel-side
// admission rejections are coalesced so they cannot fill that queue.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MuxFramer, NdjsonFramer, encodeNdjson, encodeMux } from './framing.mjs';
import { PendingTable, socketPair, KernelStub } from './kernel-stub.mjs';
import { FencedError, commitExecution, startSweeper } from './authority.mjs';

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
// invents ids cannot open an unbounded set of high-priority queues.
const UNBOUND_QUEUE = '\0unbound';

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

export class Supervisor {
  constructor(socket, opts = {}) {
    this.socket = socket;
    this.stampIdentity = opts.stampIdentity !== false;
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
    this.callPendingTotal = 0;
    this.cancelPendingTotal = 0;
    this.retiredTokens = new Set();
    this.faults = [];
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
    const sweep = opts.sweeper ?? false;
    this.stopSweeper = sweep ? startSweeper(this.useDirect) : () => {};
    socket.on('data', (chunk) => this.#onSocket(chunk));
    socket.on('error', () => {});
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
    const child = spawn(process.execPath, [spec.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ ...spec.env, PLERNI_PLUGIN_ID: envText(spec.pluginId) }),
    });
    const rec = {
      child,
      credential,
      token,
      script: spec.script,
      env: spec.env,
      limits: {
        pending: spec.pending ?? this.capsConfig.pending,
        total: spec.total ?? this.capsConfig.total,
      },
      framer: new NdjsonFramer(),
      outbound: 0,
      stash: null,
      hiBytes: 0,
      loBytes: 0,
      callPending: 0,
      cancelPending: 0,
      dead: false,
      paused: false,
      pauseReason: null,
      exitCode: null,
      rejectQueued: false,
      rejectsCoalesced: 0,
    };
    child.stdout.on('data', (chunk) => this.#onChild(rec, chunk));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.on('error', (err) => this.#onSpawnError(rec, err));
    child.on('exit', (code, signal) => this.#onExit(rec, code, signal));
    this.children.set(spec.pluginId, rec);
    return { credential: detachCredential(credential), token, pid: child.pid };
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
    if (prev.child.exitCode == null && prev.child.signalCode == null) {
      prev.child.kill();
      await waitExit(prev.child);
    }
    this.#discardQueues(pluginId);
    this.children.delete(pluginId);
    return this.spawn({ pluginId, script, env, generation, version, grants, pending, total });
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
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    const waits = [];
    for (const rec of this.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill();
      waits.push(waitExit(rec.child));
    }
    this.socket.destroy();
    await Promise.all(waits);
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
      + (rec.stash?.length ?? 0)
      + this.#stdoutBuffered(rec);
  }

  #onSocket(chunk) {
    if (this.closed || this.framingFault) return;
    try {
      this.bridge.feed(chunk);
      for (const msg of this.bridge.frames()) this.#onMux(msg);
      if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.#pauseOverGlobal();
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
    if (msg.kind === 'cancel') {
      if (this.#pendingFull(rec) || rec.cancelPending >= this.capsConfig.cancels) {
        this.caps.pending = true;
        this.#reject(msg, 'pending-cap', true);
        return;
      }
      const line = encodeNdjson({ kind: 'cancel', correlationId: msg.correlationId });
      const bytes = Buffer.byteLength(line);
      if (this.#overBytes(rec, bytes)) {
        this.caps.total = true;
        this.#reject(msg, 'total-cap', true);
        return;
      }
      this.#arm(rec, msg, { cancel: true, bytes, ingressTs });
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
    if (this.#pendingFull(rec)) {
      this.caps.pending = true;
      this.#reject(msg, 'pending-cap', true);
      return;
    }
    if (this.#overBytes(rec, bytes)) {
      this.caps.total = true;
      this.#reject(msg, 'total-cap', true);
      return;
    }
    this.#arm(rec, msg, { cancel: false, bytes, ingressTs });
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
    return this.#pluginBytes(rec) + bytes > rec.limits.total
      || this.bufferedBytes() + bytes > this.capsConfig.totalGlobal;
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
      timer,
    }, lane);
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
    this.#enqueueTerminal({
      kind: 'error',
      code: 'timeout',
      for: pending.cancel ? 'cancel' : 'call',
      pluginId: pending.pluginId,
      correlationId: pending.correlationId,
      generation: pending.generation,
    });
  }

  #take(pluginId, correlationId, lane) {
    const pending = this.pending.get(pluginId, correlationId, lane);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(pluginId, correlationId, lane);
    const rec = this.children.get(pending.pluginId);
    const same = rec && rec.credential.generation === pending.generation;
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
    let offset = 0;
    while (offset < incoming.length) {
      if (rec.paused || rec.dead) {
        this.#retainTail(rec, incoming.subarray(offset));
        return;
      }
      const end = Math.min(incoming.length, offset + 4096);
      const slice = incoming.subarray(offset, end);
      offset = end;
      try {
        rec.framer.feed(slice);
        for (const msg of rec.framer.frames()) this.#fromChild(rec, msg);
      } catch (err) {
        const code = err.constructor?.name || 'framing-error';
        if (code === 'NdjsonOversizeError') this.caps.partial = true;
        this.#fault(rec, code);
        return;
      }
      this.#accountCaps(rec);
    }
  }

  // Never discard unread bytes. A tail that fits stays in `stash`. A tail that
  // would pass the cap is pushed back onto the child's stdout and the child
  // stays paused, so the next resume sees the same bytes in order.
  #retainTail(rec, tail) {
    if (tail.length === 0 || rec.dead) return;
    const room = Math.min(
      Math.max(0, rec.limits.total - this.#pluginBytes(rec)),
      Math.max(0, this.capsConfig.totalGlobal - this.bufferedBytes()),
    );
    if (tail.length <= room) {
      rec.stash = Buffer.from(tail);
      return;
    }
    this.caps.total = true;
    if (!rec.paused) this.#pause(rec, 'total');
    else rec.child.stdout.pause();
    try {
      rec.child.stdout.unshift(Buffer.from(tail));
    } catch {
      this.#fault(rec, 'total-cap');
    }
    if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.#pauseOverGlobal();
  }

  #accountCaps(rec) {
    // An unfinished frame cannot shrink while stdout is paused, so crossing
    // the total cap with one is a typed fault rather than a permanent pause.
    if (!rec.dead && rec.framer.pendingBytes() > rec.limits.total) {
      this.caps.total = true;
      this.#fault(rec, 'total-cap');
      return;
    }
    if (this.#pluginBytes(rec) > rec.limits.total) {
      this.caps.total = true;
      this.#pause(rec, 'total');
    }
    if (rec.framer.pendingBytes() >= this.partialHighWater) {
      this.caps.partial = true;
      // Do not pause. The unfinished frame cannot shrink until more bytes
      // arrive, and a pause would stall a legal frame or a never-terminated
      // stream short of the framer's typed oversize error.
    }
    if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.#pauseOverGlobal();
    this.#maybeResumeAll();
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
    if (this.bufferedBytes() > this.capsConfig.totalGlobal / 2) return;
    this.inputPaused = false;
    this.socket.resume();
  }

  #pause(rec, reason) {
    if (rec.paused || rec.dead) return;
    rec.paused = true;
    rec.pauseReason = reason;
    rec.child.stdout.pause();
    if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.#pauseOverGlobal();
  }

  #unpause(rec) {
    if (!rec.paused || rec.dead) return;
    rec.paused = false;
    rec.pauseReason = null;
    rec.child.stdout.resume();
    if (rec.stash) {
      const stash = rec.stash;
      rec.stash = null;
      this.#onChild(rec, stash);
    }
  }

  // Resume does not wait for another stdout 'data' event. A paused stream emits none.
  #maybeResumeAll() {
    this.#resumeInput();
    const buffered = this.bufferedBytes();
    const globalLow = buffered <= this.capsConfig.totalGlobal / 2;
    const globalOpen = buffered <= this.capsConfig.totalGlobal;
    for (const rec of this.children.values()) {
      if (!rec.paused || rec.dead) continue;
      if (rec.pauseReason === 'global') {
        if (globalLow) this.#unpause(rec);
      } else if (rec.pauseReason === 'partial') {
        if (globalOpen && rec.framer.pendingBytes() <= this.partialLowWater) this.#unpause(rec);
      } else if (rec.pauseReason === 'total') {
        if (globalLow && this.#pluginBytes(rec) <= rec.limits.total / 2) this.#unpause(rec);
      }
    }
  }

  #fromChild(rec, raw) {
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
        this.#enqueue({
          kind: 'rejected',
          code: 'forged-plugin-id',
          for: 'call',
          pluginId: rec.credential.pluginId,
          correlationId: msg.correlationId,
          generation: rec.credential.generation,
        }, 10, false);
        return;
      }
    } else {
      pluginId = claimed ?? rec.credential.pluginId;
    }
    if (msg.kind !== 'result' && msg.kind !== 'cancelled' && msg.kind !== 'error') return;
    const completed = this.#complete(rec, pluginId, msg);
    if (msg.kind === 'cancelled' && completed) this.#dropCall(rec, pluginId, msg.correlationId);
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

  #complete(rec, pluginId, msg) {
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
    // One stdout chunk can carry many results. Pause does not stop this loop,
    // so the cap is checked before each result is queued.
    if (priority < 10 && (this.lo.get(pluginId)?.length ?? 0) >= this.capsConfig.lo) {
      this.caps.lo = true;
      this.#pause(rec, 'bulk');
      return false;
    }
    const frame = {
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
    };
    let buf;
    try {
      buf = encodeMux(frame);
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
    if (priority >= 10 && !this.#roomHi(pluginId)) {
      this.#take(pluginId, msg.correlationId, lane);
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

  #fault(rec, code) {
    if (rec.dead) return;
    rec.dead = true;
    this.faults.push({
      pluginId: rec.credential.pluginId,
      code,
      pendingBytes: rec.framer.pendingBytes(),
    });
    if (code === 'hi-cap') this.caps.hi = true;
    this.#discardQueues(rec.credential.pluginId);
    rec.framer = new NdjsonFramer();
    rec.stash = null;
    rec.outbound = 0;
    this.retiredTokens.add(rec.token);
    this.#failPending(rec, code);
    if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill();
  }

  #onSpawnError(rec, err) {
    if (rec.dead) return;
    rec.dead = true;
    rec.stash = null;
    this.retiredTokens.add(rec.token);
    this.#failPending(rec, err?.code || 'spawn-error');
    if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill('SIGKILL');
  }

  #onExit(rec, code, signal) {
    rec.exitCode = code;
    rec.signal = signal;
    rec.stash = null;
    if (rec.dead) return;
    rec.dead = true;
    this.retiredTokens.add(rec.token);
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

  #discardQueues(pluginId) {
    for (const [map, bytesOf] of [[this.hi, 'hiBytes'], [this.lo, 'loBytes']]) {
      const q = map.get(pluginId);
      if (!q) continue;
      for (const buf of q) this.queuedBytes -= buf.length;
      map.delete(pluginId);
      const rec = this.children.get(pluginId);
      if (rec) rec[bytesOf] = 0;
    }
    this.hiOrder = this.hiOrder.filter((id) => id !== pluginId);
    this.loOrder = this.loOrder.filter((id) => id !== pluginId);
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
    if (!live && this.bufferedBytes() + buf.length > this.capsConfig.totalGlobal) {
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
    if (this.socketOutbound > this.capsConfig.totalGlobal) {
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
        const next = this.#shiftTerminal()
          ?? this.#shift(this.hi, this.hiOrder, 'hiBytes', 'hiTurn')
          ?? this.#shift(this.lo, this.loOrder, 'loBytes', 'loTurn');
        if (!next) {
          this.#resumeBulk();
          this.#maybeResumeAll();
          if (this.hiOrder.length > 0 || this.loOrder.length > 0) continue;
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
        if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.#pauseOverGlobal();
        if (!ok) {
          this.socket.once('drain', step);
          return;
        }
        if (this.socketOutbound > this.capsConfig.totalGlobal) {
          this.draining = false;
          return;
        }
      }
      setImmediate(step);
    };
    step();
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
    if (this.#acceptedBytes() > this.capsConfig.totalGlobal) return;
    for (const rec of this.children.values()) {
      if (rec.paused && rec.pauseReason === 'bulk') this.#unpause(rec);
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
  const sup = new Supervisor(ends.supervisor, opts);
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
