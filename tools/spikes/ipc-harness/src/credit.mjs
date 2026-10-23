// SPDX-License-Identifier: Apache-2.0
// credit.mjs — grants, reservations, admission, and pause/resume (ADR-0006).
// Pure book: no sockets, no child processes, no supervisor transport.
//
// A credit-compliant child writes a reply only when the advertised window
// covers that line. The book keeps that window reachable.
//
// Headroom is the largest live call cost, withheld so a later call of that
// size still fits beside advertised credit. The withhold is capped so the
// grant still covers the usable reply promised at spawn and every admitted
// reply that is still outstanding, together. A later call that would shrink
// the window below that sum is rejected. A cost above the child ceiling or
// the process ceiling is not headroom. Timeout and reject drop the cost. A
// completed call may leave a floor; the same cap applies. Every grant reads
// the current bytes, windows, and live costs.
//
// A call that arrives after credit was granted is checked against the full
// reservation — the outbound line plus the control reserve — beside the
// advertised window and both ceilings. Only the identifier bytes are retained.
//
// A child paused for the process ceiling resumes when its next bounded read
// fits. Half the ceiling is not required. A paused child, or an empty kernel
// queue, is posted a full read of C. A shorter queued tail counts only while
// the read is already allowed to proceed. Deferred growth is checked at the
// size after that growth, against the child ceiling and the process ceiling.
// An open line is faulted total-cap only when no open line can take its next
// read and free bytes. Combined prefixes that block one line are not that
// fault while another open line can still be read. Bytes that a later
// release can free are not that fault either.
//
// Dumpability after exec or re-exec, and authentication of the pre-start
// helper cache, are not this module. ADR-0004 decision 4 records them as
// accepted residuals of the operator-approved tier. ADR-0006 trusts the
// runtime, the pre-start cache, and same-UID access.

import { encodeNdjson } from './framing.mjs';

export const READ_BYTES = 4096;
export const USABLE_RESPONSE_PAD = 4000;
const MAX_GRANT = 2147483647;

export const USABLE_RESPONSE = Buffer.byteLength(encodeNdjson({
  kind: 'result',
  correlationId: 1,
  payload: 'p'.repeat(USABLE_RESPONSE_PAD),
}));

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function identifierBytes(pluginId, correlationId) {
  const left = JSON.stringify(pluginId);
  const right = JSON.stringify(correlationId);
  return Buffer.byteLength(left ?? '') + Buffer.byteLength(right ?? '');
}

export function controlReserve() {
  const grant = Buffer.byteLength(encodeNdjson({ kind: 'grant', credit: MAX_GRANT }));
  const cancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId: 0 }));
  return { grant, cancel };
}

// One 1024-byte call, its identifiers, and one cancel plus one grant.
// The idle grant subtracts this slot so the next admission still fits.
export function admissionSlot(pluginId = 'echo-0') {
  const correlationId = 480000;
  const line = encodeNdjson({
    kind: 'call',
    correlationId,
    port: 'db',
    method: 'get',
    payload: 'x'.repeat(1024),
  });
  const bytes = Buffer.byteLength(line);
  const idBytes = identifierBytes(pluginId, correlationId);
  const reserve = controlReserve();
  const cancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId }));
  return bytes + idBytes + idBytes + reserve.grant + Math.max(reserve.cancel, cancel);
}

// Cost the supervisor records for an admitted call. `held` is the identifier
// bytes that stay until the call settles. The line itself leaves userspace
// once the kernel accepts the write, so it is not held for the reply.
export function admissionCost({ pluginId, correlationId, payload }) {
  const line = encodeNdjson({
    kind: 'call',
    correlationId,
    port: 'db',
    method: 'get',
    payload,
  });
  const lineBytes = Buffer.byteLength(line);
  const idBytes = identifierBytes(pluginId, correlationId);
  const reserve = controlReserve();
  const cancel = Buffer.byteLength(encodeNdjson({ kind: 'cancel', correlationId }));
  const reservation = lineBytes + idBytes + idBytes + reserve.grant + Math.max(reserve.cancel, cancel);
  return { lineBytes, idBytes, held: idBytes, reservation };
}

