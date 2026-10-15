// supervisor.mjs — spawn children, stamp identity from the spawn-time credential
// before multiplexing, bind the per-plugin capability credential, run the sweeper.
// Child-supplied plugin ids are untrusted hints (plan §4 B6, spec §4.4).
// stampIdentity:false is the vacuity variant: it trusts the hint and must fail B6.
//
// Caps are per plugin, with a global ceiling. Pending entries expire on a
// deadline. The high-priority mux queue is per plugin and faults the child
// that overflows it. Admission rejections are coalesced so they cannot fill it.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MuxFramer, NdjsonFramer, encodeNdjson, encodeMux } from './framing.mjs';
import { pendingKey, socketPair, KernelStub } from './kernel-stub.mjs';
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

function copyGrants(grants) {
  const source = Array.isArray(grants) ? grants : ['*'];
  return Object.freeze(source.map((grant) => String(grant)));
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
    this.pending = new Map();
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
    this.queuedBytes = 0;
    this.draining = false;
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
    const credential = {
      pluginId: spec.pluginId,
      version: spec.version ?? '0.0.0',
      grants: copyGrants(spec.grants),
      generation: spec.generation ?? 1,
      secret: randomBytes(16).toString('hex'),
    };
    const token = randomBytes(16).toString('hex');
    const child = spawn(process.execPath, [spec.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({ ...spec.env, PLERNI_PLUGIN_ID: spec.pluginId }),
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
    child.on('error', () => {});
    child.on('exit', (code, signal) => this.#onExit(rec, code, signal));
    this.children.set(spec.pluginId, rec);
    return { credential: detachCredential(credential), token, pid: child.pid };
  }

  async respawn(pluginId) {
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

  bufferedBytes() {
    let total = this.queuedBytes;
    for (const rec of this.children.values()) {
      total += rec.framer.pendingBytes();
      total += rec.outbound;
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

  #pluginBytes(rec) {
    return rec.framer.pendingBytes() + rec.outbound + rec.hiBytes + rec.loBytes;
  }

  #onSocket(chunk) {
    if (this.closed || this.framingFault) return;
    try {
      this.bridge.feed(chunk);
      for (const msg of this.bridge.frames()) this.#onMux(msg);
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
      this.#reject(msg, reason, false);
      return;
    }
    const ingressTs = performance.now();
    if (msg.kind === 'cancel') {
      const occupied = rec.callPending + rec.cancelPending;
      const globalOccupied = this.callPendingTotal + this.cancelPendingTotal;
      if (occupied >= rec.limits.pending
        || globalOccupied >= this.capsConfig.pendingGlobal
        || rec.cancelPending >= this.capsConfig.cancels) {
        this.caps.pending = true;
        this.#reject(msg, 'pending-cap', true);
        return;
      }
      const line = encodeNdjson({ kind: 'cancel', correlationId: msg.correlationId });
      this.#arm(rec, msg, { cancel: true, bytes: 0, ingressTs });
      rec.child.stdin.write(line);
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
    if (rec.callPending >= rec.limits.pending || this.callPendingTotal >= this.capsConfig.pendingGlobal) {
      this.caps.pending = true;
      this.#reject(msg, 'pending-cap', true);
      return;
    }
    if (this.#pluginBytes(rec) + bytes > rec.limits.total || this.bufferedBytes() + bytes > this.capsConfig.totalGlobal) {
      this.caps.total = true;
      this.#reject(msg, 'total-cap', true);
      return;
    }
    this.#arm(rec, msg, { cancel: false, bytes, ingressTs });
    rec.outbound += bytes;
    rec.child.stdin.write(line, () => {
      rec.outbound -= bytes;
      this.#maybeResumeAll();
    });
  }

  #arm(rec, msg, extra) {
    const timeoutMs = Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : DEFAULT_DEADLINE_MS;
    const correlationId = extra.cancel ? `cancel\0${msg.correlationId}` : msg.correlationId;
    const key = pendingKey(msg.pluginId, correlationId);
    const timer = setTimeout(() => this.#expire(key), timeoutMs);
    this.pending.set(key, {
      pluginId: msg.pluginId,
      correlationId: msg.correlationId,
      generation: rec.credential.generation,
      sendTs: msg.sendTs,
      ingressTs: extra.ingressTs,
      cancel: extra.cancel,
      bytes: extra.bytes,
      timer,
    });
    if (extra.cancel) {
      rec.cancelPending++;
      this.cancelPendingTotal++;
      if (rec.callPending + rec.cancelPending >= rec.limits.pending
        || this.callPendingTotal + this.cancelPendingTotal >= this.capsConfig.pendingGlobal) {
        this.caps.pending = true;
      }
    } else {
      rec.callPending++;
      this.callPendingTotal++;
      if (rec.callPending >= rec.limits.pending || this.callPendingTotal >= this.capsConfig.pendingGlobal) {
        this.caps.pending = true;
      }
    }
  }

  #expire(key) {
    const pending = this.#take(key);
    if (!pending || this.closed) return;
    this.#enqueue({
      kind: 'error',
      code: 'timeout',
      for: pending.cancel ? 'cancel' : 'call',
      pluginId: pending.pluginId,
      correlationId: pending.correlationId,
      generation: pending.generation,
    }, 10, false);
  }

  #take(key) {
    const pending = this.pending.get(key);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(key);
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
    if (grants.join('\0') !== rec.credential.grants.join('\0')) return 'credential-mismatch';
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
        rec.stash = Buffer.from(incoming.subarray(offset));
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

  #accountCaps(rec) {
    if (this.#pluginBytes(rec) > rec.limits.total) {
      this.caps.total = true;
      this.#pause(rec, 'total');
    }
    if (rec.framer.pendingBytes() >= this.partialHighWater) {
      this.caps.partial = true;
      this.#pause(rec, 'partial');
    }
    if (this.bufferedBytes() > this.capsConfig.totalGlobal) this.caps.total = true;
    this.#maybeResumeAll();
  }

  #pause(rec, reason) {
    if (rec.paused || rec.dead) return;
    rec.paused = true;
    rec.pauseReason = reason;
    rec.child.stdout.pause();
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
    const globalLow = this.bufferedBytes() <= this.capsConfig.totalGlobal / 2;
    for (const rec of this.children.values()) {
      if (!rec.paused || rec.dead) continue;
      if (rec.pauseReason === 'partial') {
        if (rec.framer.pendingBytes() <= this.partialLowWater) this.#unpause(rec);
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
    this.#complete(rec, pluginId, msg);
    if (msg.kind === 'cancelled') this.#dropCall(pluginId, msg.correlationId);
  }

  // A cancel acknowledgement retires the call slot. A timeout does not.
  #dropCall(pluginId, correlationId) {
    const pending = this.#take(pendingKey(pluginId, correlationId));
    if (!pending) return;
    this.#enqueue({
      kind: 'cancelled',
      for: 'call',
      pluginId,
      correlationId,
      generation: pending.generation,
    }, 10, false);
  }

  #complete(rec, pluginId, msg) {
    const key = pendingKey(
      pluginId,
      msg.kind === 'cancelled' ? `cancel\0${msg.correlationId}` : msg.correlationId,
    );
    const pending = this.pending.get(key);
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
      return;
    }
    if (pending.generation !== rec.credential.generation) return;
    const lane = msg.kind === 'cancelled' ? 'cancel' : 'call';
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
      this.#take(key);
      this.#enqueue({
        kind: 'error',
        code: 'result-oversize',
        for: lane,
        pluginId: pending.pluginId,
        correlationId: pending.correlationId,
        generation: pending.generation,
      }, 10, false);
      return;
    }
    const priority = msg.kind === 'cancelled' ? 10 : 1;
    if (priority >= 10 && !this.#roomHi(pluginId)) {
      this.#take(key);
      return;
    }
    if (!this.#take(key)) return;
    if (msg.kind === 'result') this.answered++;
    this.#enqueueBuf(buf, priority, pluginId);
  }

  #ownedByOther(pluginId, correlationId) {
    for (const pending of this.pending.values()) {
      if (pending.correlationId === correlationId && pending.pluginId !== pluginId) return true;
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
    rec.outbound = 0;
    this.retiredTokens.add(rec.token);
    this.#failPending(rec, code);
    if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill();
  }

  #onExit(rec, code, signal) {
    rec.exitCode = code;
    rec.signal = signal;
    if (rec.dead) return;
    rec.dead = true;
    this.retiredTokens.add(rec.token);
    this.#failPending(rec, 'child-exited');
  }

  #failPending(rec, code) {
    for (const [key, pending] of this.pending) {
      if (pending.pluginId !== rec.credential.pluginId) continue;
      if (pending.generation !== rec.credential.generation) continue;
      this.#take(key);
      this.#enqueue({
        kind: 'error',
        code,
        for: pending.cancel ? 'cancel' : 'call',
        pluginId: rec.credential.pluginId,
        correlationId: pending.correlationId,
        generation: pending.generation,
      }, 10, false);
    }
  }

  #failAll(code) {
    for (const [key, pending] of [...this.pending.entries()]) {
      this.#take(key);
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
    if (coalesce && priority >= 10) {
      const rec = this.children.get(pluginId);
      if (rec?.rejectQueued) {
        rec.rejectsCoalesced++;
        return;
      }
    }
    let buf;
    try {
      buf = encodeMux(frame);
    } catch {
      return;
    }
    if (priority >= 10 && !this.#roomHi(pluginId)) return;
    this.#enqueueBuf(buf, priority, pluginId);
    if (coalesce && priority >= 10) {
      const rec = this.children.get(pluginId);
      if (rec && (this.hi.get(pluginId)?.length ?? 0) > 0) rec.rejectQueued = true;
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
      } else {
        this[turnField] = (idx + 1) % order.length;
      }
      return { id, buf };
    }
    return null;
  }

  #drain() {
    if (this.draining || this.closed || this.framingFault) return;
    this.draining = true;
    const step = () => {
      if (this.closed || this.framingFault) {
        this.draining = false;
        return;
      }
      let wrote = 0;
      while (wrote < 64) {
        const next = this.#shift(this.hi, this.hiOrder, 'hiBytes', 'hiTurn')
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
        let ok = true;
        try {
          ok = this.socket.write(next.buf);
        } catch {
          this.draining = false;
          return;
        }
        if (!ok) {
          this.socket.once('drain', step);
          return;
        }
      }
      setImmediate(step);
    };
    step();
  }

  #loLength() {
    let n = 0;
    for (const q of this.lo.values()) n += q.length;
    return n;
  }

  #resumeBulk() {
    if (this.#loLength() >= 8) return;
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
  const stub = new KernelStub(ends.kernel);
  return {
    sup,
    stub,
    close: async () => {
      await sup.close();
      stub.close();
    },
  };
}
