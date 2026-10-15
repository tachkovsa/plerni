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

export class KernelStub {
  constructor(socket) {
    this.socket = socket;
    this.framer = new MuxFramer();
    this.calls = new Map();
    this.cancels = new Map();
    this.sentAt = new Map();
    this.floodFrames = 0;
    this.framingFault = null;
    socket.on('data', (chunk) => this.#onData(chunk));
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
    const bucket = msg.kind === 'cancelled' ? this.cancels : this.calls;
    const waiter = bucket.get(key);
    if (!waiter) return;
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

  #track(bucket, pluginId, correlationId, timeoutMs) {
    const key = pendingKey(pluginId, correlationId);
    const sentKey = `${bucket === this.cancels ? 'cancel' : 'call'}\0${key}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!bucket.has(key)) return;
        bucket.delete(key);
        this.sentAt.delete(sentKey);
        reject(fail('timeout'));
      }, timeoutMs);
      bucket.set(key, { resolve, reject, timer, sentKey });
    });
  }

  #send(bucket, frame, timeoutMs) {
    const key = pendingKey(frame.pluginId, frame.correlationId);
    const sentKey = `${bucket === this.cancels ? 'cancel' : 'call'}\0${key}`;
    this.sentAt.set(sentKey, performance.now());
    frame.sendTs = this.sentAt.get(sentKey);
    const pending = this.#track(bucket, frame.pluginId, frame.correlationId, timeoutMs);
    this.socket.write(encodeMux(frame));
    return pending;
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
    this.socket.destroy();
    this.#rejectAll('closed');
  }
}
