// Manual clock for the race battery. Advancing it fires due timers and waits
// for their async work, so a lease crossing is a sequence of barriers rather
// than a wall-clock sleep.

export const RACE_EPOCH_MS = Date.UTC(2026, 0, 1);

export function manualClock(startMs = RACE_EPOCH_MS) {
  let now = startMs;
  const timers = [];
  let seq = 0;
  return {
    millis() {
      return now;
    },
    async now() {
      return new Date(now);
    },
    setInterval(fn, every) {
      const timer = { at: now + every, every, fn, seq: ++seq, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
    },
    async advance(ms) {
      return this.advanceTo(now + ms);
    },
    async advanceTo(target) {
      if (target < now) throw new Error('manual clock cannot move backwards');
      while (true) {
        const next = timers
          .filter((timer) => !timer.cleared && timer.at <= target)
          .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!next) {
          now = target;
          return;
        }
        now = next.at;
        next.at += next.every;
        await next.fn();
      }
    },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Every race wait uses this ceiling unless a case names a tighter one.
// The pass path records the observed elapsed time and asserts it is inside.
export const COMPLETION_BOUND_MS = 5000;

// Failure bound. The pass path settles when `promise` does.
// `onTimeout` runs as the deadline fires so a blocked client can be destroyed.
export function withDeadline(promise, ms, label, onTimeout) {
  let timer;
  let settled = false;
  const task = Promise.resolve(promise).then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  // A late rejection after the deadline must not surface as an unhandled rejection.
  task.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      try { onTimeout?.(); } catch { /* the deadline is the failure */ }
      reject(new Error(`deadline exceeded: ${label}`));
    }, ms);
  });
  return Promise.race([
    task.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

// Resolves with the value and the observed elapsed time, or rejects at `ms`.
export async function bounded(work, ms, label, onTimeout) {
  const started = Date.now();
  const value = await withDeadline(Promise.resolve().then(work), ms, label, onTimeout);
  const elapsedMs = Date.now() - started;
  if (elapsedMs > ms) throw new Error(`bound exceeded: ${label} (${elapsedMs}ms)`);
  return { value, elapsedMs, boundMs: ms, label };
}

// Collects a bound for every wait a scenario starts outside the harness commit.
export function steps(ms = COMPLETION_BOUND_MS) {
  const bounds = [];
  return {
    bounds,
    ok() {
      return bounds.length > 0 && bounds.every((item) => item.elapsedMs <= item.boundMs);
    },
    async run(work, label, overrideMs, onTimeout) {
      const boundMs = overrideMs ?? ms;
      const started = Date.now();
      try {
        const result = await bounded(() => work(), boundMs, label, onTimeout);
        bounds.push({ label, elapsedMs: result.elapsedMs, boundMs: result.boundMs });
        return result.value;
      } catch (err) {
        const elapsedMs = Date.now() - started;
        const deadline = typeof err?.message === 'string' && err.message.startsWith('deadline exceeded');
        if (!deadline && elapsedMs <= boundMs) {
          bounds.push({ label, elapsedMs, boundMs });
        }
        throw err;
      }
    },
  };
}

export function assertBounds(bounds) {
  if (!bounds?.length) throw new Error('missing completion bounds');
  for (const item of bounds) {
    if (!(item.elapsedMs <= item.boundMs)) {
      throw new Error(`completion bound missed: ${item.label} ${item.elapsedMs}ms > ${item.boundMs}ms`);
    }
  }
}
