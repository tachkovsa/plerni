// flow_budget.mjs — writer-end ceiling and the B3 cap budgets (ADR-0006).
// K is the reservation for one writer. The per-skb term has to be positive.
// A negative budget is unsatisfiable, which is a B3 failure, not an invalid run.

export const FLOW_READ_BYTES = 4096;
export const PROBE_INTERVAL_MS = 20;
export const OVERRUN_DEADLINE_MS = 100;

// getsockopt(SO_SNDBUF) is already the doubled value. One extra skb is admitted
// while usage is under that value and is then capped at (sndbuf >> 1) - 64.
export function writerCeiling(sndbuf) {
  if (!Number.isInteger(sndbuf) || sndbuf <= 0) return null;
  const extra = (sndbuf >> 1) - 64;
  if (extra <= 0) return null;
  return sndbuf + extra;
}

export function assessFlow({
  partialCap,
  totalCap,
  totalGlobal,
  sndbufIn,
  sndbufOut,
  readBytes = FLOW_READ_BYTES,
  childCount = 1,
  muxIn = 0,
  muxOut = 0,
}) {
  const kIn = writerCeiling(sndbufIn);
  const kOut = writerCeiling(sndbufOut);
  if (kIn == null || kOut == null) {
    return {
      outcome: 'unsatisfiable',
      reason: 'per-skb term is not positive',
      sndbufIn,
      sndbufOut,
      readBytes,
    };
  }
  const perChild = kIn + kOut + readBytes;
  const bP = partialCap - kIn - readBytes;
  const bT = totalCap - kIn - kOut - readBytes;
  const reserved = childCount * perChild + muxIn + muxOut + readBytes;
  const bG = totalGlobal - reserved;
  const base = { kIn, kOut, bP, bT, bG, readBytes, perChild, sndbufIn, sndbufOut };
  if (bP < 0 || bT < 0 || bG < 0) {
    return {
      outcome: 'unsatisfiable',
      reason: 'reservation does not fit the configured caps',
      ...base,
    };
  }
  return { outcome: 'ok', ...base };
}

// Pre-cleanup snapshot. A post-cleanup zero is not inside the cap.
export function partialCapHolds(accounted, cap, snapshot = {}) {
  if (snapshot.afterCleanup) return false;
  if (!Number.isFinite(accounted) || !Number.isFinite(cap)) return false;
  if (accounted < 0) return false;
  return accounted <= cap;
}

export function totalCapHolds(accounted, cap, snapshot = {}) {
  if (snapshot.afterCleanup) return false;
  if (!Number.isFinite(accounted) || !Number.isFinite(cap)) return false;
  if (accounted < 0) return false;
  if (snapshot.stdoutUnread != null && snapshot.kIn != null && snapshot.stdoutUnread > snapshot.kIn) {
    return false;
  }
  if (snapshot.stdinQueued != null && snapshot.kOut != null && snapshot.stdinQueued > snapshot.kOut) {
    return false;
  }
  return accounted <= cap;
}

// The enlarger and a thread writer both look like stdoutUnread > K. The
// supervisor emits one fault. The test classifies it from what the child did.
export const WRITER_OVERRUN = 'writer-overrun';

export function writerOverrun(unread, kIn) {
  return Number.isInteger(unread) && Number.isInteger(kIn) && unread > kIn;
}

export function classifyWriterOverrun(childAction) {
  if (childAction === 'raised-sndbuf') return 'enlarger';
  if (childAction === 'threads') return 'thread-writer';
  return null;
}
