// kernel-stub.mjs — one shared socket pair, port-call handler, revocation endpoint.
// Revocation reports the conditional UPDATE: 1 row → cancelled, 0 rows → lost.
// A lost cancellation is never labelled cancelled (plan §4 B2).

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { MuxFramer, encodeMux } from './framing.mjs';
import { cancelExecution } from './authority.mjs';

export function pendingKey(pluginId, correlationId) {
  return `${pluginId}\0${correlationId}`;
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
    this.calls = new Map();
    this.cancels = new Map();
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
  #dropUnsent(sentKey) {
    this.writeQueue = this.writeQueue.filter((entry) => entry.sentKey !== sentKey);
  }

  #onData(chunk) {
    if (this.framingFault) return;
    try {
      this.framer.feed(chunk);
      for (const msg of this.framer.frames()) this.#onMsg(msg);
    } catch (err) {
      // Name only — parser text can echo peer bytes (deferred framer cleanup).
      const code = err.constructor?.name || 'framing-error';
      this.framingFault = code;
      this.#rejectAll(code);
    }
  }

  #onMsg(msg) {
    if (msg.kind === 'flood') {
      this.floodFrames++;
      return;
    }
    const key = pendingKey(msg.pluginId, msg.correlationId);
    const lane = msg.for === 'call' || msg.for === 'cancel'
      ? msg.for
      : (msg.kind === 'cancelled' ? 'cancel' : 'call');
    const bucket = lane === 'cancel' ? this.cancels : this.calls;
    const waiter = bucket.get(key);
    if (!waiter) return;
    if (waiter.generation != null && msg.generation !== waiter.generation) return;
    bucket.delete(key);
    clearTimeout(waiter.timer);
    const returnedAt = performance.now();
    const sendTs = this.sentAt.get(waiter.sentKey);
    this.sentAt.delete(waiter.sentKey);
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

  #track(bucket, pluginId, correlationId, timeoutMs, generation) {
    const key = pendingKey(pluginId, correlationId);
    const sentKey = `${bucket === this.cancels ? 'cancel' : 'call'}\0${key}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!bucket.has(key)) return;
        bucket.delete(key);
        this.sentAt.delete(sentKey);
        this.#dropUnsent(sentKey);
        reject(fail('timeout'));
      }, timeoutMs);
      bucket.set(key, { resolve, reject, timer, sentKey, generation });
    });
  }

  #occupied() {
    return this.calls.size + this.cancels.size;
  }

  #send(bucket, frame, timeoutMs) {
    if (this.shut || this.socket.destroyed) return Promise.reject(fail('closed'));
    const key = pendingKey(frame.pluginId, frame.correlationId);
    if (bucket.has(key)) return Promise.reject(fail('duplicate-correlation'));
    if (this.#occupied() >= this.pendingCap) return Promise.reject(fail('pending-cap'));
    const sentKey = `${bucket === this.cancels ? 'cancel' : 'call'}\0${key}`;
    frame.timeoutMs = timeoutMs;
    frame.sendTs = performance.now();
    let buf;
    try {
      buf = encodeMux(frame);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.bufferedBytes() + buf.length > this.byteCap) return Promise.reject(fail('total-cap'));
    this.sentAt.set(sentKey, frame.sendTs);
    const generation = frame.credential?.generation ?? null;
    const pending = this.#track(bucket, frame.pluginId, frame.correlationId, timeoutMs, generation);
    this.writeQueue.push({ buf, sentKey });
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