export function replenishCredit(room, keep, sendWindow) {
  const budget = room - keep;
  if (!Number.isFinite(budget) || budget <= sendWindow) return 0;
  const deficit = budget - sendWindow;
  if (sendWindow > 0 && deficit * 2 < budget) return 0;
  return Math.min(MAX_GRANT, deficit);
}

export function advertisedDeficit(room, keep, sendWindow) {
  const budget = room - keep;
  if (!Number.isFinite(budget) || budget <= sendWindow) return 0;
  const deficit = budget - sendWindow;
  if (!Number.isFinite(deficit) || deficit <= 0) return 0;
  return Math.min(MAX_GRANT, Math.floor(deficit));
}

export function keepBytes(room, hole, pending, noted, admitSlot) {
  const one = Math.max(noted || 0, admitSlot);
  const batch = Math.min(8, pending);
  const spacious = Math.max(0, room) + hole;
  const local = spacious > one * (batch + 24) ? one * batch : one;
  const extra = Math.max(0, local - hole);
  return Math.min(Math.max(0, room), extra);
}

// Headroom may not shrink the grant below the protected reply bytes.
export function capKeep(room, raw, protect) {
  if (!(protect > 0)) return raw;
  const floor = Math.min(protect, Math.max(0, room));
  return Math.min(raw, Math.max(0, room - floor));
}

// Each peer carries its own promised floor. The recipient's floor is `usable`
// and is not applied to peers that were promised a different ceiling.
export function shareReserve(peers, recipientHeld, usable, globalWithout, childRoom, keep, pool) {
  const n = peers.length + 1;
  if (n <= 1) return 0;
  const share = Math.floor(Math.max(0, pool) / n);
  const windowOf = (peer) => (peer.window > 0 ? peer.window : 0);
  const promisedOf = (peer) => (peer.promised > 0 ? peer.promised : 0);
  if (!(usable > 0)) {
    let reserve = 0;
    for (const peer of peers) {
      const window = windowOf(peer);
      if (window < share) reserve += share - window;
    }
    return reserve;
  }
  let floor = 0;
  let fullExtra = 0;
  for (const peer of peers) {
    const window = windowOf(peer);
    const promised = promisedOf(peer);
    floor += Math.max(0, promised - window);
    const base = Math.max(window, promised);
    if (base < share) fullExtra += share - base;
  }
  const heldWindow = recipientHeld > 0 ? recipientHeld : 0;
  if (heldWindow >= usable) return floor + fullExtra;
  const withFloor = Math.min(childRoom, globalWithout - floor) - keep;
  if (withFloor < usable) return floor;
  const uncapped = Math.min(childRoom, globalWithout - floor - fullExtra) - keep;
  if (uncapped >= usable) return floor + fullExtra;
  const extra = Math.max(0, globalWithout - floor - keep - usable);
  return floor + Math.min(fullExtra, extra);
}

function callHole(children, caps, extra) {
  const one = caps.admitSlot;
  let pending = caps.pending;
  let seen = false;
  let space = Math.max(0, caps.globalCap);
  const visit = (ceiling, limit) => {
    if (Number.isInteger(limit) && limit > 0) {
      pending = seen ? Math.min(pending, limit) : limit;
      seen = true;
    }
    if (Number.isFinite(ceiling) && ceiling < space) space = ceiling;
  };
  for (const child of children) visit(child.ceiling, child.pending);
  if (extra) visit(extra.ceiling, extra.pending);
  pending = Math.max(1, Math.min(pending, caps.pendingGlobal));
  const classic = Math.min(8, pending);
  let batch = 1;
  if (space > one * (classic + 24)) batch = classic;
  if (pending > classic && space > one * (pending + 24)) batch = pending;
  return one * batch;
}

function emptyResume() {
  return { resumed: [], faulted: [] };
}

export function createCreditBook(opts = {}) {
  return new CreditBook(opts);
}

export class CreditBook {
  #children = new Map();
  #shared = 0;
  #globalCap;
  #readBytes;
  #usableResponse;
  #admitSlot;
  #pending;
  #pendingGlobal;
  #stamp;

