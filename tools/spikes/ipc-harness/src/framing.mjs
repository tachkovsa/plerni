// framing.mjs — Two distinct framings, never conflated (δ-m4):
// (1) NDJSON-over-stdio for child links; (2) length-prefixed frames for the mux bridge.
// Property tests verify: arbitrary byte streams never corrupt frames; oversize/malformed → typed errors.

const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB
// A partial line one byte past the maximum frame (plus the extra byte the
// delimiter would occupy) cannot become a legal frame. Buffering exactly
// this many unterminated bytes does not throw. The framer throws only once
// the residual is greater than MAX_RESIDUAL (ADR-0006).
export const MAX_RESIDUAL = MAX_FRAME_SIZE + 1;

// Contiguous buffer with power-of-two growth. Appending a chunk copies only the
// new bytes into spare capacity; the prefix is copied only when capacity doubles,
// so a byte-at-a-time peer costs linear work. Offsets are logical (relative to #start).
class ByteBuf {
  #buf = Buffer.alloc(256);
  #start = 0;
  #end = 0;

  get length() {
    return this.#end - this.#start;
  }

  append(chunk) {
    if (chunk.length === 0) return;
    const used = this.#end - this.#start;
    if (this.#end + chunk.length > this.#buf.length) {
      let cap = this.#buf.length;
      while (cap < used + chunk.length) cap *= 2;
      const next = Buffer.alloc(cap);
      this.#buf.copy(next, 0, this.#start, this.#end);
      this.#buf = next;
      this.#start = 0;
      this.#end = used;
    }
    chunk.copy(this.#buf, this.#end);
    this.#end += chunk.length;
  }

  indexOf(byte, logicalFrom = 0) {
    if (logicalFrom < 0 || logicalFrom >= this.length) return -1;
    const found = this.#buf.indexOf(byte, this.#start + logicalFrom);
    if (found < 0 || found >= this.#end) return -1;
    return found - this.#start;
  }

  subarray(logicalStart, logicalEnd) {
    return this.#buf.subarray(this.#start + logicalStart, this.#start + logicalEnd);
  }

  readUInt32BE(logicalOffset) {
    return this.#buf.readUInt32BE(this.#start + logicalOffset);
  }

  drop(n) {
    if (n >= this.length) {
      this.#start = 0;
      this.#end = 0;
      return;
    }
    this.#start += n;
  }
}

function asBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// =====================
// (1) NDJSON over stdio
// =====================

export class NdjsonFramingError extends Error {}
export class NdjsonOversizeError extends NdjsonFramingError {}
export class NdjsonNeverTerminatedError extends NdjsonFramingError {}
export class NdjsonUnterminatedAtEofError extends NdjsonFramingError {}

export class NdjsonFramer {
  #bytes = new ByteBuf();
  #scanned = 0;
  #firstNewline = -1;
  #lastNewline = -1;

  feed(chunk) {
    this.#bytes.append(asBuffer(chunk));
    this.#scanNew();
    // No complete frame is waiting, so the caller will not reach frames().
    if (this.#firstNewline < 0 && this.#residual() > MAX_RESIDUAL) {
      throw new NdjsonOversizeError(`partial frame exceeded ${MAX_FRAME_SIZE} bytes without newline`);
    }
  }

  // Bytes already known to contain no newline are not scanned again.
  #scanNew() {
    let from = this.#scanned;
    while (from < this.#bytes.length) {
      const idx = this.#bytes.indexOf(0x0a, from);
      if (idx === -1) break;
      if (this.#firstNewline < 0) this.#firstNewline = idx;
      this.#lastNewline = idx;
      from = idx + 1;
    }
    this.#scanned = this.#bytes.length;
  }

  #residual() {
    if (this.#lastNewline < 0) return this.#bytes.length;
    return this.#bytes.length - (this.#lastNewline + 1);
  }

  *frames() {
    while (this.#firstNewline >= 0) {
      const idx = this.#firstNewline;
      const line = this.#bytes.subarray(0, idx);
      const n = idx + 1;
      this.#bytes.drop(n);
      this.#scanned -= n;
      this.#lastNewline -= n;
      if (this.#lastNewline < 0) {
        this.#firstNewline = -1;
      } else {
        this.#firstNewline = this.#bytes.indexOf(0x0a, 0);
      }
      if (line.length > MAX_FRAME_SIZE) {
        throw new NdjsonOversizeError(`frame ${line.length} bytes > ${MAX_FRAME_SIZE}`);
      }
      let lineStr;
      try {
        // stream:false — a finished line must not retain a dangling UTF-8 sequence.
        lineStr = decodeUtf8(line);
      } catch (e) {
        throw new NdjsonFramingError(`invalid utf-8: ${e.message}`);
      }
      lineStr = lineStr.trim();
      if (!lineStr) continue;
      try {
        yield JSON.parse(lineStr);
      } catch (e) {
        throw new NdjsonFramingError(`malformed JSON: ${e.message}`);
      }
    }
    if (this.#residual() > MAX_RESIDUAL) {
      throw new NdjsonOversizeError(`partial frame exceeded ${MAX_FRAME_SIZE} bytes without newline`);
    }
  }

  eof() {
    if (this.#bytes.length > 0) {
      throw new NdjsonUnterminatedAtEofError(`unterminated frame at EOF: ${this.#bytes.length} bytes`);
    }
  }

  pendingBytes() {
    return this.#bytes.length;
  }

  // True when a complete line is still buffered. The partial-cap fault is
  // only for bytes that contain no newline.
  hasPendingNewline() {
    return this.#firstNewline >= 0;
  }

  // Bytes after the last complete line. Empty when the buffer ends on a newline.
  pendingTail() {
    const start = this.#lastNewline < 0 ? 0 : this.#lastNewline + 1;
    if (start >= this.#bytes.length) return Buffer.alloc(0);
    return this.#bytes.subarray(start, this.#bytes.length);
  }
}

export function encodeNdjson(obj) {
  const payload = JSON.stringify(obj);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_FRAME_SIZE) {
    throw new NdjsonOversizeError(`payload ${payloadBytes} bytes > ${MAX_FRAME_SIZE}`);
  }
  return payload + '\n';
}

// A prefix shorter than this can still be a cancel ack or a grant. Those
// lines do not spend send credit. A longer prefix whose top-level kind is
// still unread spends as data, so the line is not buffered on top of the
// window it came out of.
export const STDOUT_KIND_PREFIX = 96;

const KIND_CALL = 'call';
const KIND_RESULT = 'result';
const KIND_ERROR = 'error';
const KIND_CANCELLED = 'cancelled';
const KIND_GRANT = 'grant';
const KIND_NOOP = 'noop';
const KIND_REJECTED = 'rejected';
const KNOWN_KINDS = [KIND_CALL, KIND_RESULT, KIND_ERROR, KIND_CANCELLED, KIND_GRANT, KIND_NOOP, KIND_REJECTED];

export function isStdoutControlKind(kind) {
  return kind === KIND_CANCELLED || kind === KIND_GRANT;
}

function skipSpace(buf, i, end) {
  while (i < end) {
    const c = buf[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d) break;
    i++;
  }
  return i;
}

function hex4(buf, i) {
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const c = buf[i + k];
    let d = -1;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    if (d < 0) return -1;
    n = (n << 4) | d;
  }
  return n;
}

// `i` is the opening quote. Capturing stops after a short key or kind; a
// longer string is skipped and reported as overflow so a payload cannot be
// copied just to decide credit.
function readJsonString(buf, i, end, capture) {
  if (i >= end || buf[i] !== 0x22) return { done: false, next: i };
  i++;
  let value = '';
  let overflow = false;
  while (i < end) {
    const c = buf[i];
    if (c === 0x0a) return { done: false, next: i };
    if (c === 0x22) return { done: true, value: overflow ? null : value, overflow, next: i + 1 };
    if (c === 0x5c) {
      if (i + 1 >= end) return { done: false, next: end };
      const e = buf[i + 1];
      if (e === 0x75) {
        if (i + 6 > end) return { done: false, next: end };
        const cp = hex4(buf, i + 2);
        if (cp < 0) return { done: false, next: i };
        i += 6;
        if (!capture || overflow) continue;
        if (cp >= 0xd800 && cp <= 0xdbff && i + 6 <= end && buf[i] === 0x5c && buf[i + 1] === 0x75) {
          const low = hex4(buf, i + 2);
          if (low >= 0xdc00 && low <= 0xdfff) {
            value += String.fromCharCode(cp, low);
            i += 6;
            if (value.length > 128) overflow = true;
            continue;
          }
        }
        value += String.fromCharCode(cp);
        if (value.length > 128) overflow = true;
        continue;
      }
      i += 2;
      if (!capture || overflow) continue;
      if (e === 0x22) value += '"';
      else if (e === 0x5c) value += '\\';
      else if (e === 0x2f) value += '/';
      else if (e === 0x62) value += '\b';
      else if (e === 0x66) value += '\f';
      else if (e === 0x6e) value += '\n';
      else if (e === 0x72) value += '\r';
      else if (e === 0x74) value += '\t';
      else return { done: false, next: i };
      if (value.length > 128) overflow = true;
      continue;
    }
    if (c < 0x20) return { done: false, next: i };
    if (!capture || overflow) {
      i++;
      continue;
    }
    if (c < 0x80) {
      value += String.fromCharCode(c);
      i++;
      if (value.length > 128) overflow = true;
      continue;
    }
    let need = 0;
    if ((c & 0xe0) === 0xc0) need = 2;
    else if ((c & 0xf0) === 0xe0) need = 3;
    else if ((c & 0xf8) === 0xf0) need = 4;
    else return { done: false, next: i };
    if (i + need > end) return { done: false, next: end };
    value += buf.toString('utf8', i, i + need);
    i += need;
    if (value.length > 128) overflow = true;
  }
  return { done: false, next: i };
}

function matchKindKey(buf, i, end) {
  if (i + 6 > end) return -1;
  if (
    buf[i] === 0x22
    && buf[i + 1] === 0x6b
    && buf[i + 2] === 0x69
    && buf[i + 3] === 0x6e
    && buf[i + 4] === 0x64
    && buf[i + 5] === 0x22
  ) return i + 6;
  return -1;
}

function matchKindValue(buf, i, end) {
  if (i >= end || buf[i] !== 0x22) return null;
  const start = i + 1;
  for (let n = 0; n < KNOWN_KINDS.length; n++) {
    const kind = KNOWN_KINDS[n];
    const len = kind.length;
    if (start + len >= end || buf[start + len] !== 0x22) continue;
    let same = true;
    for (let k = 0; k < len; k++) {
      if (buf[start + k] !== kind.charCodeAt(k)) {
        same = false;
        break;
      }
    }
    if (same) return { value: kind, next: start + len + 1 };
  }
  return null;
}

function skipLiteral(buf, i, end, word) {
  const len = word.length;
  if (i + len > end) return { done: false, next: end };
  for (let k = 0; k < len; k++) {
    if (buf[i + k] !== word.charCodeAt(k)) return { done: false, next: i };
  }
  return { done: true, next: i + len };
}

function skipNumber(buf, i, end) {
  if (i < end && buf[i] === 0x2d) i++;
  if (i >= end) return { done: false, next: i };
  if (buf[i] === 0x30) i++;
  else if (buf[i] >= 0x31 && buf[i] <= 0x39) {
    i++;
    while (i < end && buf[i] >= 0x30 && buf[i] <= 0x39) i++;
  } else return { done: false, next: i };
  if (i < end && buf[i] === 0x2e) {
    i++;
    if (i >= end || buf[i] < 0x30 || buf[i] > 0x39) return { done: false, next: i };
    while (i < end && buf[i] >= 0x30 && buf[i] <= 0x39) i++;
  }
  if (i < end && (buf[i] === 0x65 || buf[i] === 0x45)) {
    i++;
    if (i < end && (buf[i] === 0x2b || buf[i] === 0x2d)) i++;
    if (i >= end || buf[i] < 0x30 || buf[i] > 0x39) return { done: false, next: i };
    while (i < end && buf[i] >= 0x30 && buf[i] <= 0x39) i++;
  }
  return { done: true, next: i };
}

function skipContainer(buf, i, end) {
  const stack = [buf[i] === 0x7b ? 0x7d : 0x5d];
  i++;
  while (stack.length > 0) {
    if (i >= end || buf[i] === 0x0a) return { done: false, next: i };
    const c = buf[i];
    if (c === 0x22) {
      const str = readJsonString(buf, i, end, false);
      if (!str.done) return str;
      i = str.next;
      continue;
    }
    if (c === 0x7b) {
      stack.push(0x7d);
      i++;
      continue;
    }
    if (c === 0x5b) {
      stack.push(0x5d);
      i++;
      continue;
    }
    if (c === stack[stack.length - 1]) {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return { done: true, next: i };
}

function skipJsonValue(buf, i, end) {
  if (i >= end || buf[i] === 0x0a) return { done: false, next: i };
  const c = buf[i];
  if (c === 0x22) return readJsonString(buf, i, end, false);
  if (c === 0x7b || c === 0x5b) return skipContainer(buf, i, end);
  if (c === 0x74) return skipLiteral(buf, i, end, 'true');
  if (c === 0x66) return skipLiteral(buf, i, end, 'false');
  if (c === 0x6e) return skipLiteral(buf, i, end, 'null');
  if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return skipNumber(buf, i, end);
  return { done: false, next: i };
}

// The frame kind is the first top-level string value of "kind". Nested
// "kind" keys and kind-shaped text inside strings are not the frame.
// Returns that string, '' when the root object closed without one, or null
// when the kind is not visible yet (or the bytes are not an object).
export function topLevelKind(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const end = buf.length;
  let i = skipSpace(buf, 0, end);
  if (i >= end || buf[i] === 0x0a || buf[i] !== 0x7b) return null;
  i++;
  while (i < end) {
    i = skipSpace(buf, i, end);
    if (i >= end || buf[i] === 0x0a) return null;
    if (buf[i] === 0x7d) return '';
    const keyEnd = matchKindKey(buf, i, end);
    let isKind = false;
    if (keyEnd >= 0) {
      isKind = true;
      i = keyEnd;
    } else {
      const key = readJsonString(buf, i, end, true);
      if (!key.done) return null;
      isKind = !key.overflow && key.value === 'kind';
      i = key.next;
    }
    i = skipSpace(buf, i, end);
    if (i >= end || buf[i] !== 0x3a) return null;
    i = skipSpace(buf, i + 1, end);
    if (i >= end || buf[i] === 0x0a) return null;
    if (isKind && buf[i] === 0x22) {
      const known = matchKindValue(buf, i, end);
      if (known) return known.value;
      const val = readJsonString(buf, i, end, true);
      if (!val.done) return null;
      if (val.overflow || val.value == null) return 'data';
      return val.value;
    }
    const skipped = skipJsonValue(buf, i, end);
    if (!skipped.done) return null;
    i = skipSpace(buf, skipped.next, end);
    if (i >= end || buf[i] === 0x0a) return null;
    if (buf[i] === 0x7d) return '';
    if (buf[i] !== 0x2c) return null;
    i++;
  }
  return null;
}

export function classifyStdoutLine(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const nl = buf.indexOf(0x0a);
  const complete = nl >= 0;
  const length = complete ? nl + 1 : buf.length;
  const kind = topLevelKind(complete ? buf.subarray(0, nl) : buf);
  return {
    kind,
    complete,
    control: isStdoutControlKind(kind),
    length,
  };
}

// Complete data spends. An open line spends once its top-level kind is a
// data kind, or once the prefix is too long to still be a control ack.
export function stdoutLineSpends(bytes) {
  const info = classifyStdoutLine(bytes);
  if (info.control) return false;
  if (info.complete || info.kind != null) return true;
  return info.length > STDOUT_KIND_PREFIX;
}

// =============================
// (2) Length-prefixed mux frames
// =============================

export class MuxFramingError extends Error {}
export class MuxOversizeError extends MuxFramingError {}
export class MuxNeverTerminatedError extends MuxFramingError {}
export class MuxUnterminatedAtEofError extends MuxFramingError {}

export class MuxFramer {
  #bytes = new ByteBuf();
  #complete = 0;

  feed(chunk) {
    this.#bytes.append(asBuffer(chunk));
    this.#rejectLeadingOversize();
    this.#accountComplete();
  }

  // A length prefix at the start of the buffer is visible before frames() runs.
  #rejectLeadingOversize() {
    if (this.#bytes.length < 4 || this.#complete !== 0) return;
    const len = this.#bytes.readUInt32BE(0);
    if (len > MAX_FRAME_SIZE) {
      throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
    }
  }

  // Advance past frames that are fully buffered. An oversize length after
  // those frames is left for frames() so the earlier frames can still be read.
  #accountComplete() {
    while (this.#bytes.length - this.#complete >= 4) {
      const len = this.#bytes.readUInt32BE(this.#complete);
      if (len > MAX_FRAME_SIZE) return;
      if (this.#bytes.length - this.#complete < 4 + len) return;
      this.#complete += 4 + len;
    }
  }

  *frames() {
    while (this.#bytes.length >= 4) {
      const len = this.#bytes.readUInt32BE(0);
      if (len > MAX_FRAME_SIZE) {
        throw new MuxOversizeError(`frame length ${len} > ${MAX_FRAME_SIZE}`);
      }
      if (this.#bytes.length < 4 + len) break;
      const payload = this.#bytes.subarray(4, 4 + len);
      let payloadStr;
      try {
        payloadStr = decodeUtf8(payload);
      } catch (e) {
        this.#bytes.drop(4 + len);
        this.#complete -= 4 + len;
        throw new MuxFramingError(`invalid utf-8: ${e.message}`);
      }
      this.#bytes.drop(4 + len);
      this.#complete -= 4 + len;
      try {
        yield JSON.parse(payloadStr);
      } catch (e) {
        throw new MuxFramingError(`malformed JSON: ${e.message}`);
      }
    }
  }

  eof() {
    if (this.#bytes.length > 0) {
      throw new MuxUnterminatedAtEofError(`unterminated frame at EOF: ${this.#bytes.length} bytes`);
    }
  }

  pendingBytes() {
    return this.#bytes.length;
  }

  // Bytes of the unfinished frame at the head, including its length prefix.
  // Zero until the prefix is buffered, and zero when that prefix is illegal.
  // A legal length can still be larger than the process will ever accept.
  leadingDeclared() {
    const available = this.#bytes.length - this.#complete;
    if (available < 4) return 0;
    const len = this.#bytes.readUInt32BE(this.#complete);
    if (len > MAX_FRAME_SIZE) return 0;
    return 4 + len;
  }
}

export function encodeMux(obj) {
  const payload = JSON.stringify(obj);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_FRAME_SIZE) {
    throw new MuxOversizeError(`payload ${payloadBytes} bytes > ${MAX_FRAME_SIZE}`);
  }
  const buf = Buffer.from(payload, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
