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

// Failure bound only. The pass path settles when `promise` does.
export function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
