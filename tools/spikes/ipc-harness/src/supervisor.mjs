// supervisor.mjs — spawn children, stamp identity from the spawn-time credential
// before multiplexing, bind the per-plugin capability credential, run the sweeper.
// Child-supplied plugin ids are untrusted hints (plan §4 B6, spec §4.4).
// stampIdentity:false is the vacuity variant: it trusts the hint and must fail B6.

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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const HARD_FRAME = 1024 * 1024;

export const DEFAULT_CAPS = Object.freeze({
  pending: 32,
  partial: 64 * 1024,
  total: 1024 * 1024,
});

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
    this.partialHighWater = opts.partialHighWater ?? this.capsConfig.partial;
    this.children = new Map();
    this.pending = new Map();
    this.retiredTokens = new Set();
    this.faults = [];
    this.caps = { pending: false, partial: false, total: false };
    this.hi = [];
    this.lo = [];
    this.queuedBytes = 0;
    this.draining = false;
    this.closed = false;
    this.framingFault = null;
    this.bulkSeen = 0;
    this.bridge = new MuxFramer();
    const sweep = opts.sweeper ?? false;
    this.stopSweeper = sweep ? startSweeper(this.useDirect) : () => {};
    socket.on('data', (chunk) => this.#onSocket(chunk));
  }

  spawn(spec) {
    const credential = {
      pluginId: spec.pluginId,
      version: spec.version ?? '0.0.0',
      grants: spec.grants ?? ['*'],
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
      framer: new NdjsonFramer(),
      outbound: 0,
      dead: false,
      paused: false,
      pauseReason: null,
      exitCode: null,
    };
    child.stdout.on('data', (chunk) => this.#onChild(rec, chunk));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', (code, signal) => this.#onExit(rec, code, signal));
    this.children.set(spec.pluginId, rec);
    return { credential, token, pid: child.pid };
  }

  async respawn(pluginId) {
    const prev = this.children.get(pluginId);
    if (!prev) throw new Error(`unknown plugin ${pluginId}`);
    this.retiredTokens.add(prev.token);
    const generation = prev.credential.generation + 1;
    const script = prev.script;
    const env = prev.env;
    if (prev.child.exitCode == null && prev.child.signalCode == null) {
      prev.child.kill();
      await waitExit(prev.child);
    }
    this.children.delete(pluginId);
    return this.spawn({ pluginId, script, env, generation });
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

  async close() {
    this.closed = true;
    this.stopSweeper();
    const waits = [];
    for (const rec of this.children.values()) {
      if (rec.child.exitCode == null && rec.child.signalCode == null) rec.child.kill();
      waits.push(waitExit(rec.child));
    }
    this.socket.destroy();
    await Promise.all(waits);
  }

  #onSocket(chunk) {
    if (this.closed || this.framingFault) return;
    try {
      this.bridge.feed(chunk);
      for (const msg of this.bridge.frames()) this.#onMux(msg);
    } catch (err) {
      this.framingFault = err.constructor?.name || 'framing-error';
      this.socket.pause();
    }
  }

  #onMux(msg) {
    if (msg.kind !== 'call' && msg.kind !== 'cancel') return;
    const rec = this.children.get(msg.pluginId);
    const reason = this.#authz(rec, msg);
    if (reason) {
      this.#reject(msg, reason);
      return;
    }
    const ingressTs = performance.now();
    if (msg.kind === 'cancel') {
      const line = encodeNdjson({ kind: 'cancel', correlationId: msg.correlationId });
      rec.child.stdin.write(line);
      this.pending.set(pendingKey(msg.pluginId, `cancel\0${msg.correlationId}`), {
        pluginId: msg.pluginId,
        correlationId: msg.correlationId,
        sendTs: msg.sendTs,
        ingressTs,
        cancel: true,
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
    if (this.pending.size >= this.capsConfig.pending) {
      this.caps.pending = true;
      this.#reject(msg, 'pending-cap');
      return;
    }
    if (this.bufferedBytes() + bytes > this.capsConfig.total) {
      this.caps.total = true;
      this.#reject(msg, 'total-cap');
      return;
    }
    this.pending.set(pendingKey(msg.pluginId, msg.correlationId), {
      pluginId: msg.pluginId,
      correlationId: msg.correlationId,
      sendTs: msg.sendTs,
      ingressTs,
    });
    rec.outbound += bytes;
    rec.child.stdin.write(line, () => {
      rec.outbound -= bytes;
    });
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

  #reject(msg, code) {
    this.#enqueue({
      kind: 'rejected',
      code,
      pluginId: msg.pluginId,
      correlationId: msg.correlationId,
    }, 10);
  }

  #onChild(rec, chunk) {
    if (rec.dead || this.closed) return;
    try {
      rec.framer.feed(chunk);
      for (const msg of rec.framer.frames()) this.#fromChild(rec, msg);
      if (rec.framer.pendingBytes() >= this.partialHighWater) {
        this.caps.partial = true;
        this.#pause(rec, 'partial');
      } else if (rec.paused && rec.pauseReason === 'partial') {
        rec.paused = false;
        rec.pauseReason = null;
        rec.child.stdout.resume();
      }
      if (this.bufferedBytes() > this.capsConfig.total) {
        this.caps.total = true;
        this.#pause(rec, 'total');
      }
    } catch (err) {
      this.caps.partial = true;
      this.#fault(rec, err.constructor?.name || 'framing-error');
    }
  }

  #pause(rec, reason) {
    if (rec.paused) return;
    rec.paused = true;
    rec.pauseReason = reason;
    rec.child.stdout.pause();
  }

  #fromChild(rec, raw) {
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
          pluginId: rec.credential.pluginId,
          correlationId: msg.correlationId,
        }, 10);
        return;
      }
    } else {
      pluginId = claimed ?? rec.credential.pluginId;
    }
    if (msg.kind !== 'result' && msg.kind !== 'cancelled' && msg.kind !== 'error') return;
    this.#complete(rec, pluginId, msg);
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
          pluginId: rec.credential.pluginId,
          correlationId: msg.correlationId,
        }, 10);
      }
      return;
    }
    this.pending.delete(key);
    this.#enqueue({
      kind: msg.kind,
      code: msg.code,
      pluginId,
      correlationId: msg.correlationId,
      payload: msg.payload,
      sendTs: pending.sendTs,
      ingressTs: pending.ingressTs,
      egressTs: performance.now(),
      version: rec.credential.version,
      generation: rec.credential.generation,
      grants: rec.credential.grants,
    }, msg.kind === 'cancelled' ? 10 : 1);
  }

  #ownedByOther(pluginId, correlationId) {
    for (const pending of this.pending.values()) {
      if (pending.correlationId === correlationId && pending.pluginId !== pluginId) return true;
    }
    return false;
  }

  #bulk(rec) {
    this.bulkSeen++;
    if (this.lo.length >= 32) {
      this.caps.total = true;
      this.#pause(rec, 'bulk');
      return;
    }
    this.#enqueue({ kind: 'flood', pluginId: rec.credential.pluginId, correlationId: 0 }, 0);
  }

  #fault(rec, code) {
    if (rec.dead) return;
    rec.dead = true;
    this.faults.push({
      pluginId: rec.credential.pluginId,
      code,
      pendingBytes: rec.framer.pendingBytes(),
    });
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
      this.pending.delete(key);
      this.#enqueue({
        kind: 'error',
        code,
        pluginId: rec.credential.pluginId,
        correlationId: pending.correlationId,
      }, 10);
    }
  }

  #enqueue(frame, priority) {
    const buf = encodeMux(frame);
    if (priority >= 10) this.hi.push(buf);
    else {
      this.lo.push(buf);
      this.queuedBytes += buf.length;
    }
    this.#drain();
  }

  #drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    const step = () => {
      if (this.closed) {
        this.draining = false;
        return;
      }
      let wrote = 0;
      while (wrote < 64) {
        const fromHi = this.hi.length > 0;
        const buf = fromHi ? this.hi.shift() : this.lo.shift();
        if (!buf) {
          this.draining = false;
          this.#resumeBulk();
          return;
        }
        if (!fromHi) this.queuedBytes -= buf.length;
        wrote++;
        if (this.lo.length < 8) this.#resumeBulk();
        if (!this.socket.write(buf)) {
          this.socket.once('drain', step);
          return;
        }
      }
      setImmediate(step);
    };
    step();
  }

  #resumeBulk() {
    for (const rec of this.children.values()) {
      if (rec.paused && rec.pauseReason === 'bulk') {
        rec.paused = false;
        rec.pauseReason = null;
        rec.child.stdout.resume();
      }
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
