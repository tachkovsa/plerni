// kernel-stub.mjs — one shared socket pair, port-call handler, revocation endpoint.
// Revocation reports the conditional UPDATE: 1 row → cancelled, 0 rows → lost.
// A lost cancellation is never labelled cancelled (plan §4 B2).

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { MuxFramer, encodeMux } from './framing.mjs';
import { cancelExecution } from './authority.mjs';

// Nested maps keep plugin id `1` distinct from `"1"`, and a correlation id that
// contains NUL distinct from a neighbouring id. A joined string aliases both.
export class PendingTable {
  #byLane = new Map();

  #ids(lane, pluginId, create) {
    let byPlugin = this.#byLane.get(lane);
    if (!byPlugin) {
      if (!create) return null;
      byPlugin = new Map();
      this.#byLane.set(lane, byPlugin);
    }
    let byCorr = byPlugin.get(pluginId);
    if (!byCorr) {
      if (!create) return null;
      byCorr = new Map();
      byPlugin.set(pluginId, byCorr);
    }
    return byCorr;
  }

  has(pluginId, correlationId, lane = 'call') {
    return this.#ids(lane, pluginId, false)?.has(correlationId) === true;
  }

  get(pluginId, correlationId, lane = 'call') {
    const bucket = this.#ids(lane, pluginId, false);
    if (!bucket || !bucket.has(correlationId)) return undefined;
    return bucket.get(correlationId);
  }

  set(pluginId, correlationId, value, lane = 'call') {
    this.#ids(lane, pluginId, true).set(correlationId, value);
    return this;
  }

  delete(pluginId, correlationId, lane = 'call') {
    const byPlugin = this.#byLane.get(lane);
    const bucket = byPlugin?.get(pluginId);
    if (!bucket) return false;
    const removed = bucket.delete(correlationId);
    if (bucket.size === 0) byPlugin.delete(pluginId);
    if (byPlugin.size === 0) this.#byLane.delete(lane);
    return removed;
  }

  get size() {
    let n = 0;
    for (const byPlugin of this.#byLane.values()) {
      for (const byCorr of byPlugin.values()) n += byCorr.size;
    }
    return n;
  }

  *values() {
    for (const byPlugin of this.#byLane.values()) {
      for (const byCorr of byPlugin.values()) yield* byCorr.values();
    }
  }

  *entries() {
    for (const [lane, byPlugin] of this.#byLane) {
      for (const [pluginId, byCorr] of byPlugin) {
        for (const [correlationId, value] of byCorr) {
          yield [{ pluginId, correlationId, lane }, value];
        }
      }
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  clear() {
    this.#byLane.clear();
  }
}

export function socketPair() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const fail = (err) => {
      server.close();
      reject(err);
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const kernel = net.connect({ host: '127.0.0.1', port });
      kernel.once('error', fail);
      server.once('connection', (supervisor) => {
        server.close();
        kernel.removeListener('error', fail);
        kernel.setNoDelay(true);
        supervisor.setNoDelay(true);
        kernel.on('error', () => {});
        supervisor.on('error', () => {});
        resolve({ kernel, supervisor });
      });
    });
  });
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const KERNEL_PENDING_CAP = 512;
const KERNEL_BYTE_CAP = 1024 * 1024;