  constructor(opts) {
    if (!nonNegativeInt(opts.globalCap)) {
      throw new TypeError('globalCap must be a non-negative integer');
    }
    const readBytes = opts.readBytes ?? READ_BYTES;
    if (!Number.isInteger(readBytes) || readBytes <= 0) {
      throw new TypeError('readBytes must be a positive integer');
    }
    const usable = opts.usableResponse ?? USABLE_RESPONSE;
    if (!nonNegativeInt(usable)) throw new TypeError('usableResponse must be a non-negative integer');
    const slot = opts.admitSlot ?? admissionSlot();
    if (!Number.isInteger(slot) || slot <= 0) throw new TypeError('admitSlot must be a positive integer');
    this.#globalCap = opts.globalCap;
    this.#readBytes = readBytes;
    this.#usableResponse = usable;
    this.#admitSlot = slot;
    this.#pending = opts.pending ?? 32;
    this.#pendingGlobal = opts.pendingGlobal ?? 256;
    this.#stamp = opts.stamp ?? 0;
  }

  get globalCap() {
    return this.#globalCap;
  }

  get readBytes() {
    return this.#readBytes;
  }

  addChild({ id, ceiling, pending, stamp }) {
    if (id == null || this.#children.has(id)) return { ok: false, reason: 'duplicate' };
    if (!Number.isInteger(ceiling) || ceiling <= 0) return { ok: false, reason: 'unsatisfiable' };
    const childPending = pending ?? this.#pending;
    const childStamp = stamp ?? this.#stamp;
    if (!nonNegativeInt(childStamp) || !Number.isInteger(childPending) || childPending <= 0) {
      return { ok: false, reason: 'bad-bytes' };
    }
    const hole = this.#hole({ ceiling, pending: childPending });
    const usable = this.#usableFloor(ceiling, childPending, childStamp, hole);
    if (usable > 0 && !this.#initialCreditFits({ ceiling, pending: childPending, stamp: childStamp, hole, usable })) {
      return { ok: false, reason: 'spawn-rejected' };
    }
    this.#children.set(id, {
      id,
      ceiling,
      pending: childPending,
      stamp: childStamp,
      held: 0,
      window: 0,
      sent: 0,
      spent: 0,
      promised: usable,
      historical: 0,
      reservations: new Map(),
      paused: false,
      pauseReason: null,
      openPartial: 0,
      unread: 0,
      deferred: 0,
      dead: false,
    });
    return { ok: true, promised: usable };
  }

  admit({ childId, correlationId, held, reservation, replyBytes }) {
    const child = this.#child(childId);
    if (!child) return { decision: 'rejected', reason: 'unknown-child' };
    if (correlationId === undefined || !nonNegativeInt(held) || !nonNegativeInt(reservation) || !nonNegativeInt(replyBytes)) {
      return { decision: 'rejected', reason: 'bad-bytes' };
    }
    if (child.reservations.has(correlationId)) return { decision: 'rejected', reason: 'duplicate' };
    const ceiling = Math.min(child.ceiling, this.#globalCap);
    if (reservation > ceiling || reservation > this.#globalCap) {
      return { decision: 'rejected', reason: 'total-cap' };
    }
    // The reservation is transient: the line and the control reserve must fit
    // beside the window now, and only `held` (the identifiers) stays charged.
    if (child.held + reservation + child.window > child.ceiling) {
      return { decision: 'rejected', reason: 'total-cap' };
    }
    if (this.#buffered() + reservation + this.#windows(null) > this.#globalCap) {
      return { decision: 'rejected', reason: 'total-cap' };
    }
    child.held += held;
    child.reservations.set(correlationId, { reservation, held, replyBytes });
    const plan = this.#plan(child);
    const need = this.#replyNeed(child);
    if (need > 0 && child.window + plan.deficit < need) {
      child.held -= held;
      child.reservations.delete(correlationId);
      return { decision: 'rejected', reason: 'total-cap' };
    }
    return { decision: 'admitted', noted: this.#noted(child) };
  }

  replenish(childId) {
    const child = this.#child(childId);
    if (!child) return { credit: 0 };
    const plan = this.#plan(child);
    return { credit: this.#addCredit(child, plan.credit) };
  }

  flush(childId) {
    const child = this.#child(childId);
    if (!child || !(child.window > 0)) return { credit: 0 };
    const plan = this.#plan(child);
    if (!(plan.deficit > 0)) return { credit: 0 };
    return { credit: this.#addCredit(child, plan.deficit) };
  }

  // Data stdout spends the window one for one and lands in userspace.
  spend(childId, n) {
    const child = this.#child(childId);
    if (!child || !nonNegativeInt(n) || n === 0) return 0;
    const spent = Math.min(child.window, n);
    child.window -= spent;
    child.spent += spent;
    child.held += spent;
    return spent;
  }

  // Cancel acknowledgements and grant lines do not consume the send window.
  noteControl(childId, n) {
    const child = this.#child(childId);
    if (!child || !nonNegativeInt(n)) return null;
    return child.window;
  }

  release(childId, n) {
    const child = this.#child(childId);
    if (!child || !nonNegativeInt(n)) return { released: 0, ...emptyResume() };
    const released = Math.min(child.held, n);
    child.held -= released;
    if (child.openPartial > child.held) child.openPartial = child.held;
    return { released, ...this.considerResume() };
  }

  settle(childId, correlationId, outcome) {
    const child = this.#child(childId);
    if (!child) return { released: false, ...emptyResume() };
    if (outcome !== 'complete' && outcome !== 'timeout' && outcome !== 'reject') {
      return { released: false, ...emptyResume() };
    }
    const row = child.reservations.get(correlationId);
    if (!row) return { released: false, ...this.considerResume() };
    if (outcome === 'complete') child.historical = Math.max(child.historical, row.reservation);
    child.reservations.delete(correlationId);
    child.held = Math.max(0, child.held - row.held);
    if (child.openPartial > child.held) child.openPartial = child.held;
    return { released: true, ...this.considerResume() };
  }

  retain(childId, n) {
    const child = this.#child(childId);
    if (!child || !nonNegativeInt(n)) return false;
    child.held += n;
    return true;
  }

  setShared(n) {
    if (!nonNegativeInt(n)) return false;
    this.#shared = n;
    return true;
  }

  releaseShared(n) {
    if (!nonNegativeInt(n)) return { released: 0, ...emptyResume() };
    const released = Math.min(this.#shared, n);
    this.#shared -= released;
    return { released, ...this.considerResume() };
  }

  pause(childId, reason) {
    const child = this.#child(childId);
    if (!child || child.paused) return false;
    if (reason !== 'global' && reason !== 'partial' && reason !== 'total') return false;
    child.paused = true;
    child.pauseReason = reason;
    return true;
  }

  setOpenPartial(childId, n) {
    const child = this.#child(childId);
    if (!child || !nonNegativeInt(n) || n > child.held) return false;
    child.openPartial = n;
    return true;
  }

  setKernelUnread(childId, n) {
    const child = this.#child(childId);
    if (!child) return false;
    if (n == null) {
      child.unread = null;
      return true;
    }
    if (!nonNegativeInt(n)) return false;
    child.unread = n;
    return true;
  }

  setDeferred(childId, n) {
    const child = this.#child(childId);
    if (!child) return false;
    if (n == null) {
      child.deferred = 0;
      return true;
    }
    if (!nonNegativeInt(n)) return false;
    child.deferred = n;
    return true;
  }

  considerResume() {
    const faulted = [];
    for (;;) {
      const rows = [];
      let stuckSum = 0;
      for (const child of this.#live()) {
        if (!(child.openPartial > 0)) continue;
        const incoming = this.#incoming(child);
        if (!Number.isInteger(incoming)) continue;
        rows.push({ child, stuck: child.openPartial, incoming });
        stuckSum += child.openPartial;
      }
      const alone = rows.filter((row) => row.stuck + row.incoming > this.#globalCap);
      if (alone.length > 0) {
        for (const row of alone) this.#fault(row.child, faulted);
        continue;
      }
      const buffered = this.#buffered();
      if (rows.some((row) => buffered + row.incoming <= this.#globalCap)) break;
      const blocked = rows.filter((row) => stuckSum + row.incoming > this.#globalCap);
      if (blocked.length === 0) break;
      let largest = blocked[0];
      for (const row of blocked) {
        if (row.stuck > largest.stuck) largest = row;
      }
      this.#fault(largest.child, faulted);
    }
    const resumed = [];
    for (const child of this.#live()) {
      if (!child.paused || child.pauseReason !== 'global') continue;
      if (this.#readFits(child) || this.#holdFits(child)) {
        child.paused = false;
        child.pauseReason = null;
        resumed.push(child.id);
      }
    }
    return { resumed, faulted };
  }

  window(childId) {
    return this.#child(childId)?.window ?? 0;
  }

  headroom(childId) {
    const child = this.#child(childId);
    return child ? this.#noted(child) : 0;
  }

  promised(childId) {
    return this.#child(childId)?.promised ?? 0;
  }

  paused(childId) {
    const child = this.#any(childId);
    return Boolean(child && child.paused && !child.dead);
  }

  inspect(childId) {
    const child = this.#child(childId);
    if (!child) return null;
    const plan = this.#plan(child);
    return {
      room: plan.room,
      keep: plan.keep,
      rawKeep: plan.raw,
      budget: plan.budget,
      rawBudget: plan.rawBudget,
      window: child.window,
      noted: this.#noted(child),
      historical: child.historical,
      promised: child.promised,
      held: child.held,
      buffered: this.#buffered(),
      paused: child.paused,
      pauseReason: child.pauseReason,
    };
  }

  account() {
    let sentOk = true;
    for (const child of this.#live()) {
      if (child.sent !== child.window + child.spent) sentOk = false;
      if (child.held < 0 || child.window < 0) sentOk = false;
    }
    const buffered = this.#buffered();
    const windows = this.#windows(null);
    return {
      buffered,
      windows,
      globalCap: this.#globalCap,
      sentOk,
      withinGlobal: buffered + windows <= this.#globalCap,
    };
  }

  #addCredit(child, credit) {
    if (!Number.isInteger(credit) || credit <= 0) return 0;
    const allowed = this.#plan(child).deficit;
    const grant = Math.min(credit, Math.max(0, allowed));
    if (grant <= 0) return 0;
    child.window += grant;
    child.sent += grant;
    return grant;
  }

  #plan(child) {
    const room = this.#room(child);
    const keeps = this.#keeps(child, room);
    return {
      room,
      raw: keeps.raw,
      keep: keeps.keep,
      budget: room - keeps.keep,
      rawBudget: room - keeps.raw,
      credit: replenishCredit(room, keeps.keep, child.window),
      deficit: advertisedDeficit(room, keeps.keep, child.window),
    };
  }

  #room(child) {
    const hole = this.#hole();
    const childRoom = child.ceiling - child.held - hole - child.stamp;
    const globalRoom = this.#globalCap - this.#buffered() - this.#windows(child) - hole - this.#peerShare(child) - child.stamp;
    return Math.min(childRoom, globalRoom);
  }

  #keeps(child, room) {
    let noted = this.#noted(child);
    const ceiling = Math.min(child.ceiling, this.#globalCap);
    if (noted > ceiling) noted = child.historical;
    const raw = keepBytes(room, this.#hole(), child.pending, noted, this.#admitSlot);
    const protect = Math.max(child.promised, this.#replyNeed(child));
    return { raw, keep: capKeep(room, raw, protect) };
  }

  #replyNeed(child) {
    let need = 0;
    for (const row of child.reservations.values()) {
      if (row.replyBytes > 0) need += row.replyBytes;
    }
    return need;
  }

  #noted(child) {
    let noted = child.historical;
    for (const row of child.reservations.values()) {
      if (row.reservation > noted) noted = row.reservation;
    }
    return noted;
  }

  #peerShare(child) {
    const peers = [];
    let n = 0;
    for (const other of this.#live()) {
      n += 1;
      if (other === child) continue;
      peers.push({
        window: other.window > 0 ? other.window : 0,
        promised: other.promised > 0 ? other.promised : 0,
      });
    }
    if (n <= 1) return 0;
    const hole = this.#hole();
    const usable = this.#usableFloor(child.ceiling, child.pending, child.stamp, hole);
    const buffered = this.#buffered();
    const pool = Math.max(0, this.#globalCap - hole - buffered);
    const globalWithout = this.#globalCap - buffered - this.#windows(child) - hole - child.stamp;
    const childRoom = child.ceiling - child.held - hole - child.stamp;
    const keep = this.#keeps(child, Math.min(childRoom, globalWithout)).keep;
    return shareReserve(peers, child.window, usable, globalWithout, childRoom, keep, pool);
  }

  #usableFloor(ceiling, pending, stamp, hole) {
    const room = Math.min(ceiling, this.#globalCap) - hole - stamp;
    const keep = keepBytes(room, hole, pending, 0, this.#admitSlot);
    const lone = Math.max(0, replenishCredit(room, keep, 0));
    if (!(lone > 0)) return 0;
    return Math.min(this.#usableResponse, lone);
  }

  #initialCreditFits({ ceiling, pending, stamp, hole, usable }) {
    const peers = [];
    for (const child of this.#live()) {
      peers.push({
        window: child.window > 0 ? child.window : 0,
        promised: child.promised > 0 ? child.promised : 0,
      });
    }
    const sibling = peers.reduce((sum, peer) => sum + peer.window, 0);
    const buffered = this.#buffered();
    const pool = Math.max(0, this.#globalCap - hole - buffered);
    const globalWithout = this.#globalCap - buffered - sibling - hole - stamp;
    const childRoom = ceiling - hole - stamp;
    const keep = keepBytes(Math.min(childRoom, globalWithout), hole, pending, 0, this.#admitSlot);
    const reserved = shareReserve(peers, 0, usable, globalWithout, childRoom, keep, pool);
    const room = Math.min(childRoom, globalWithout - reserved);
    const credit = Math.max(0, replenishCredit(room, keep, 0));
    return credit >= usable;
  }

  #hole(extra) {
    return callHole(this.#live(), {
      pending: this.#pending,
      pendingGlobal: this.#pendingGlobal,
      globalCap: this.#globalCap,
      admitSlot: this.#admitSlot,
    }, extra);
  }

  #incoming(child) {
    if (!Number.isInteger(child.unread) || child.unread < 0) return null;
    if (child.paused || child.unread === 0) return this.#readBytes;
    return Math.min(this.#readBytes, child.unread);
  }

  #readFits(child) {
    const incoming = this.#incoming(child);
    if (!Number.isInteger(incoming)) return false;
    return this.#buffered() + incoming <= this.#globalCap;
  }

  #holdFits(child) {
    if (!(child.deferred > 0)) return false;
    const extra = Math.max(0, child.deferred - child.held);
    if (child.held + extra + child.window > child.ceiling) return false;
    return this.#buffered() + extra + this.#windows(null) <= this.#globalCap;
  }

  #fault(child, faulted) {
    if (child.dead) return;
    child.dead = true;
    child.held = 0;
    child.openPartial = 0;
    child.paused = false;
    child.pauseReason = null;
    child.window = 0;
    child.sent = 0;
    child.spent = 0;
    child.reservations.clear();
    child.historical = 0;
    faulted.push(child.id);
  }

  #buffered() {
    let sum = this.#shared;
    for (const child of this.#live()) sum += child.held;
    return sum;
  }

  #windows(except) {
    let sum = 0;
    for (const child of this.#live()) {
      if (child === except) continue;
      if (child.window > 0) sum += child.window;
    }
    return sum;
  }

  #live() {
    const rows = [];
    for (const child of this.#children.values()) {
      if (!child.dead) rows.push(child);
    }
    return rows;
  }

  #child(id) {
    const child = this.#children.get(id);
    if (!child || child.dead) return null;
    return child;
  }

  #any(id) {
    return this.#children.get(id) ?? null;
  }
}