export class KernelStub {
  constructor(socket, opts = {}) {
    this.socket = socket;
    this.framer = new MuxFramer();
    this.calls = new PendingTable();
    this.cancels = new PendingTable();
    this.sentAt = new Map();
    this.floodFrames = 0;
    this.framingFault = null;
    this.shut = false;
    this.pendingCap = opts.pendingCap ?? KERNEL_PENDING_CAP;
    this.byteCap = opts.byteCap ?? KERNEL_BYTE_CAP;
    this.outbound = 0;
    this.writeQueue = [];
    this.writeBlocked = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => {
      this.shut = true;
      this.writeQueue = [];
      this.#rejectAll('closed');
    });
  }

  bufferedBytes() {
    let total = this.outbound;
    for (const entry of this.writeQueue) total += entry.buf.length;
    return total;
  }

  // A timed-out request must not leave the socket after drain. Bytes already
  // handed to socket.write are in flight and cannot be recalled.
  #dropUnsent(sent) {
    this.writeQueue = this.writeQueue.filter((entry) => entry.sent !== sent);
  }

  #onData(chunk) {
    if (this.framingFault || this.shut) return;
    try {
      this.framer.feed(chunk);
      for (const msg of this.framer.frames()) this.#onMsg(msg);
    } catch (err) {
      // Name only — parser text can echo peer bytes (deferred framer cleanup).
      const code = err.constructor?.name || 'framing-error';
      this.framingFault = code;
      this.#rejectAll(code);
      this.shut = true;
      this.writeQueue = [];
      this.socket.destroy();
    }
  }

  #onMsg(msg) {
    if (msg.kind === 'flood') {
      this.floodFrames++;
      return;
    }
    const lane = msg.for === 'call' || msg.for === 'cancel'
      ? msg.for
      : (msg.kind === 'cancelled' ? 'cancel' : 'call');
    const bucket = lane === 'cancel' ? this.cancels : this.calls;
    const waiter = bucket.get(msg.pluginId, msg.correlationId);
    if (!waiter) return;
    if (waiter.generation != null && msg.generation !== waiter.generation) return;
    bucket.delete(msg.pluginId, msg.correlationId);
    clearTimeout(waiter.timer);
    const returnedAt = performance.now();
    const sendTs = this.sentAt.get(waiter.sent);
    this.sentAt.delete(waiter.sent);
    const timed = { ...msg, returnedAt, rttMs: sendTs == null ? null : returnedAt - sendTs };
    if (msg.kind === 'result' || msg.kind === 'cancelled') waiter.resolve(timed);
    else waiter.reject(fail(msg.code || 'ipc-error'));
  }

  #rejectAll(code) {
    for (const bucket of [this.calls, this.cancels]) {
      for (const waiter of bucket.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(fail(code));
      }
      bucket.clear();
    }
    this.sentAt.clear();
  }

  #track(bucket, sent, timeoutMs, generation) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!bucket.has(sent.pluginId, sent.correlationId)) return;
        bucket.delete(sent.pluginId, sent.correlationId);
        this.sentAt.delete(sent);
        this.#dropUnsent(sent);
        reject(fail('timeout'));
      }, timeoutMs);
      bucket.set(sent.pluginId, sent.correlationId, { resolve, reject, timer, sent, generation });
    });
  }

  #occupied() {
    return this.calls.size + this.cancels.size;
  }

  #send(bucket, frame, timeoutMs) {
    if (this.framingFault) return Promise.reject(fail(this.framingFault));
    if (this.shut || this.socket.destroyed) return Promise.reject(fail('closed'));
    const lane = bucket === this.cancels ? 'cancel' : 'call';
    if (bucket.has(frame.pluginId, frame.correlationId)) return Promise.reject(fail('duplicate-correlation'));
    if (this.#occupied() >= this.pendingCap) return Promise.reject(fail('pending-cap'));
    frame.timeoutMs = timeoutMs;
    frame.sendTs = performance.now();
    let buf;
    try {
      buf = encodeMux(frame);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.bufferedBytes() + buf.length > this.byteCap) return Promise.reject(fail('total-cap'));
    const sent = { lane, pluginId: frame.pluginId, correlationId: frame.correlationId };
    this.sentAt.set(sent, frame.sendTs);
    const generation = frame.credential?.generation ?? null;
    const pending = this.#track(bucket, sent, timeoutMs, generation);
    this.writeQueue.push({ buf, sent });
    this.#flush();
    return pending;
  }

  #flush() {
    if (this.writeBlocked || this.shut) return;
    while (this.writeQueue.length > 0) {
      const entry = this.writeQueue[0];
      this.outbound += entry.buf.length;
      this.writeQueue.shift();
      let ok = false;
      try {
        ok = this.socket.write(entry.buf, () => {
          this.outbound = Math.max(0, this.outbound - entry.buf.length);
        });
      } catch {
        this.outbound = Math.max(0, this.outbound - entry.buf.length);
        return;
      }
      if (!ok) {
        this.writeBlocked = true;
        this.socket.once('drain', () => {
          this.writeBlocked = false;
          this.#flush();
        });
        return;
      }
    }
  }

  call(req, timeoutMs = 5_000) {
    return this.#send(this.calls, {
      kind: 'call',
      pluginId: req.pluginId,
      correlationId: req.correlationId,
      credential: req.credential,
      port: req.port,
      method: req.method,
      payload: req.payload,
    }, timeoutMs);
  }

  cancel(req, timeoutMs = 5_000) {
    return this.#send(this.cancels, {
      kind: 'cancel',
      pluginId: req.pluginId,
      correlationId: req.correlationId,
      credential: req.credential,
    }, timeoutMs);
  }

  // 1 row → { outcome: 'cancelled' }. 0 rows → { outcome: 'lost' }.
  async revoke(id, useDirect = false) {
    const won = await cancelExecution(id, useDirect);
    if (won) return { outcome: 'cancelled', id };
    return { outcome: 'lost', id };
  }

  close() {
    this.shut = true;
    this.writeQueue = [];
    this.#rejectAll('closed');
    this.socket.destroy();
  }
}
